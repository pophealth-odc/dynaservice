'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yazl = require('yazl');
const { err } = require('../errors');
const logger = require('../utils/logger');
const { Mutex } = require('../utils/async-utils');
const { nowIso, timestampForFilename } = require('../utils/date-utils');
const { sanitizeFilePart, safeJoin, atomicWrite, atomicWriteJson, readJsonSafe, removeIfExists, UUID_RE } = require('../utils/file-utils');

const EXTENSION = { png: 'png', jpeg: 'jpg' };
const MIME = { png: 'image/png', jpeg: 'image/jpeg' };
const MAX_EXPORT_IDS = 200;

/**
 * Stores captured screenshots in the temporary directory with a JSON metadata sidecar and an in-memory
 * index. Nothing here is durable: the dashboard is expected to download what it wants to keep.
 */
class ScreenshotService {
  constructor({ env, browser, events, settings }) {
    this.env = env;
    this.browser = browser;
    this.events = events;
    this.settings = settings;
    this.dir = env.screenshotDir;
    this.index = new Map();
    this.writeLock = new Mutex();
    this.recoveredFromDisk = 0;
  }

  /** Re-index files left by an earlier process that shared this filesystem (reported as recovered). */
  async init() {
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith('.meta.json'))) {
      const meta = await readJsonSafe(path.join(this.dir, name));
      if (!meta || !UUID_RE.test(meta.id || '') || typeof meta.filename !== 'string') continue;
      try {
        const stat = await fsp.stat(safeJoin(this.dir, meta.filename));
        this.index.set(meta.id, { ...meta, sizeBytes: stat.size, recovered: true });
        this.recoveredFromDisk += 1;
      } catch {
        await removeIfExists(path.join(this.dir, name)).catch(() => {});
      }
    }
    if (this.recoveredFromDisk) logger.info('Recovered screenshots from a previous process', { count: this.recoveredFromDisk });
  }

  // ---------------------------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------------------------

  async _uniqueFilename(base, ext) {
    let candidate = `${base}.${ext}`;
    let n = 1;
    while (n < 100) {
      const taken = [...this.index.values()].some((m) => m.filename === candidate);
      if (!taken) {
        try {
          await fsp.access(safeJoin(this.dir, candidate));
        } catch {
          return candidate;
        }
      }
      n += 1;
      candidate = `${base}_${n}.${ext}`;
    }
    return `${base}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  }

  /**
   * Capture the current page.
   * @param ctx { workflowId, workflowName, runId, stepId, stepNumber, stepName, label, format, type, fullPage }
   */
  async capture(ctx = {}) {
    this.events.emitEvent('screenshot.capturing', 'Capturing screenshot.', {
      data: { stepName: ctx.stepName ?? null, stepNumber: ctx.stepNumber ?? null },
    });
    const type = ctx.fullPage === true ? 'fullPage' : ctx.fullPage === false ? 'viewport' : ctx.type;
    let shot;
    try {
      shot = await this.browser.screenshotBuffer({ format: ctx.format, type });
    } catch (e) {
      logger.warn('Screenshot capture failed', { code: e.code, error: e });
      throw e;
    }
    let title = null;
    try {
      title = await Promise.race([this.browser.page?.title(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    } catch {
      title = null;
    }
    return this.writeLock.runExclusive(() => this._persist(shot, { ...ctx, pageTitle: title }));
  }

  async _persist(shot, ctx) {
    const ext = EXTENSION[shot.format] || 'png';
    const stamp = timestampForFilename();
    const first = ctx.workflowName || 'Manual';
    const second = ctx.stepName || ctx.label || ctx.pageTitle || 'Page';
    const base = `${sanitizeFilePart(first, 'Manual', 30)}_${sanitizeFilePart(second, 'Page', 30)}_${stamp}`;

    if (shot.buffer.length > this.env.maxScreenshotBytes) {
      throw err.unprocessable('screenshot_too_large', 'The screenshot is larger than the configured storage budget.', {
        details: { sizeBytes: shot.buffer.length, maxBytes: this.env.maxScreenshotBytes },
        hint: 'Use a smaller viewport, a viewport screenshot, or JPEG.',
      });
    }
    await this._makeRoom(shot.buffer.length);

    const filename = await this._uniqueFilename(base, ext);
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(shot.buffer).digest('hex');
    const meta = {
      id,
      filename,
      sourceUrl: shot.url,
      pageTitle: ctx.pageTitle ?? null,
      workflowId: ctx.workflowId ?? null,
      workflowName: ctx.workflowName ?? null,
      runId: ctx.runId ?? null,
      stepId: ctx.stepId ?? null,
      stepNumber: ctx.stepNumber ?? null,
      stepName: ctx.stepName ?? null,
      capturedAt: nowIso(),
      format: shot.format,
      mimeType: MIME[shot.format],
      type: shot.type,
      width: shot.viewport?.width ?? null,
      height: shot.viewport?.height ?? null,
      sizeBytes: shot.buffer.length,
      sha256,
      transferred: false,
      transferredAt: null,
      downloadCount: 0,
    };

    try {
      await atomicWrite(safeJoin(this.dir, filename), shot.buffer);
      await atomicWriteJson(path.join(this.dir, `${id}.meta.json`), meta);
    } catch (e) {
      await removeIfExists(safeJoin(this.dir, filename)).catch(() => {});
      logger.error('Could not write screenshot', { error: e });
      throw err.internal('screenshot_write_failed', 'The screenshot could not be written to temporary storage.', {
        details: { reason: e.code || e.message },
        hint: e.code === 'ENOSPC' ? 'The temporary disk is full. Delete screenshots or export them first.' : undefined,
      });
    }
    this.index.set(id, meta);
    this.events.emitEvent('screenshot.saved', `Screenshot saved as ${filename}.`, { data: { screenshot: this.publicMeta(meta) } });
    return this.publicMeta(meta);
  }

  /** Evict the oldest screenshots (already-transferred ones first) so the count and byte budgets hold. */
  async _makeRoom(incomingBytes) {
    const totalBytes = () => [...this.index.values()].reduce((s, m) => s + (m.sizeBytes || 0), 0);
    const overBudget = () => this.index.size + 1 > this.env.maxScreenshots || totalBytes() + incomingBytes > this.env.maxScreenshotBytes;
    const evicted = [];
    while (overBudget() && this.index.size > 0) {
      const all = [...this.index.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      const victim = all.find((m) => m.transferred) || all[0];
      await this._remove(victim);
      evicted.push(this.publicMeta(victim));
    }
    if (evicted.length) {
      logger.warn('Evicted old screenshots to stay within the storage budget', { count: evicted.length });
      this.events.emitEvent('screenshot.evicted', `${evicted.length} older screenshot(s) were removed to free temporary storage. Download screenshots promptly.`, {
        data: { evicted: evicted.map((m) => ({ id: m.id, filename: m.filename, transferred: m.transferred })) },
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------------------------

  publicMeta(meta) {
    const { recovered, ...rest } = meta;
    return {
      ...rest,
      recoveredFromPreviousProcess: Boolean(recovered),
      links: { self: `/api/screenshots/${meta.id}`, image: `/api/screenshots/${meta.id}?view=image`, download: `/api/screenshots/${meta.id}/download` },
    };
  }

  /** Drop index entries whose file has disappeared; returns what was lost. */
  async reconcile() {
    const lost = [];
    for (const meta of [...this.index.values()]) {
      try {
        await fsp.access(safeJoin(this.dir, meta.filename));
      } catch {
        lost.push({ id: meta.id, filename: meta.filename });
        this.index.delete(meta.id);
        await removeIfExists(path.join(this.dir, `${meta.id}.meta.json`)).catch(() => {});
      }
    }
    if (lost.length) logger.warn('Screenshot files went missing from temporary storage', { count: lost.length });
    return lost;
  }

  async list({ workflowId, runId, limit = 500 } = {}) {
    const lost = await this.reconcile();
    let items = [...this.index.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    if (workflowId) items = items.filter((m) => m.workflowId === workflowId);
    if (runId) items = items.filter((m) => m.runId === runId);
    const total = items.length;
    const totalBytes = items.reduce((s, m) => s + (m.sizeBytes || 0), 0);
    return {
      items: items.slice(0, limit).map((m) => this.publicMeta(m)),
      total,
      totalBytes,
      lost,
      storage: { temporary: true, maxScreenshots: this.env.maxScreenshots, maxBytes: this.env.maxScreenshotBytes },
    };
  }

  _entry(id) {
    if (!UUID_RE.test(String(id))) throw err.badRequest('invalid_id', 'Screenshot id must be a UUID.');
    const meta = this.index.get(id);
    if (!meta) {
      throw err.notFound('screenshot_not_found', 'No screenshot with that id exists. Temporary screenshots are lost when the service restarts or sleeps.');
    }
    return meta;
  }

  /** Metadata for one screenshot, verifying its file is still present. */
  async get(id) {
    const meta = this._entry(id);
    const file = await this.filePath(meta);
    return { meta: this.publicMeta(meta), file };
  }

  async filePath(meta) {
    const file = safeJoin(this.dir, meta.filename);
    try {
      await fsp.access(file);
    } catch {
      this.index.delete(meta.id);
      await removeIfExists(path.join(this.dir, `${meta.id}.meta.json`)).catch(() => {});
      throw err.gone('screenshot_file_missing', 'The screenshot file is no longer in temporary storage.', {
        hint: 'The container filesystem was reset or the file was evicted. Capture it again.',
      });
    }
    return file;
  }

  findByRunStep(runId, stepId) {
    return [...this.index.values()].find((m) => m.runId === runId && m.stepId === stepId) || null;
  }

  // ---------------------------------------------------------------------------------------------
  // Transfer
  // ---------------------------------------------------------------------------------------------

  /**
   * Stream the file to the HTTP response. A download counts as "transferred" only when the whole body
   * (a 200 response, or a Range response ending at the last byte) was written. Range requests are
   * supported so an interrupted transfer can resume instead of starting over.
   */
  async sendFile(id, req, res, { inline = false } = {}) {
    const meta = this._entry(id);
    const file = await this.filePath(meta);
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="${meta.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
    res.set({
      'Content-Type': meta.mimeType,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
      ETag: `"${meta.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Screenshot-Id': meta.id,
      'X-Screenshot-Sha256': meta.sha256,
      'Accept-Ranges': 'bytes',
    });
    await new Promise((resolve) => {
      res.sendFile(file, { etag: false, lastModified: false, cacheControl: false, headers: {} }, (error) => {
        if (error && !res.headersSent) {
          const code = error.code === 'ENOENT' ? 410 : 500;
          this.index.delete(meta.id);
          res.status(code).json({
            error: { code: code === 410 ? 'screenshot_file_missing' : 'screenshot_send_failed', message: 'The screenshot could not be sent.', status: code },
          });
        }
        resolve();
      });
      if (!inline) this._watchTransfer(meta, res);
    });
  }

  _watchTransfer(meta, res) {
    res.once('finish', () => {
      const range = String(res.getHeader('Content-Range') || '');
      const rangeEnd = /bytes \d+-(\d+)\/(\d+)/.exec(range);
      const complete = res.statusCode === 200 || (res.statusCode === 206 && rangeEnd && Number(rangeEnd[1]) === Number(rangeEnd[2]) - 1);
      if (!complete || !this.index.has(meta.id)) return;
      const entry = this.index.get(meta.id);
      entry.transferred = true;
      entry.transferredAt = nowIso();
      entry.downloadCount = (entry.downloadCount || 0) + 1;
      atomicWriteJson(path.join(this.dir, `${meta.id}.meta.json`), entry).catch(() => {});
      this.events.emitEvent('screenshot.transferred', `Screenshot ${entry.filename} was downloaded.`, { data: { id: meta.id, filename: entry.filename, sizeBytes: entry.sizeBytes } });
    });
    res.once('close', () => {
      if (!res.writableFinished) logger.info('Screenshot transfer was interrupted', { id: meta.id });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------------

  async _remove(meta) {
    this.index.delete(meta.id);
    await removeIfExists(safeJoin(this.dir, meta.filename)).catch(() => {});
    await removeIfExists(path.join(this.dir, `${meta.id}.meta.json`)).catch(() => {});
  }

  async delete(id) {
    const meta = this._entry(id);
    await this._remove(meta);
    return { id, filename: meta.filename, deleted: true };
  }

  async deleteAll({ transferredOnly = false } = {}) {
    let deleted = 0;
    for (const meta of [...this.index.values()]) {
      if (transferredOnly && !meta.transferred) continue;
      await this._remove(meta);
      deleted += 1;
    }
    return { deleted, remaining: this.index.size };
  }

  // ---------------------------------------------------------------------------------------------
  // ZIP export
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolve which screenshots to export, verifying their files exist.
   * @returns {{ entries: Array<{meta, file}>, missing: string[] }}
   */
  async prepareExport(ids) {
    let metas;
    if (ids && ids.length) {
      if (ids.length > MAX_EXPORT_IDS) throw err.badRequest('too_many_ids', `At most ${MAX_EXPORT_IDS} screenshots can be exported at once.`);
      const bad = ids.find((id) => !UUID_RE.test(String(id)));
      if (bad !== undefined) throw err.badRequest('invalid_id', 'Every screenshot id must be a UUID.');
      metas = ids.map((id) => this.index.get(id)).filter(Boolean);
    } else {
      metas = [...this.index.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    }
    const entries = [];
    const missing = ids?.length ? ids.filter((id) => !this.index.has(id)) : [];
    for (const meta of metas) {
      try {
        entries.push({ meta, file: await this.filePath(meta) });
      } catch {
        missing.push(meta.id);
      }
    }
    if (!entries.length) {
      throw err.notFound('no_screenshots', 'There are no screenshots to export.', {
        details: missing.length ? { missing } : undefined,
        hint: 'Temporary screenshots are lost when the service restarts or sleeps.',
      });
    }
    return { entries, missing };
  }

  /** Stream a ZIP archive of the selected screenshots (plus manifest.json) into `res`. */
  async exportZip(ids, res) {
    const { entries, missing } = await this.prepareExport(ids);
    const zip = new yazl.ZipFile();
    const used = new Set();
    const manifest = {
      exportedAt: nowIso(),
      note: 'Temporary screenshots exported from the Cloud Screenshot Service. Store this archive yourself; the service does not keep screenshots permanently.',
      count: entries.length,
      missing,
      screenshots: [],
    };
    for (const { meta, file } of entries) {
      let name = meta.filename;
      for (let n = 2; used.has(name); n += 1) name = meta.filename.replace(/(\.[^.]+)$/, `_${n}$1`);
      used.add(name);
      zip.addFile(file, name, { compress: false });
      const { links, recoveredFromPreviousProcess, ...fields } = this.publicMeta(meta);
      manifest.screenshots.push({ ...fields, archiveName: name });
    }
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    zip.end();

    const filename = `screenshots_${timestampForFilename()}.zip`;
    res.status(200).set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Count': String(entries.length),
    });

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      zip.outputStream.on('error', (error) => {
        logger.error('ZIP export failed', { error });
        // Headers are already sent; the only honest signal left is an aborted connection.
        res.destroy(error);
        done();
      });
      res.on('close', () => {
        zip.outputStream.unpipe(res);
        zip.outputStream.destroy();
        done();
      });
      res.on('finish', done);
      zip.outputStream.pipe(res);
    });
    return { count: entries.length, missing };
  }

  stats() {
    const metas = [...this.index.values()];
    return {
      count: metas.length,
      totalBytes: metas.reduce((s, m) => s + (m.sizeBytes || 0), 0),
      transferred: metas.filter((m) => m.transferred).length,
      recoveredFromPreviousProcess: this.recoveredFromDisk,
    };
  }
}

module.exports = { ScreenshotService, MIME, EXTENSION };
