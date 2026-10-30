'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { unzipSync } = require('fflate');
const { startApp, TOKEN, waitFor, sleep } = require('../helpers/harness');
const { createFakeLauncher } = require('../helpers/fake-browser');

const fake = () => ({ browser: { launcher: createFakeLauncher(), memoryProbe: () => ({ availableMB: 1000, limitMB: 2000 }) } });
let app;
test.before(async () => {
  app = await startApp({ container: fake() });
  await app.request('POST', '/api/browser/launch', { body: {} });
});
test.after(async () => app.close());

const ok = (res, status = 200) => {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  return res.json.data;
};
const fail = (res, status, code) => {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  if (code) assert.equal(res.json.error.code, code);
  return res.json.error;
};
const clickStep = (name, selector = '#a', extra = {}) => ({ name, action: 'click', target: { strategy: 'css', selector }, ...extra });

// ---- workflows ------------------------------------------------------------------------------------------

test('workflow CRUD through the API', async () => {
  const created = ok(await app.request('POST', '/api/workflows', { body: { name: 'Dynatrace Dashboard Navigation', description: 'Problems then Services', steps: [
    { name: 'Open Problems', action: 'click', target: { strategy: 'role', role: 'link', name: 'Problems' }, wait: { condition: 'page_ready' }, screenshot: true },
    { name: 'Open Services', action: 'click', target: { strategy: 'role', role: 'link', name: 'Services' }, wait: { condition: 'page_ready' }, screenshot: true },
  ] } }), 201);
  const wf = created.workflow;
  for (const key of ['id', 'name', 'description', 'createdAt', 'updatedAt', 'enabled', 'steps']) assert.ok(key in wf, key);
  for (const key of ['id', 'number', 'name', 'action', 'target', 'wait', 'timeout' in wf.steps[0] ? 'timeout' : 'enabled', 'screenshot', 'enabled']) assert.ok(key in wf.steps[0], key);
  assert.deepEqual(wf.steps.map((s) => s.number), [1, 2]);

  assert.equal(ok(await app.request('GET', `/api/workflows/${wf.id}`)).workflow.name, wf.name);
  assert.ok(ok(await app.request('GET', '/api/workflows')).workflows.some((w) => w.id === wf.id));

  const renamed = ok(await app.request('PUT', `/api/workflows/${wf.id}`, { body: { name: 'Renamed' } }));
  assert.equal(renamed.workflow.name, 'Renamed');
  assert.equal(renamed.workflow.steps.length, 2);

  const steps = renamed.workflow.steps.map((s, i) => (i === 0 ? { ...s, enabled: false } : s));
  const toggled = ok(await app.request('PUT', `/api/workflows/${wf.id}`, { body: { steps } }));
  assert.equal(toggled.workflow.steps[0].enabled, false);

  ok(await app.request('DELETE', `/api/workflows/${wf.id}`));
  fail(await app.request('GET', `/api/workflows/${wf.id}`), 404, 'workflow_not_found');
  fail(await app.request('DELETE', `/api/workflows/${wf.id}`), 404, 'workflow_not_found');
});

test('workflow validation errors list each problem with its path', async () => {
  // Structural problems (unknown action) are caught by the request schema; semantic ones (a click with no target,
  // a forbidden selector) by the workflow service. Both answer 422 with a list of {path, message}.
  const structural = fail(await app.request('POST', '/api/workflows', { body: { name: 'Bad', steps: [{ name: 'y', action: 'explode' }] } }), 422, 'invalid_request');
  assert.ok(structural.details.problems.some((p) => p.path.includes('steps') && /one of/.test(p.message)), JSON.stringify(structural.details));
  const semantic = fail(await app.request('POST', '/api/workflows', { body: { name: 'Bad', steps: [{ name: 'x', action: 'click' }] } }), 422, 'invalid_workflow');
  assert.ok(semantic.details.problems.some((p) => p.path === 'steps[0].target' && /needs a target/.test(p.message)), JSON.stringify(semantic.details));
  fail(await app.request('POST', '/api/workflows', { body: { steps: [] } }), 422);
  fail(await app.request('POST', '/api/workflows', { body: { name: 'x', steps: [{ name: 'a', action: 'click', target: { strategy: 'css', selector: 'a >> text=b' } }] } }), 422, 'invalid_workflow');
  fail(await app.request('PUT', `/api/workflows/${crypto.randomUUID()}`, { body: { name: 'x' } }), 404);
});

test('reorder, duplicate and add-step endpoints', async () => {
  const wf = ok(await app.request('POST', '/api/workflows', { body: { name: 'Ops', steps: [clickStep('a'), clickStep('b', '#b'), clickStep('c', '#c')] } }), 201).workflow;
  const [a, b, c] = wf.steps.map((s) => s.id);
  const re = ok(await app.request('POST', `/api/workflows/${wf.id}/reorder`, { body: { order: [c, b, a] } }));
  assert.deepEqual(re.workflow.steps.map((s) => s.name), ['c', 'b', 'a']);
  fail(await app.request('POST', `/api/workflows/${wf.id}/reorder`, { body: { order: [a, b] } }), 422, 'invalid_order');

  const dup = ok(await app.request('POST', `/api/workflows/${wf.id}/duplicate`, { body: {} }), 201);
  assert.equal(dup.workflow.name, 'Ops (copy)');

  const added = ok(await app.request('POST', `/api/workflows/${wf.id}/steps`, { body: { step: clickStep('inserted', '#i'), index: 1 } }), 201);
  assert.equal(added.addedStep.name, 'inserted');
  assert.equal(added.workflow.steps[1].name, 'inserted');
  fail(await app.request('POST', `/api/workflows/${wf.id}/steps`, { body: {} }), 422);
  fail(await app.request('POST', `/api/workflows/${wf.id}/steps`, { body: { fromSelection: true } }), 404, 'no_selection');
  fail(await app.request('POST', `/api/workflows/${wf.id}/steps`, { body: { step: clickStep('x'), fromSelection: true } }), 422);
});

test('export returns a portable document and import round-trips it', async () => {
  const wf = ok(await app.request('POST', '/api/workflows', { body: { name: 'Portable', steps: [clickStep('one'), clickStep('two', '#two', { screenshot: true })] } }), 201).workflow;
  const res = await app.request('GET', `/api/workflows/${wf.id}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Portable\.workflow\.json"/);
  assert.equal(res.json.format, 'cloud-screenshot-service/workflow');
  assert.equal(res.json.workflow.name, 'Portable');
  assert.ok(!('ok' in res.json), 'the export is the bare document, ready to save and re-import');
  const imported = ok(await app.request('POST', '/api/workflows/import', { body: res.json }), 201);
  assert.notEqual(imported.workflow.id, wf.id);
  assert.equal(imported.workflow.steps[1].screenshot, true);
  assert.equal(imported.renamed, true);
  // A clashing name is renamed by default, and refused when the caller asks for onConflict=reject.
  const clash = await app.request('POST', '/api/workflows/import?onConflict=reject', { body: res.json });
  fail(clash, 409, 'workflow_name_taken');
});

test('import rejects malformed and hostile documents without storing anything', async () => {
  const before = ok(await app.request('GET', '/api/workflows')).workflows.length;
  for (const body of [
    { format: 'other/thing', workflow: { name: 'x' } },
    { name: 'x', steps: [{ name: 'a', action: 'run_script', script: 'rm -rf /' }] },
    { name: 'x', steps: [{ name: 'a', action: 'click', target: { strategy: 'css', selector: 'js=alert(1)' } }] },
    { name: 'x', schemaVersion: 42 },
    { name: 'x', steps: new Array(150).fill(clickStep('a')) },
    {},
  ]) {
    const res = await app.request('POST', '/api/workflows/import', { body });
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 80));
  }
  fail(await app.request('POST', '/api/workflows/import', { body: '[1,2,3]' }), 422);
  assert.equal(ok(await app.request('GET', '/api/workflows')).workflows.length, before);
});

// ---- screenshots ----------------------------------------------------------------------------------------

test('capture -> list -> metadata -> preview -> download -> delete', async () => {
  await app.request('DELETE', '/api/screenshots');
  const shot = ok(await app.request('POST', '/api/screenshots', { body: { label: 'My Page' } }), 201).screenshot;
  for (const key of ['id', 'filename', 'sourceUrl', 'pageTitle', 'capturedAt', 'format', 'sha256', 'sizeBytes']) assert.ok(shot[key] !== undefined, key);
  assert.match(shot.filename, /^Manual_My_Page_\d{4}-\d{2}-\d{2}_\d{6}\.png$/);

  const list = ok(await app.request('GET', '/api/screenshots'));
  assert.equal(list.total, 1);
  assert.equal(list.storage.temporary, true);

  assert.equal(ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot.id, shot.id);

  const inline = await app.request('GET', `/api/screenshots/${shot.id}?view=image`, { raw: true });
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  await inline.arrayBuffer();
  assert.equal(ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot.transferred, false, 'previewing is not a transfer');

  const dl = await app.request('GET', `/api/screenshots/${shot.id}/download`, { raw: true });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="Manual_My_Page_/);
  assert.equal(dl.headers.get('x-screenshot-sha256'), shot.sha256);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.length, shot.sizeBytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), shot.sha256, 'downloaded bytes match the recorded checksum');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');

  await waitFor(async () => ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot.transferred, { what: 'transferred flag' });
  const after = ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot;
  assert.equal(after.downloadCount, 1);
  assert.ok(after.transferredAt);

  ok(await app.request('DELETE', `/api/screenshots/${shot.id}`));
  fail(await app.request('GET', `/api/screenshots/${shot.id}`), 404, 'screenshot_not_found');
  fail(await app.request('GET', `/api/screenshots/${shot.id}/download`), 404, 'screenshot_not_found');
});

test('a screenshot transfer can be resumed with a Range request, and only a complete body counts as transferred', async () => {
  await app.request('DELETE', '/api/screenshots');
  const shot = ok(await app.request('POST', '/api/screenshots', { body: {} }), 201).screenshot;
  const url = `${app.base}/api/screenshots/${shot.id}/download`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  const head = await fetch(url, { headers: { ...auth, Range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-9/${shot.sizeBytes}`);
  const part1 = Buffer.from(await head.arrayBuffer());
  assert.equal(part1.length, 10);
  await sleep(40);
  assert.equal(ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot.transferred, false, 'a partial transfer is not counted');

  const rest = await fetch(url, { headers: { ...auth, Range: `bytes=10-${shot.sizeBytes - 1}` } });
  assert.equal(rest.status, 206);
  const whole = Buffer.concat([part1, Buffer.from(await rest.arrayBuffer())]);
  assert.equal(crypto.createHash('sha256').update(whole).digest('hex'), shot.sha256, 'the two halves reassemble to the original');
  await waitFor(async () => ok(await app.request('GET', `/api/screenshots/${shot.id}`)).screenshot.transferred, { what: 'transferred after final range' });
});

test('an interrupted download (client drops mid-stream) is not marked as transferred', async () => {
  await app.request('DELETE', '/api/screenshots');
  const big = await startApp({ container: fake() });
  try {
    await big.request('POST', '/api/browser/launch', { body: {} });
    const shot = ok(await big.request('POST', '/api/screenshots', { body: {} }), 201).screenshot;
    // Pad the stored file so the response spans several TCP segments, then abort after the headers arrive.
    const file = path.join(big.dir, 'screenshots', shot.filename);
    fs.appendFileSync(file, Buffer.alloc(8 * 1024 * 1024, 7));
    await new Promise((resolve, reject) => {
      const sock = net.connect(big.port, '127.0.0.1', () => {
        sock.write(`GET /api/screenshots/${shot.id}/download HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
      });
      let got = 0;
      sock.on('data', (d) => { got += d.length; if (got > 4096) { sock.destroy(); resolve(); } });
      sock.on('error', reject);
    });
    await sleep(200);
    assert.equal(big.services.screenshots.index.get(shot.id).transferred, false);
    assert.equal(ok(await big.request('GET', '/api/status')).status, 'ok', 'the service is unaffected');
  } finally {
    await big.close();
  }
});

test('screenshot ids cannot be used to reach other files', async () => {
  for (const id of ['../../../etc/passwd', '..%2f..%2fetc%2fpasswd', '%00', 'package.json', '....//....//x']) {
    for (const suffix of ['', '/download', '?view=image']) {
      const res = await app.request('GET', `/api/screenshots/${id}${suffix}`);
      assert.ok([400, 404].includes(res.status), `${id}${suffix} -> ${res.status}`);
      assert.ok(!res.text.includes('root:'), 'no file contents leaked');
    }
  }
});

test('a missing file is reported as 410 with an explanation, and disappears from the list', async () => {
  await app.request('DELETE', '/api/screenshots');
  const shot = ok(await app.request('POST', '/api/screenshots', { body: {} }), 201).screenshot;
  fs.unlinkSync(path.join(app.dir, 'screenshots', shot.filename));
  const error = fail(await app.request('GET', `/api/screenshots/${shot.id}/download`), 410, 'screenshot_file_missing');
  assert.ok(error.hint);
  assert.equal(ok(await app.request('GET', '/api/screenshots')).total, 0);
});

test('ZIP export: all, selected via GET and POST, with a manifest; errors for empty and unknown', async () => {
  await app.request('DELETE', '/api/screenshots');
  fail(await app.request('GET', '/api/screenshots/export'), 404, 'no_screenshots');
  const a = ok(await app.request('POST', '/api/screenshots', { body: { label: 'one' } }), 201).screenshot;
  const b = ok(await app.request('POST', '/api/screenshots', { body: { label: 'two' } }), 201).screenshot;

  const all = await app.request('GET', '/api/screenshots/export', { raw: true });
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-type'), 'application/zip');
  assert.match(all.headers.get('content-disposition'), /^attachment; filename="screenshots_\d{4}-\d{2}-\d{2}_\d{6}\.zip"$/);
  assert.equal(all.headers.get('x-export-count'), '2');
  const files = unzipSync(new Uint8Array(await all.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), [a.filename, b.filename, 'manifest.json'].sort());
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  assert.equal(manifest.count, 2);
  assert.ok(manifest.screenshots.every((s) => s.sha256 && s.filename && s.capturedAt));
  assert.equal(crypto.createHash('sha256').update(files[a.filename]).digest('hex'), a.sha256);

  const some = await app.request('GET', `/api/screenshots/export?ids=${a.id}`, { raw: true });
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await some.arrayBuffer()))).sort(), [a.filename, 'manifest.json'].sort());
  const viaPost = await app.request('POST', '/api/screenshots/export', { body: { ids: [b.id] }, raw: true });
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await viaPost.arrayBuffer()))).sort(), [b.filename, 'manifest.json'].sort());

  fail(await app.request('GET', '/api/screenshots/export?ids=nope'), 400, 'invalid_id');
  fail(await app.request('GET', `/api/screenshots/export?ids=${crypto.randomUUID()}`), 404, 'no_screenshots');
  fail(await app.request('POST', '/api/screenshots/export', { body: { ids: [] } }), 422);
});

test('delete-all clears temporary storage, including the files on disk', async () => {
  await app.request('POST', '/api/screenshots', { body: {} });
  await app.request('POST', '/api/screenshots', { body: {} });
  const out = ok(await app.request('DELETE', '/api/screenshots'));
  assert.ok(out.deleted >= 2);
  assert.equal(out.remaining, 0);
  assert.deepEqual(fs.readdirSync(path.join(app.dir, 'screenshots')), []);
  assert.equal(ok(await app.request('GET', '/api/screenshots')).total, 0);
});

test('screenshot options: format and full-page can be chosen per capture', async () => {
  await app.request('DELETE', '/api/screenshots');
  const png = ok(await app.request('POST', '/api/screenshots', { body: { format: 'png' } }), 201).screenshot;
  const jpg = ok(await app.request('POST', '/api/screenshots', { body: { format: 'jpeg', fullPage: true } }), 201).screenshot;
  assert.equal(png.format, 'png');
  assert.equal(jpg.format, 'jpeg');
  assert.equal(jpg.type, 'fullPage');
  assert.match(jpg.filename, /\.jpg$/);
  assert.equal(jpg.mimeType, 'image/jpeg');
  fail(await app.request('POST', '/api/screenshots', { body: { format: 'bmp' } }), 422);
  await app.request('DELETE', '/api/screenshots');
});

test('the temporary-storage limit evicts old screenshots and the response says so', async () => {
  const small = await startApp({ env: { MAX_SCREENSHOTS: '2' }, container: fake() });
  try {
    await small.request('POST', '/api/browser/launch', { body: {} });
    for (let i = 0; i < 4; i += 1) ok(await small.request('POST', '/api/screenshots', { body: { label: `n${i}` } }), 201);
    const list = ok(await small.request('GET', '/api/screenshots'));
    assert.equal(list.total, 2);
    assert.equal(fs.readdirSync(path.join(small.dir, 'screenshots')).filter((n) => n.endsWith('.png')).length, 2);
    assert.equal(list.storage.maxScreenshots, 2);
  } finally {
    await small.close();
  }
});

// ---- test console + docs --------------------------------------------------------------------------------

test('the test console is served without a token but contains no secrets and loads only same-origin assets', async () => {
  const page = await app.request('GET', '/api/test', { token: null, raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.ok(!html.includes(TOKEN));
  assert.match(html, /Screenshot Service|Test Console/);
  for (const url of html.match(/(?:src|href)="[^"]+"/g)) {
    assert.ok(!/https?:\/\//.test(url) || url.includes('/api/docs'), `external asset: ${url}`);
  }
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/unsafe-inline/.test(csp.split(';').find((d) => d.trim().startsWith('script-src'))), 'no inline scripts');
  for (const asset of ['/api/test/test.css', '/api/test/test.js']) {
    const res = await app.request('GET', asset, { token: null, raw: true });
    assert.equal(res.status, 200, asset);
    assert.ok(!(await res.text()).includes(TOKEN));
  }
});

test('the test console never stores the token in the browser (static check of its source)', async () => {
  const js = (await app.request('GET', '/api/test/test.js', { token: null })).text;
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'no persistent browser storage APIs are used');
  assert.ok(!/[?&]token=/.test(js), 'the token is never put in a URL');
  assert.match(js, /Authorization: 'Bearer ' \+ token|Authorization = 'Bearer ' \+ token/);
});

test('the demo fixture site is served for the built-in end-to-end tests, and nothing else on loopback is', async () => {
  const idx = await app.request('GET', '/api/test/fixture/', { token: null, raw: true });
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await app.request('GET', '/api/test/fixture/problems', { token: null, raw: true })).status, 200, 'SPA routes fall back to the app shell');
  for (const attempt of ['/api/test/fixture/..%2f..%2fpackage.json', '/api/test/fixture/%2e%2e/%2e%2e/package.json', '/api/test/fixture/..\\..\\package.json']) {
    const res = await app.request('GET', attempt, { token: null, raw: true });
    const body = await res.text();
    assert.ok([400, 401, 403, 404].includes(res.status), `${attempt} -> ${res.status}`);
    assert.ok(!body.includes('cloud-screenshot-service') && !body.includes('"dependencies"'), `${attempt} leaked package.json`);
  }
  const policy = app.services.fixture;
  assert.equal(policy.isFixtureUrl(`${policy.baseUrl()}problems`), true);
  for (const url of [`http://127.0.0.1:${app.port}/api/status`, `http://127.0.0.1:${app.port}/api/test/fixture/../status`, `http://127.0.0.1:${app.port + 1}/api/test/fixture/`, `http://localhost:${app.port}/api/test/fixture/`, `https://127.0.0.1:${app.port}/api/test/fixture/`]) {
    assert.equal(policy.isFixtureUrl(url), false, url);
  }
});

test('Swagger UI is served and the OpenAPI document describes the API', async () => {
  const docs = await app.request('GET', '/api/docs/', { token: null, raw: true });
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /swagger-ui/);
  const spec = (await app.request('GET', '/api/docs/openapi.json', { token: null })).json;
  assert.match(spec.openapi, /^3\./);
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.ok(Object.keys(spec.paths).length >= 40);
});
