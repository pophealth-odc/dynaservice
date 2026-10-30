'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir, readJsonSafe, atomicWriteJson, isWritable } = require('../utils/file-utils');
const { nowIso } = require('../utils/date-utils');
const { Mutex } = require('../utils/async-utils');
const logger = require('../utils/logger');

const STALE_TMP_MS = 10 * 60 * 1000;
const ACTIVE_RUN_STATES = new Set(['running', 'pausing', 'paused', 'stopping']);

/**
 * Owns the temporary directory layout and the "previous process" bookkeeping.
 *
 *   <dataDir>/screenshots/   captured images plus <id>.meta.json sidecars
 *   <dataDir>/workflows/     <id>.json workflow documents
 *   <dataDir>/runtime/       instance.json, active-run.json, settings.json
 *
 * Everything here is temporary. Render Free gives the container an ephemeral filesystem, so the
 * service reports honestly what it found from an earlier process instead of promising persistence.
 */
class StorageService {
  constructor(env, { restartId }) {
    this.env = env;
    this.restartId = restartId;
    this.paths = {
      base: env.dataDir,
      screenshots: env.screenshotDir,
      workflows: env.workflowDir,
      runtime: env.runtimeDir,
    };
    this.instanceFile = path.join(env.runtimeDir, 'instance.json');
    this.activeRunFile = path.join(env.runtimeDir, 'active-run.json');
    this.previous = { detected: false, instance: null, interruptedRun: null };
    this.ready = false;
    this._activeRunQueue = new Mutex();
  }

  /** Create directories, inspect what an earlier process left behind, then claim the runtime marker. */
  async init() {
    for (const dir of Object.values(this.paths)) await ensureDir(dir);

    const previousInstance = await readJsonSafe(this.instanceFile);
    const previousRun = await readJsonSafe(this.activeRunFile);
    this.previous.detected = Boolean(previousInstance);
    this.previous.instance = previousInstance;

    if (previousRun && ACTIVE_RUN_STATES.has(previousRun.status)) {
      this.previous.interruptedRun = {
        ...previousRun,
        status: 'interrupted',
        interruptedAt: nowIso(),
        previousRestartId: previousRun.restartId || previousInstance?.restartId || null,
        reason: 'The service restarted while this automation was in progress.',
      };
      await atomicWriteJson(this.activeRunFile, this.previous.interruptedRun);
    }

    await atomicWriteJson(this.instanceFile, {
      restartId: this.restartId,
      startedAt: nowIso(),
      pid: process.pid,
      renderInstanceId: this.env.render.instanceId,
    });
    await this.cleanStaleTempFiles();
    this.ready = true;
  }

  async cleanStaleTempFiles() {
    let removed = 0;
    for (const dir of [this.paths.screenshots, this.paths.workflows, this.paths.runtime]) {
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.tmp'))) {
        const file = path.join(dir, name);
        try {
          const stat = await fsp.stat(file);
          if (Date.now() - stat.mtimeMs > STALE_TMP_MS) {
            await fsp.unlink(file);
            removed += 1;
          }
        } catch {
          /* raced with another cleanup */
        }
      }
    }
    if (removed) logger.info('Removed stale temporary files', { removed });
    return removed;
  }

  /**
   * Persist the active run descriptor so an interrupted run can be recognised after a restart.
   * Writes and clears are serialised: an older write must never land after a clear, or a finished run
   * would be reported as interrupted after the next restart.
   */
  saveActiveRun(summary) {
    return this._activeRunQueue.runExclusive(async () => {
      try {
        await atomicWriteJson(this.activeRunFile, { ...summary, restartId: this.restartId, savedAt: nowIso() });
      } catch (e) {
        logger.warn('Could not persist active run state', { error: e });
      }
    });
  }

  clearActiveRun() {
    return this._activeRunQueue.runExclusive(async () => {
      try {
        await fsp.unlink(this.activeRunFile);
      } catch {
        /* nothing to clear */
      }
    });
  }

  /** Resolves once every queued active-run write or clear has finished (used by graceful shutdown). */
  flush() {
    return this._activeRunQueue.runExclusive(async () => {});
  }

  async usage() {
    const out = { screenshotFiles: 0, screenshotBytes: 0 };
    try {
      for (const name of await fsp.readdir(this.paths.screenshots)) {
        if (name.endsWith('.meta.json') || name.endsWith('.tmp')) continue;
        try {
          out.screenshotBytes += (await fsp.stat(path.join(this.paths.screenshots, name))).size;
          out.screenshotFiles += 1;
        } catch {
          /* file vanished */
        }
      }
    } catch {
      /* directory missing */
    }
    return out;
  }

  async describe() {
    return {
      temporary: true,
      persistent: false,
      note: 'Screenshots and workflows are kept in the container filesystem and may be lost on sleep, restart or redeploy. Download what you need.',
      directories: this.paths,
      writable: await isWritable(this.paths.screenshots),
      previousInstanceDetected: this.previous.detected,
      interruptedRunDetected: Boolean(this.previous.interruptedRun),
      ...(await this.usage()),
    };
  }

  newId() {
    return crypto.randomUUID();
  }
}

module.exports = { StorageService, ACTIVE_RUN_STATES };
