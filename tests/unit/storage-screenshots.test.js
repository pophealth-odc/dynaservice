'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createEnv } = require('../../src/config/settings');
const { StorageService } = require('../../src/services/storage.service');
const { ScreenshotService } = require('../../src/services/screenshot.service');
const { sanitizeFilePart, safeJoin } = require('../../src/utils/file-utils');
const { timestampForFilename } = require('../../src/utils/date-utils');

const TOKEN = 'unit-token-0123456789abcdef0123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-store-'));
  return { dir, env: createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir, ...extra }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const events = () => { const list = []; return { list, emitEvent: (type, description, extra) => { list.push({ type, description, ...extra }); return { type }; } }; };

function shotService(env, { buffer = PNG, format = 'png' } = {}) {
  const ev = events();
  const browser = {
    page: { title: async () => 'Problems' },
    screenshotBuffer: async () => ({ buffer, format, type: 'viewport', viewport: { width: 1920, height: 1080 }, url: 'https://example.com/problems' }),
  };
  return { svc: new ScreenshotService({ env, browser, events: ev, settings: {} }), ev };
}

test('sanitizeFilePart keeps filenames safe and short', () => {
  assert.equal(sanitizeFilePart('Open Problems!'), 'Open_Problems');
  assert.equal(sanitizeFilePart('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeFilePart('Ünïcödé näme'), 'Unicode_name');
  assert.equal(sanitizeFilePart('***', 'fallback'), 'fallback');
  assert.equal(sanitizeFilePart('a'.repeat(100)).length, 40);
  assert.equal(sanitizeFilePart(null, 'x'), 'x');
});

test('safeJoin refuses traversal, separators, absolute paths and NUL bytes', () => {
  const base = path.join(os.tmpdir(), 'base-dir');
  assert.equal(safeJoin(base, 'a.png'), path.join(base, 'a.png'));
  for (const bad of ['../x', '..', '.', 'a/b.png', 'a\\b.png', '/etc/passwd', 'C:\\Windows\\x', 'a\0.png', '', null, undefined, 5]) {
    assert.throws(() => safeJoin(base, bad), /Unsafe file name/, String(bad));
  }
});

test('timestampForFilename follows the Name_YYYY-MM-DD_HHMMSS convention', () => {
  assert.equal(timestampForFilename(new Date(Date.UTC(2026, 9, 30, 13, 0, 0))), '2026-10-30_130000');
});

test('storage creates the temporary directory layout', async () => {
  const { env, cleanup } = makeEnv();
  try {
    const storage = new StorageService(env, { restartId: 'r1' });
    await storage.init();
    for (const dir of [env.screenshotDir, env.workflowDir, env.runtimeDir]) assert.ok(fs.statSync(dir).isDirectory(), dir);
    const info = await storage.describe();
    assert.equal(info.temporary, true);
    assert.equal(info.persistent, false);
    assert.equal(info.writable, true);
    assert.match(info.note, /lost/);
  } finally {
    cleanup();
  }
});

test('a second process on the same filesystem detects the previous instance', async () => {
  const { env, cleanup } = makeEnv();
  try {
    const first = new StorageService(env, { restartId: 'first' });
    await first.init();
    assert.equal(first.previous.detected, false);
    const second = new StorageService(env, { restartId: 'second' });
    await second.init();
    assert.equal(second.previous.detected, true);
    assert.equal(second.previous.instance.restartId, 'first');
  } finally {
    cleanup();
  }
});

test('an active run left behind by a dead process is reported as interrupted, once', async () => {
  const { env, cleanup } = makeEnv();
  try {
    const first = new StorageService(env, { restartId: 'first' });
    await first.init();
    await first.saveActiveRun({ id: 'run-1', workflowId: 'wf-1', workflowName: 'Flow', status: 'running', currentStepIndex: 1, totalSteps: 3 });

    const second = new StorageService(env, { restartId: 'second' });
    await second.init();
    const run = second.previous.interruptedRun;
    assert.equal(run.status, 'interrupted');
    assert.equal(run.workflowName, 'Flow');
    assert.equal(run.previousRestartId, 'first');
    assert.match(run.reason, /restarted/);

    // The interruption is announced by the process that discovered it. It was rewritten as "interrupted", which is
    // not an active state, so a later restart does not announce the same old run again.
    const third = new StorageService(env, { restartId: 'third' });
    await third.init();
    assert.equal(third.previous.interruptedRun, null);
  } finally {
    cleanup();
  }
});

test('a finished run is NOT reported as interrupted (write/clear ordering)', async () => {
  const { env, cleanup } = makeEnv();
  try {
    const first = new StorageService(env, { restartId: 'first' });
    await first.init();
    // Fire a save and a clear without awaiting in between, as the automation engine does.
    const writes = [first.saveActiveRun({ id: 'r', status: 'running' }), first.saveActiveRun({ id: 'r', status: 'running', currentStepIndex: 2 }), first.clearActiveRun()];
    await Promise.all(writes);
    const second = new StorageService(env, { restartId: 'second' });
    await second.init();
    assert.equal(second.previous.interruptedRun, null);
  } finally {
    cleanup();
  }
});

test('stale temporary files are cleaned up but fresh ones are kept', async () => {
  const { env, cleanup } = makeEnv();
  try {
    const storage = new StorageService(env, { restartId: 'r' });
    await storage.init();
    const stale = path.join(env.screenshotDir, 'old.png.123.tmp');
    const fresh = path.join(env.screenshotDir, 'new.png.456.tmp');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    assert.equal(await storage.cleanStaleTempFiles(), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    cleanup();
  }
});

test('capture stores the image with complete metadata and a conventional filename', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc, ev } = shotService(env);
    const meta = await svc.capture({ workflowId: 'wf', workflowName: 'Dynatrace', runId: 'run', stepId: 'st', stepNumber: 1, stepName: 'Problems' });
    assert.match(meta.filename, /^Dynatrace_Problems_\d{4}-\d{2}-\d{2}_\d{6}\.png$/);
    for (const key of ['id', 'filename', 'sourceUrl', 'pageTitle', 'workflowName', 'stepNumber', 'stepName', 'capturedAt', 'format', 'sizeBytes', 'sha256']) assert.ok(meta[key] !== undefined && meta[key] !== null, key);
    assert.equal(meta.pageTitle, 'Problems');
    assert.equal(meta.sourceUrl, 'https://example.com/problems');
    assert.equal(meta.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
    assert.equal(meta.transferred, false);
    assert.ok(fs.existsSync(path.join(env.screenshotDir, meta.filename)));
    assert.ok(fs.existsSync(path.join(env.screenshotDir, `${meta.id}.meta.json`)));
    assert.deepEqual(ev.list.map((e) => e.type), ['screenshot.capturing', 'screenshot.saved']);
  } finally {
    cleanup();
  }
});

test('two captures in the same second never overwrite each other', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const metas = [];
    for (let i = 0; i < 4; i += 1) metas.push(await svc.capture({ workflowName: 'Same', stepName: 'Step' }));
    assert.equal(new Set(metas.map((m) => m.filename)).size, 4);
    assert.equal(fs.readdirSync(env.screenshotDir).filter((n) => n.endsWith('.png')).length, 4);
  } finally {
    cleanup();
  }
});

test('the index lists newest first and filters by workflow / run', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const a = await svc.capture({ workflowId: 'w1', runId: 'r1', stepName: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.capture({ workflowId: 'w2', runId: 'r2', stepName: 'b' });
    const all = await svc.list();
    assert.deepEqual(all.items.map((m) => m.id), [b.id, a.id]);
    assert.equal(all.total, 2);
    assert.equal((await svc.list({ workflowId: 'w1' })).items.length, 1);
    assert.equal((await svc.list({ runId: 'r2' })).items[0].id, b.id);
    assert.equal(svc.findByRunStep('r1', undefined)?.id ?? null, null, 'run+step lookup needs both');
  } finally {
    cleanup();
  }
});

test('a duplicate step capture in one run can be detected (no duplicate screenshots on resume)', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const meta = await svc.capture({ runId: 'run-1', stepId: 'step-1', stepName: 'x' });
    assert.equal(svc.findByRunStep('run-1', 'step-1').id, meta.id);
    assert.equal(svc.findByRunStep('run-1', 'step-2'), null);
    assert.equal(svc.findByRunStep('run-2', 'step-1'), null);
  } finally {
    cleanup();
  }
});

test('ids must be UUIDs and unknown ids are 404 (path traversal via id is impossible)', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    for (const bad of ['../../etc/passwd', '..%2f..', 'abc', '', '1234']) {
      await assert.rejects(svc.get(bad), (e) => e.code === 'invalid_id', bad);
      await assert.rejects(svc.delete(bad), (e) => e.code === 'invalid_id', bad);
    }
    await assert.rejects(svc.get(crypto.randomUUID()), (e) => e.code === 'screenshot_not_found' && e.status === 404);
  } finally {
    cleanup();
  }
});

test('a screenshot whose file vanished is reported as gone (410) and dropped from the index', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const meta = await svc.capture({ stepName: 'x' });
    fs.unlinkSync(path.join(env.screenshotDir, meta.filename));
    await assert.rejects(svc.get(meta.id), (e) => e.code === 'screenshot_file_missing' && e.status === 410);
    await assert.rejects(svc.get(meta.id), (e) => e.code === 'screenshot_not_found', 'then it is simply unknown');
  } finally {
    cleanup();
  }
});

test('list() reconciles files that disappeared and says which were lost', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const keep = await svc.capture({ stepName: 'keep' });
    const lose = await svc.capture({ stepName: 'lose' });
    fs.unlinkSync(path.join(env.screenshotDir, lose.filename));
    const out = await svc.list();
    assert.deepEqual(out.items.map((m) => m.id), [keep.id]);
    assert.deepEqual(out.lost.map((l) => l.id), [lose.id]);
  } finally {
    cleanup();
  }
});

test('delete and deleteAll remove files and metadata', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const a = await svc.capture({ stepName: 'a' });
    await svc.capture({ stepName: 'b' });
    await svc.delete(a.id);
    assert.equal(fs.existsSync(path.join(env.screenshotDir, a.filename)), false);
    assert.equal(fs.existsSync(path.join(env.screenshotDir, `${a.id}.meta.json`)), false);
    const out = await svc.deleteAll();
    assert.equal(out.deleted, 1);
    assert.deepEqual(fs.readdirSync(env.screenshotDir), []);
  } finally {
    cleanup();
  }
});

test('deleteAll({transferredOnly}) keeps what was never downloaded', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const a = await svc.capture({ stepName: 'a' });
    const b = await svc.capture({ stepName: 'b' });
    svc.index.get(a.id).transferred = true;
    const out = await svc.deleteAll({ transferredOnly: true });
    assert.equal(out.deleted, 1);
    assert.ok(svc.index.has(b.id));
  } finally {
    cleanup();
  }
});

test('storage budget: the oldest screenshots (transferred first) are evicted and an event says so', async () => {
  const { env, cleanup } = makeEnv({ MAX_SCREENSHOTS: '3' });
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc, ev } = shotService(env);
    const first = await svc.capture({ stepName: 'one' });
    const second = await svc.capture({ stepName: 'two' });
    const third = await svc.capture({ stepName: 'three' });
    svc.index.get(second.id).transferred = true;
    const fourth = await svc.capture({ stepName: 'four' });
    assert.equal(svc.index.size, 3);
    assert.equal(svc.index.has(second.id), false, 'the already-transferred one went first');
    assert.ok(svc.index.has(first.id) && svc.index.has(third.id) && svc.index.has(fourth.id));
    assert.ok(ev.list.some((e) => e.type === 'screenshot.evicted'));
  } finally {
    cleanup();
  }
});

test('an oversized screenshot is refused cleanly', async () => {
  const { env, cleanup } = makeEnv({ MAX_SCREENSHOT_MB: '1' });
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env, { buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
    await assert.rejects(svc.capture({}), (e) => e.code === 'screenshot_too_large' && e.status === 422);
    assert.equal(svc.index.size, 0);
  } finally {
    cleanup();
  }
});

test('screenshots left on disk by an earlier process are re-indexed and marked recovered', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const meta = await svc.capture({ stepName: 'survivor' });
    fs.writeFileSync(path.join(env.screenshotDir, 'orphan.png'), PNG); // no sidecar: ignored
    fs.writeFileSync(path.join(env.screenshotDir, `${crypto.randomUUID()}.meta.json`), JSON.stringify({ id: crypto.randomUUID(), filename: 'gone.png' }));

    const { svc: next } = shotService(env);
    await next.init();
    assert.equal(next.index.size, 1);
    const listed = (await next.list()).items[0];
    assert.equal(listed.id, meta.id);
    assert.equal(listed.recoveredFromPreviousProcess, true);
    assert.equal(next.stats().recoveredFromPreviousProcess, 1);
  } finally {
    cleanup();
  }
});

test('prepareExport validates ids, reports missing files and refuses an empty export', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    await assert.rejects(svc.prepareExport(), (e) => e.code === 'no_screenshots' && e.status === 404);
    const a = await svc.capture({ stepName: 'a' });
    const b = await svc.capture({ stepName: 'b' });
    assert.equal((await svc.prepareExport()).entries.length, 2);
    assert.equal((await svc.prepareExport([a.id])).entries.length, 1);
    const ghost = crypto.randomUUID();
    const partial = await svc.prepareExport([a.id, ghost]);
    assert.deepEqual(partial.missing, [ghost]);
    await assert.rejects(svc.prepareExport(['nope']), (e) => e.code === 'invalid_id');
    await assert.rejects(svc.prepareExport(new Array(201).fill(a.id)), (e) => e.code === 'too_many_ids');
    fs.unlinkSync(path.join(env.screenshotDir, b.filename));
    const survivors = await svc.prepareExport();
    assert.equal(survivors.entries.length, 1);
    assert.deepEqual(survivors.missing, [b.id]);
  } finally {
    cleanup();
  }
});

test('exportZip streams a valid archive with every file plus a manifest', async () => {
  const { env, cleanup } = makeEnv();
  try {
    await new StorageService(env, { restartId: 'r' }).init();
    const { svc } = shotService(env);
    const a = await svc.capture({ workflowName: 'W', stepName: 'one' });
    await svc.capture({ workflowName: 'W', stepName: 'two' });

    const res = new EventEmitter();
    const chunks = [];
    res.headers = {};
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (h) => { Object.assign(res.headers, h); return res; };
    res.write = (c) => { chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); res.emit('finish'); };
    res.destroy = () => res.emit('close');
    res.once = res.on;
    res.removeListener = () => res;
    res.on('pipe', () => {});
    // Writable-like object accepted by stream.pipe
    const { Writable } = require('node:stream');
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); }, final(cb) { cb(); } });
    sink.status = res.status; sink.set = res.set; sink.headers = res.headers;
    const finished = new Promise((r) => sink.on('finish', r));
    await svc.exportZip(undefined, sink);
    await finished;

    const { unzipSync } = require('fflate');
    const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    const names = Object.keys(files);
    assert.equal(names.length, 3);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes(a.filename));
    assert.deepEqual(Buffer.from(files[a.filename]), PNG, 'image bytes are intact');
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
    assert.equal(manifest.count, 2);
    assert.match(manifest.note, /does not keep screenshots permanently/);
    assert.match(sink.headers['Content-Type'], /zip/);
    assert.match(sink.headers['Content-Disposition'], /screenshots_\d{4}-\d{2}-\d{2}_\d{6}\.zip/);
  } finally {
    cleanup();
  }
});
