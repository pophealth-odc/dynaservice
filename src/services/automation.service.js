'use strict';

const crypto = require('node:crypto');
const { err } = require('../errors');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/date-utils');
const { AbortError } = require('../utils/async-utils');
const { toAppError } = require('../utils/playwright-errors');
const { sanitizeUrl } = require('../utils/url-utils');
const { validateWorkflowInput } = require('./workflow.service');

/** Statuses while the execution loop (or a single step) is actually driving the browser. */
const DRIVING = new Set(['running', 'pausing', 'stopping']);
/** Statuses of a run that can still be controlled (resumed, skipped, stopped ...). */
const OPEN = new Set(['running', 'pausing', 'paused', 'stopping', 'failed']);
/** Errors that mean "log in again" rather than "this step is broken". */
const LOGIN_CODES = new Set(['session_expired', 'session_lost', 'login_required', 'login_not_confirmed', 'browser_not_running', 'browser_session_lost']);
const STOP_WAIT_MS = 30000;

const PAUSE_TEXT = {
  user: 'Paused at a safe checkpoint, as requested.',
  step_mode: 'Waiting: use Execute Current Step, Skip Current Step or Resume.',
  session_expired: 'Authentication expired. Log in again in the remote browser, confirm, then resume.',
  session_lost: 'The browser session was lost. Open the login page, log in again, confirm, then resume.',
  browser_not_running: 'The browser is not running. Open the login page, log in again, confirm, then resume.',
  browser_session_lost: 'The browser session was lost. Open the login page, log in again, confirm, then resume.',
  login_required: 'Login is required before the run can continue.',
  login_not_confirmed: 'Login is not confirmed. Log in, confirm, then resume.',
  page_crashed: 'The browser page crashed and was recreated. Check the remote browser, log in again if needed, then resume.',
};

/**
 * Owns the single active workflow run.
 *
 * Execution state lives in memory and a small marker file in the temporary directory. A service restart
 * loses the run: on the next start the marker is reported as `interruptedRun`. Nothing here claims otherwise.
 */
class AutomationService {
  constructor({ browser, login, recorder, remote, workflows, runner, storage, events, screenshots }) {
    Object.assign(this, { browser, login, recorder, remote, workflows, runner, storage, events, screenshots });
    this.run = null;
    // Filled in by init(): StorageService only knows about a run left by a previous process after storage.init(),
    // which runs later than this constructor.
    this.interruptedRun = null;
    this.testing = null;

    events.setContextProvider(() => this._eventContext());
    workflows.inUseProvider = () => (this.run && DRIVING.has(this.run.status) ? this.run.workflowId : null);

    const guard = () => this.assertNotBusy();
    remote.guard = guard;
    recorder.guard = guard;
    login.guard = guard;

    browser.on('session-lost', () => {
      // Interrupt whatever step is in flight so the run pauses immediately instead of waiting for a timeout.
      this.run?.stepAbort?.abort('session_lost');
      this.testing?.abort.abort('session_lost');
    });
  }

  /** Pick up a run that a previous process left behind. Must be called after storage.init(). */
  init() {
    this.interruptedRun = this.storage.previous.interruptedRun || null;
  }

  /** Report a run that a previous process left behind (called once at boot, after events are wired). */
  announceInterrupted() {
    if (!this.interruptedRun) return;
    const r = this.interruptedRun;
    logger.warn('A previous automation run was interrupted by a service restart', { workflowId: r.workflowId, runId: r.id });
    this.events.emitEvent('workflow.interrupted', 'Automation was interrupted because the service restarted. The browser session and run state were lost; log in again and start the workflow again.', {
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      runId: r.id,
      data: { interruptedRun: this.interruptedRun },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------------------------------

  get busy() {
    return Boolean(this.testing) || Boolean(this.run && DRIVING.has(this.run.status));
  }

  assertNotBusy() {
    if (this.busy) {
      throw err.conflict('automation_running', 'Automation is currently driving the browser. Pause or stop it before interacting manually.', {
        hint: 'POST /api/automation/pause or /api/automation/stop',
      });
    }
  }

  _counts(run) {
    const by = (s) => run.steps.filter((x) => x.status === s).length;
    const completed = by('completed');
    const skipped = by('skipped');
    const failed = by('failed');
    const total = run.steps.length;
    return { completed, skipped, failed, total, progress: total ? Math.round(((completed + skipped) / total) * 100) : 0 };
  }

  _currentStepView(run) {
    const s = run.steps[Math.min(run.currentIndex, run.steps.length - 1)];
    return s ? { id: s.id, number: s.number, name: s.name, index: Math.min(run.currentIndex, run.steps.length - 1), status: s.status } : null;
  }

  _eventContext() {
    const run = this.run;
    const base = { currentUrl: this.browser.currentUrl() };
    if (!run || !(OPEN.has(run.status) || run.finalizing)) return base;
    const c = this._counts(run);
    return {
      ...base,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      runId: run.id,
      currentStep: this._currentStepView(run),
      totalSteps: c.total,
      completedSteps: c.completed,
      failedSteps: c.failed,
      progress: c.progress,
    };
  }

  _publicStep(s) {
    const { definition, ...rest } = s;
    return rest;
  }

  _publicRun(run) {
    if (!run) return null;
    const c = this._counts(run);
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      pauseReason: run.pauseReason,
      message: run.message,
      phase: run.phase,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      confirmDestructive: run.confirmDestructive,
      currentStepIndex: run.currentIndex,
      currentStep: this._currentStepView(run),
      totalSteps: c.total,
      completedSteps: c.completed,
      skippedSteps: c.skipped,
      failedSteps: c.failed,
      progress: c.progress,
      loginRequired: Boolean(run.pauseReason && LOGIN_CODES.has(run.pauseReason)),
      steps: run.steps.map((s) => this._publicStep(s)),
    };
  }

  controls() {
    const run = this.run;
    const status = run?.status;
    const driving = this.busy;
    return {
      start: !driving && !(run && OPEN.has(status)),
      pause: status === 'running',
      resume: status === 'paused' || status === 'pausing' || status === 'failed',
      stop: Boolean(run && OPEN.has(status)) || Boolean(this.testing),
      restart: Boolean(run),
      executeStep: status === 'paused' || status === 'failed',
      skipStep: Boolean(run && (status === 'running' || status === 'paused' || status === 'failed')),
      testStep: !driving,
    };
  }

  status() {
    const run = this.run;
    return {
      state: run ? run.status : this.interruptedRun ? 'interrupted' : 'idle',
      busy: this.busy,
      testing: Boolean(this.testing),
      run: this._publicRun(run),
      interruptedRun: this.interruptedRun,
      controls: this.controls(),
      login: { state: this.login.state, eligibleForAutomation: this.login.isConfirmed },
      note: 'Execution state lives in memory for the current service lifetime only. A restart, redeploy or free-tier spin-down interrupts a run.',
    };
  }

  _persist(run) {
    if (!OPEN.has(run.status)) return;
    this.storage.saveActiveRun({
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      currentStepIndex: run.currentIndex,
      totalSteps: run.steps.length,
      startedAt: run.startedAt,
    });
  }

  _emit(type, description, extra) {
    return this.events.emitEvent(type, description, extra);
  }

  // ---------------------------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------------------------

  async start({ workflowId, confirmDestructive = false, paused = false, startAtStep } = {}) {
    if (typeof workflowId !== 'string') throw err.unprocessable('invalid_request', 'workflowId is required.');
    if (this.busy) this.assertNotBusy();
    if (this.run && OPEN.has(this.run.status)) {
      throw err.conflict('automation_active', `A run is already ${this.run.status}. Only one workflow can be active at a time.`, {
        hint: 'Stop it with POST /api/automation/stop, or use /api/automation/restart.',
      });
    }
    if (this.recorder.isActive()) {
      throw err.conflict('recorder_active', 'Stop recording before starting automation: recording blocks page actions.');
    }

    const workflow = this.workflows.validateForRun(workflowId); // 404 / 409 / 422
    this.login.assertEligible(); // browser running + user confirmed login

    const enabled = workflow.steps.filter((s) => s.enabled);
    let currentIndex = 0;
    if (startAtStep !== undefined) {
      const idx = enabled.findIndex((s) => s.number === startAtStep);
      if (idx < 0) throw err.unprocessable('invalid_start_step', `startAtStep ${startAtStep} is not an enabled step of this workflow.`);
      currentIndex = idx;
    }

    const run = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'running',
      pauseReason: null,
      message: null,
      phase: null,
      startedAt: nowIso(),
      finishedAt: null,
      confirmDestructive: Boolean(confirmDestructive),
      currentIndex,
      pauseRequested: false,
      stopRequested: false,
      skipRequested: false,
      stepAbort: null,
      loopActive: false,
      finalizing: false,
      done: Promise.resolve(),
      steps: enabled.map((s) => ({
        id: s.id,
        number: s.number,
        name: s.name,
        action: s.action,
        status: 'pending',
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        error: null,
        screenshot: null,
        definition: s,
      })),
    };
    this.interruptedRun = null;
    this.run = run;
    this._persist(run);
    this._emit('workflow.started', `Workflow "${workflow.name}" started (${run.steps.length} steps).`);
    logger.info('Automation started', { runId: run.id, workflowId: workflow.id, steps: run.steps.length });

    if (paused) {
      this._setPaused(run, 'step_mode');
    } else {
      this._drive(run);
    }
    return this.status();
  }

  pause() {
    const run = this.run;
    if (!run || !OPEN.has(run.status)) throw err.conflict('no_active_run', 'There is no active run to pause.');
    if (run.status === 'paused' || run.status === 'pausing') return this.status();
    if (run.status !== 'running') throw err.conflict('cannot_pause', `A run that is ${run.status} cannot be paused.`);
    run.pauseRequested = true;
    run.status = 'pausing';
    run.message = 'Pause requested; the run will pause after the current step finishes.';
    return this.status();
  }

  resume() {
    const run = this.run;
    if (!run || !OPEN.has(run.status)) throw err.conflict('no_active_run', 'There is no paused run to resume.');
    if (run.status === 'running') return this.status();
    if (run.status === 'pausing') {
      run.pauseRequested = false;
      run.status = 'running';
      run.message = null;
      return this.status();
    }
    if (run.status !== 'paused' && run.status !== 'failed') throw err.conflict('cannot_resume', `A run that is ${run.status} cannot be resumed.`);
    this.assertNotBusy();
    this.login.assertEligible();
    const retrying = run.status === 'failed';
    run.pauseRequested = false;
    run.pauseReason = null;
    run.message = null;
    run.status = 'running';
    this._persist(run);
    this._emit('workflow.resumed', retrying ? 'Workflow resumed; retrying the failed step.' : 'Workflow resumed.');
    this._drive(run);
    return this.status();
  }

  async stop() {
    if (this.testing) this.testing.abort.abort('stop');
    const run = this.run;
    if (!run || !OPEN.has(run.status)) {
      if (this.interruptedRun) {
        this.interruptedRun = null; // acknowledged
        return this.status();
      }
      if (this.testing) return this.status();
      throw err.conflict('no_active_run', 'There is no active run to stop.');
    }
    run.stopRequested = true;
    if (run.loopActive) {
      run.status = 'stopping';
      run.message = 'Stopping: no further actions will be scheduled.';
      run.stepAbort?.abort('stop');
    } else {
      this._finish(run, 'stopped');
    }
    return this.status();
  }

  async restart({ confirmDestructive } = {}) {
    const run = this.run;
    if (!run) throw err.conflict('no_run', 'There is no previous run to restart. Use start with a workflowId.');
    const workflowId = run.workflowId;
    const confirm = confirmDestructive ?? run.confirmDestructive;
    if (OPEN.has(run.status)) {
      await this.stop();
      await Promise.race([run.done, new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    }
    return this.start({ workflowId, confirmDestructive: confirm });
  }

  /** Execute exactly the current step, then wait again. Works while paused or after a failure. */
  async executeStep() {
    const run = this.run;
    if (!run || !OPEN.has(run.status)) throw err.conflict('no_active_run', 'There is no run to execute a step for. Start a run (optionally with paused=true).');
    if (run.status !== 'paused' && run.status !== 'failed') throw err.conflict('automation_running', 'The run is already executing; pause it first.');
    this.assertNotBusy();
    this.login.assertEligible();
    if (run.currentIndex >= run.steps.length) throw err.conflict('no_current_step', 'All steps have been processed.');
    run.pauseReason = null;
    run.message = null;
    run.status = 'running';
    this._persist(run);
    this._drive(run, { single: true });
    return this.status();
  }

  skipStep() {
    const run = this.run;
    if (!run || !OPEN.has(run.status)) throw err.conflict('no_active_run', 'There is no active run.');
    if (run.currentIndex >= run.steps.length) throw err.conflict('no_current_step', 'All steps have been processed.');

    if (run.status === 'running' || run.status === 'pausing') {
      // The loop owns the step: abort the in-flight step, or flag the next one to be skipped.
      if (run.stepAbort) run.stepAbort.abort('skip');
      else run.skipRequested = true;
      return this.status();
    }
    if (run.status !== 'paused' && run.status !== 'failed') throw err.conflict('cannot_skip', `A run that is ${run.status} cannot skip a step.`);
    const skipped = this._markSkipped(run);
    if (run.currentIndex >= run.steps.length) {
      this._finish(run, 'completed');
    } else {
      run.status = 'paused';
      run.pauseReason = 'step_mode';
      run.message = `Skipped step ${skipped.number}. ${PAUSE_TEXT.step_mode}`;
      this._persist(run);
    }
    return this.status();
  }

  _markSkipped(run) {
    const s = run.steps[run.currentIndex];
    s.status = 'skipped';
    s.error = null;
    s.finishedAt = nowIso();
    run.currentIndex += 1;
    this._emit('step.skipped', `Step ${s.number} "${s.name}" was skipped.`, { stepName: s.name });
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // Test a single step
  // ---------------------------------------------------------------------------------------------

  async testStep({ workflowId, stepId, stepNumber, step, confirmDestructive = false, screenshot = false } = {}) {
    if (this.busy) this.assertNotBusy();
    if (!this.browser.isReady) {
      throw err.conflict('browser_not_running', 'The browser is not running. Launch it and open the page the step belongs to first.');
    }
    if (this.recorder.isActive()) throw err.conflict('recorder_active', 'Stop recording before testing a step.');

    let definition;
    let workflowName = 'Step test';
    if (step) {
      definition = validateWorkflowInput({ name: 'Step test', steps: [step] }).steps[0];
    } else {
      if (typeof workflowId !== 'string') throw err.unprocessable('invalid_request', 'Provide workflowId with stepId/stepNumber, or an inline step.');
      const wf = this.workflows.get(workflowId);
      workflowName = wf.name;
      definition = wf.steps.find((s) => (stepId ? s.id === stepId : s.number === stepNumber));
      if (!definition) throw err.notFound('step_not_found', 'That step does not exist in the workflow.');
    }
    const testDef = { ...definition, screenshot: Boolean(screenshot), enabled: true };

    const abort = new AbortController();
    this.testing = { abort, startedAt: nowIso() };
    const run = { id: `test-${crypto.randomBytes(4).toString('hex')}`, workflowId: workflowId ?? null, workflowName, confirmDestructive: Boolean(confirmDestructive) };
    this._emit('step.started', `Testing step "${definition.name}".`, { stepName: definition.name, data: { test: true } });
    try {
      const result = await this.runner.runStep(testDef, { signal: abort.signal, run, total: 1, onPhase() {} });
      this._emit('step.completed', `Step test "${definition.name}" passed.`, { stepName: definition.name, data: { test: true } });
      return { passed: true, step: { id: definition.id, number: definition.number, name: definition.name, action: definition.action }, result };
    } catch (e) {
      const error = e instanceof AbortError ? err.conflict('aborted', 'The step test was cancelled.') : toAppError(e);
      this._emit('step.failed', `Step test "${definition.name}" failed: ${error.message}`, {
        stepName: definition.name,
        data: { test: true, error: { code: error.code, message: error.message } },
      });
      error.details = { ...(error.details || {}), step: { id: definition.id, number: definition.number, name: definition.name } };
      throw error;
    } finally {
      this.testing = null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Execution loop
  // ---------------------------------------------------------------------------------------------

  _drive(run, { single = false } = {}) {
    run.loopActive = true;
    run.done = (async () => {
      try {
        await this._loop(run, single);
      } catch (e) {
        logger.error('Automation loop crashed', { error: e });
        run.status = 'failed';
        run.pauseReason = 'internal_error';
        run.message = 'The automation engine hit an unexpected error.';
        this._emit('service.error', 'The automation engine hit an unexpected error.', { data: { code: 'internal_error' } });
      } finally {
        run.loopActive = false;
        run.stepAbort = null;
        run.phase = null;
        this._persist(run);
      }
    })();
    return run.done;
  }

  async _loop(run, single) {
    let first = true;
    for (;;) {
      if (run.stopRequested) return this._finish(run, 'stopped');
      if (run.currentIndex >= run.steps.length) return this._finish(run, 'completed');
      if (!single && run.pauseRequested) return this._setPaused(run, 'user');
      if (single && !first) return this._setPaused(run, 'step_mode');
      try {
        this.login.assertEligible();
      } catch (e) {
        return this._setPaused(run, e.code || 'login_required');
      }
      first = false;
      if (run.skipRequested) {
        run.skipRequested = false;
        this._markSkipped(run);
        continue;
      }
      const outcome = await this._executeCurrent(run);
      if (outcome === 'stopped') return this._finish(run, 'stopped');
      if (outcome === 'paused' || outcome === 'failed') return undefined;
    }
  }

  async _executeCurrent(run) {
    const state = run.steps[run.currentIndex];
    const abort = new AbortController();
    run.stepAbort = abort;
    state.status = 'running';
    state.attempts += 1;
    state.startedAt = nowIso();
    state.finishedAt = null;
    state.error = null;
    run.phase = 'Starting step';
    this._emit('step.started', `Step ${state.number} "${state.name}" started.`, { stepName: state.name });

    const started = Date.now();
    try {
      const result = await this.runner.runStep(state.definition, {
        signal: abort.signal,
        run,
        total: run.steps.length,
        onPhase: (label) => {
          run.phase = label;
        },
      });
      state.status = 'completed';
      state.finishedAt = nowIso();
      state.durationMs = Date.now() - started;
      state.url = result.url;
      state.usedFallbackLocator = Boolean(result.usedFallback);
      if (result.screenshot) state.screenshot = { id: result.screenshot.id, filename: result.screenshot.filename };
      run.currentIndex += 1;
      this._emit('step.completed', `Step ${state.number} "${state.name}" completed.`, {
        stepName: state.name,
        data: { durationMs: state.durationMs, screenshot: state.screenshot, usedFallbackLocator: state.usedFallbackLocator },
      });
      return 'completed';
    } catch (e) {
      state.durationMs = Date.now() - started;
      state.finishedAt = nowIso();
      if (e instanceof AbortError) return this._onAbort(run, state, e.reason);

      const error = toAppError(e);
      // A crashed page inside a healthy browser keeps its cookies, so only a page recovery is needed.
      if (error.code === 'browser_session_lost' && this.browser.isReady) return this._pauseStep(run, state, 'page_crashed');
      if (LOGIN_CODES.has(error.code)) return this._pauseStep(run, state, error.code);

      state.status = 'failed';
      state.error = { code: error.code, message: error.message, hint: error.hint, details: error.details };
      run.status = 'failed';
      run.pauseReason = null;
      run.message = `Step ${state.number} "${state.name}" failed: ${error.message}`;
      logger.warn('Automation step failed', { runId: run.id, step: state.number, code: error.code });
      this._emit('step.failed', run.message, { stepName: state.name, data: { error: state.error } });
      this._persist(run);
      return 'failed';
    } finally {
      run.stepAbort = null;
    }
  }

  _onAbort(run, state, reason) {
    if (reason === 'skip') {
      state.status = 'skipped';
      state.error = null;
      run.currentIndex += 1;
      this._emit('step.skipped', `Step ${state.number} "${state.name}" was skipped.`, { stepName: state.name });
      return 'skipped';
    }
    state.status = 'pending'; // not completed; it can be run again after resuming
    if (reason === 'session_lost') return this._pauseStep(run, state, 'browser_session_lost');
    return 'stopped';
  }

  _pauseStep(run, state, reason) {
    state.status = 'pending';
    state.error = null;
    this._setPaused(run, reason);
    return 'paused';
  }

  _setPaused(run, reason) {
    run.status = 'paused';
    run.pauseReason = reason;
    run.pauseRequested = false;
    run.message = PAUSE_TEXT[reason] || `Paused: ${reason}.`;
    run.phase = null;
    this._persist(run);
    this._emit('workflow.paused', run.message, { data: { reason, loginRequired: LOGIN_CODES.has(reason) } });
    return undefined;
  }

  _finish(run, status) {
    run.status = status;
    run.finishedAt = nowIso();
    run.pauseReason = null;
    run.phase = null;
    run.finalizing = true;
    try {
      const c = this._counts(run);
      if (status === 'completed') {
        run.message = `Completed ${c.completed} step(s)${c.skipped ? `, skipped ${c.skipped}` : ''}.`;
        this._emit('workflow.completed', `Workflow "${run.workflowName}" completed.`, { data: { screenshots: run.steps.filter((s) => s.screenshot).length } });
      } else {
        run.message = 'Stopped by request.';
        this._emit('workflow.stopped', `Workflow "${run.workflowName}" stopped.`);
      }
    } finally {
      run.finalizing = false;
    }
    this.storage.clearActiveRun();
    logger.info('Automation finished', { runId: run.id, status });
    return undefined;
  }

  /** Stop everything during shutdown without touching state (used by graceful shutdown). */
  async shutdown() {
    const run = this.run;
    if (run && DRIVING.has(run.status)) {
      run.stopRequested = true;
      run.stepAbort?.abort('stop');
      await Promise.race([run.done, new Promise((r) => setTimeout(r, 3000))]);
    }
    // State writes are fire-and-forget during a run; wait for them so shutdown never leaves a torn marker file.
    await this.storage.flush();
  }
}

module.exports = { AutomationService, DRIVING, OPEN, LOGIN_CODES };
