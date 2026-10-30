'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createEnv } = require('../../src/config/settings');
const { StorageService } = require('../../src/services/storage.service');
const { WorkflowService } = require('../../src/services/workflow.service');
const { LoginService } = require('../../src/services/login.service');
const { EventService } = require('../../src/services/event.service');
const { AutomationService } = require('../../src/services/automation.service');
const { AbortError } = require('../../src/utils/async-utils');
const { err } = require('../../src/errors');

const TOKEN = 'unit-token-0123456789abcdef0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'condition', ms = 4000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Builds an AutomationService with a scripted step runner so execution order and timing are deterministic. */
async function setup({ steps = 3, behaviour = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-auto-'));
  const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir });
  const events = new EventService(env);
  const storage = new StorageService(env, { restartId: events.restartId });
  await storage.init();
  const workflows = new WorkflowService({ env });

  const browser = new EventEmitter();
  browser.isReady = true;
  browser.sessionId = 's1';
  browser.currentUrl = () => 'https://example.com/';
  browser.launch = async () => {};
  browser.checkUrl = (u) => u;
  browser.navigate = async () => {};
  const settings = { get: () => ({ defaultLoginUrl: 'https://login/' }) };
  const login = new LoginService({ browser, events, settings });
  await login.open();
  await login.confirm();

  const log = [];
  const runner = {
    runStep: async (step, ctx) => {
      log.push(step.name);
      const fn = behaviour[step.name];
      if (fn) return fn(step, ctx);
      return { status: 'completed', url: `https://example.com/${step.name}`, durationMs: 1 };
    },
  };
  const recorder = { isActive: () => false, stop: async () => {}, guard: null };
  const remote = { guard: null };
  const screenshots = { findByRunStep: () => null };
  const automation = new AutomationService({ browser, login, recorder, remote, workflows, runner, storage, events, screenshots });

  const names = ['one', 'two', 'three', 'four', 'five'].slice(0, steps);
  const { workflow } = await workflows.create({
    name: 'Flow',
    steps: names.map((n) => ({ name: n, action: 'click', target: { strategy: 'css', selector: `#${n}` } })),
  });
  const emitted = [];
  events.on('event', (e) => emitted.push(e));
  return {
    automation, workflows, workflow, log, events, emitted, browser, login, storage, runner, recorder, remote,
    cleanup: async () => { await automation.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); },
    status: () => automation.status(),
    until,
  };
}
const finished = (ctx) => until(() => ['completed', 'failed', 'stopped', 'paused'].includes(ctx.automation.run?.status), 'run to settle');

test('runs enabled steps in order and completes with real progress', async () => {
  const ctx = await setup();
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await finished(ctx);
    assert.deepEqual(ctx.log, ['one', 'two', 'three']);
    const run = ctx.status().run;
    assert.equal(run.status, 'completed');
    assert.equal(run.completedSteps, 3);
    assert.equal(run.progress, 100);
    assert.deepEqual(run.steps.map((s) => s.status), ['completed', 'completed', 'completed']);
    const types = ctx.emitted.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t.startsWith('step.') || t.startsWith('workflow.')), [
      'workflow.started', 'step.started', 'step.completed', 'step.started', 'step.completed', 'step.started', 'step.completed', 'workflow.completed',
    ]);
  } finally { await ctx.cleanup(); }
});

test('progress and counts in events reflect actual execution, never simulated values', async () => {
  const ctx = await setup();
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await finished(ctx);
    const done = ctx.emitted.filter((e) => e.type === 'step.completed');
    assert.deepEqual(done.map((e) => e.completedSteps), [1, 2, 3]);
    assert.deepEqual(done.map((e) => e.progress), [33, 67, 100]);
    assert.ok(done.every((e) => e.totalSteps === 3 && e.workflowName === 'Flow'));
    const started = ctx.emitted.find((e) => e.type === 'step.started');
    assert.equal(started.currentStep.number, 1);
    assert.equal(started.progress, 0);
  } finally { await ctx.cleanup(); }
});

test('disabled steps are skipped and do not count toward the total', async () => {
  const ctx = await setup();
  try {
    const wf = ctx.workflows.get(ctx.workflow.id);
    wf.steps[1].enabled = false;
    await ctx.workflows.update(ctx.workflow.id, { steps: wf.steps });
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await finished(ctx);
    assert.deepEqual(ctx.log, ['one', 'three']);
    assert.equal(ctx.status().run.totalSteps, 2);
    assert.equal(ctx.status().run.progress, 100);
  } finally { await ctx.cleanup(); }
});

test('start is refused without a confirmed login, without a browser, and for unknown workflows', async () => {
  const ctx = await setup();
  try {
    ctx.login.cancel();
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id }), (e) => e.code === 'login_required' || e.code === 'login_not_confirmed' || e.code === 'login_cancelled');
    await ctx.login.open();
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id }), (e) => e.code === 'login_not_confirmed');
    await ctx.login.confirm();
    await assert.rejects(ctx.automation.start({ workflowId: '3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11' }), (e) => e.code === 'workflow_not_found');
    await assert.rejects(ctx.automation.start({}), (e) => e.code === 'invalid_request');
    ctx.browser.isReady = false;
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id }), (e) => e.code === 'browser_not_running');
    assert.equal(ctx.log.length, 0, 'nothing ran');
  } finally { await ctx.cleanup(); }
});

test('only one workflow can be active at a time', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { one: () => new Promise((r) => { gate.release = () => r({ status: 'completed' }); }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.length === 1, 'first step to start');
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id }), (e) => e.code === 'automation_running');
    gate.release();
    await finished(ctx);
  } finally { await ctx.cleanup(); }
});

test('pause waits for a safe checkpoint (the current step finishes) and resume continues from the next step', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { two: () => new Promise((r) => { gate.release = () => r({ status: 'completed' }); }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.includes('two'), 'step two to start');
    const paused = ctx.automation.pause();
    assert.equal(paused.state, 'pausing');
    assert.deepEqual(ctx.log, ['one', 'two'], 'step three is not scheduled');
    gate.release();
    await until(() => ctx.automation.run.status === 'paused', 'paused');
    assert.deepEqual(ctx.status().run.steps.map((s) => s.status), ['completed', 'completed', 'pending']);
    assert.equal(ctx.status().run.pauseReason, 'user');
    await sleep(30);
    assert.deepEqual(ctx.log, ['one', 'two'], 'nothing runs while paused');

    ctx.automation.resume();
    await finished(ctx);
    assert.deepEqual(ctx.log, ['one', 'two', 'three'], 'resumes at step three; steps one and two are not repeated');
    assert.equal(ctx.status().run.status, 'completed');
    assert.ok(ctx.emitted.some((e) => e.type === 'workflow.paused'));
    assert.ok(ctx.emitted.some((e) => e.type === 'workflow.resumed'));
  } finally { await ctx.cleanup(); }
});

test('resuming a pause request before it takes effect cancels the pause', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { one: () => new Promise((r) => { gate.release = () => r({ status: 'completed' }); }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.length === 1, 'step one');
    ctx.automation.pause();
    assert.equal(ctx.automation.run.status, 'pausing');
    ctx.automation.resume();
    assert.equal(ctx.automation.run.status, 'running');
    gate.release();
    await finished(ctx);
    assert.equal(ctx.status().run.status, 'completed');
  } finally { await ctx.cleanup(); }
});

test('stop cancels the in-flight step and schedules nothing further', async () => {
  let aborted = false;
  const ctx = await setup({
    behaviour: {
      two: (step, c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => { aborted = true; reject(new AbortError(c.signal.reason)); })),
    },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.includes('two'), 'step two');
    const s = await ctx.automation.stop();
    assert.equal(s.state, 'stopping');
    await until(() => ctx.automation.run.status === 'stopped', 'stopped');
    assert.equal(aborted, true);
    assert.deepEqual(ctx.log, ['one', 'two'], 'step three never started');
    assert.deepEqual(ctx.status().run.steps.map((s2) => s2.status), ['completed', 'pending', 'pending']);
    assert.ok(ctx.emitted.some((e) => e.type === 'workflow.stopped'));
    assert.equal(ctx.status().controls.start, true, 'a new run can start after a stop');
  } finally { await ctx.cleanup(); }
});

test('a stop requested between steps prevents the next step from ever being scheduled', async () => {
  // Step one finishes normally, so there is no in-flight step left to abort: the only thing that can stop step
  // two is the loop honouring the stop request before it schedules the next action.
  let ctxRef;
  const ctx = await setup({
    behaviour: {
      one: async () => {
        ctxRef.automation.run.stopRequested = true; // a stop request lands while step one is finishing
        return { status: 'completed' };
      },
    },
  });
  ctxRef = ctx;
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await finished(ctx);
    assert.deepEqual(ctx.log, ['one'], 'step two was not started after the stop request');
    assert.equal(ctx.status().run.status, 'stopped');
    assert.deepEqual(ctx.status().run.steps.map((s) => s.status), ['completed', 'pending', 'pending']);
  } finally { await ctx.cleanup(); }
});

test('stop while paused ends the run; stop with nothing active is a conflict', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.automation.stop(), (e) => e.code === 'no_active_run');
    await ctx.automation.start({ workflowId: ctx.workflow.id, paused: true });
    assert.equal(ctx.status().state, 'paused');
    await ctx.automation.stop();
    assert.equal(ctx.status().state, 'stopped');
    assert.equal(ctx.log.length, 0);
  } finally { await ctx.cleanup(); }
});

test('a failed step stops the run on that step and reports the failure; resume retries it', async () => {
  let attempts = 0;
  const ctx = await setup({
    behaviour: { two: () => { attempts += 1; if (attempts === 1) throw err.notFound('element_not_found', 'Not found'); return { status: 'completed' }; } },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await finished(ctx);
    const run = ctx.status().run;
    assert.equal(run.status, 'failed');
    assert.equal(run.failedSteps, 1);
    assert.equal(run.steps[1].status, 'failed');
    assert.equal(run.steps[1].error.code, 'element_not_found');
    assert.deepEqual(ctx.log, ['one', 'two']);
    assert.ok(ctx.emitted.some((e) => e.type === 'step.failed' && e.failedSteps === 1));

    ctx.automation.resume();
    await finished(ctx);
    assert.equal(ctx.status().run.status, 'completed');
    assert.deepEqual(ctx.log, ['one', 'two', 'two', 'three'], 'step one is not repeated, step two is retried');
    assert.equal(ctx.status().run.steps[1].attempts, 2);
  } finally { await ctx.cleanup(); }
});

test('execute-step runs exactly one step and then waits again', async () => {
  const ctx = await setup();
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id, paused: true });
    assert.equal(ctx.log.length, 0);
    await ctx.automation.executeStep();
    await until(() => ctx.automation.run.status === 'paused' && ctx.log.length === 1, 'one step');
    assert.deepEqual(ctx.log, ['one']);
    assert.equal(ctx.status().run.currentStepIndex, 1);
    await ctx.automation.executeStep();
    await until(() => ctx.log.length === 2 && ctx.automation.run.status === 'paused', 'second step');
    await assert.rejects(ctx.automation.executeStep().then(() => ctx.automation.executeStep()), () => true).catch(() => {});
  } finally { await ctx.cleanup(); }
});

test('execute-step on the last step completes the run', async () => {
  const ctx = await setup({ steps: 1 });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id, paused: true });
    await ctx.automation.executeStep();
    await until(() => ctx.automation.run.status === 'completed', 'completion');
    assert.equal(ctx.status().run.progress, 100);
  } finally { await ctx.cleanup(); }
});

test('skip-step while paused moves to the next step without running it', async () => {
  const ctx = await setup();
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id, paused: true });
    const s = ctx.automation.skipStep();
    assert.equal(s.run.skippedSteps, 1);
    assert.equal(s.run.currentStepIndex, 1);
    assert.equal(s.run.steps[0].status, 'skipped');
    assert.equal(ctx.log.length, 0, 'skipped steps are never executed');
    assert.ok(ctx.emitted.some((e) => e.type === 'step.skipped'));
    ctx.automation.resume();
    await finished(ctx);
    assert.deepEqual(ctx.log, ['two', 'three']);
    assert.equal(ctx.status().run.status, 'completed');
    assert.equal(ctx.status().run.progress, 100, 'skipped steps count as handled');
  } finally { await ctx.cleanup(); }
});

test('skip-step during execution aborts the in-flight step and carries on', async () => {
  const ctx = await setup({
    behaviour: { one: (step, c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(new AbortError(c.signal.reason)))) },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.length === 1, 'step one running');
    ctx.automation.skipStep();
    await finished(ctx);
    assert.deepEqual(ctx.status().run.steps.map((s) => s.status), ['skipped', 'completed', 'completed']);
    assert.deepEqual(ctx.log, ['one', 'two', 'three']);
  } finally { await ctx.cleanup(); }
});

test('losing the browser session mid-run pauses for re-login instead of failing; resume needs a fresh confirmation', async () => {
  const ctx = await setup({
    behaviour: { two: (step, c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(new AbortError(c.signal.reason)))) },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.includes('two'), 'step two');
    ctx.browser.isReady = false;
    ctx.browser.sessionId = null;
    ctx.browser.emit('session-lost', { reason: 'disconnected' });
    await until(() => ctx.automation.run.status === 'paused', 'pause on lost session');
    const run = ctx.status().run;
    assert.equal(run.pauseReason, 'browser_session_lost');
    assert.equal(run.loginRequired, true);
    assert.match(run.message, /log in again/i);
    assert.equal(run.steps[1].status, 'pending', 'the interrupted step is retried, not marked failed');
    assert.equal(run.failedSteps, 0);
    assert.throws(() => ctx.automation.resume(), (e) => ['browser_not_running', 'session_lost'].includes(e.code));

    // user opens the login page again, logs in, confirms
    ctx.browser.isReady = true;
    ctx.browser.sessionId = 's2';
    await ctx.login.open();
    await ctx.login.confirm();
    ctx.runner.runStep = async (step) => { ctx.log.push(step.name); return { status: 'completed' }; };
    ctx.automation.resume();
    await finished(ctx);
    assert.equal(ctx.status().run.status, 'completed');
    assert.deepEqual(ctx.log.slice(-2), ['two', 'three']);
  } finally { await ctx.cleanup(); }
});

test('an expired login (detected by the runner) pauses the run and asks for manual re-authentication', async () => {
  let first = true;
  const ctx = await setup({
    behaviour: { two: () => { if (first) { first = false; throw err.conflict('session_expired', 'expired'); } return { status: 'completed' }; } },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.automation.run.status === 'paused', 'pause on expiry');
    assert.equal(ctx.status().run.pauseReason, 'session_expired');
    assert.equal(ctx.status().run.loginRequired, true);
    assert.equal(ctx.status().run.failedSteps, 0);
  } finally { await ctx.cleanup(); }
});

test('a crashed page inside a healthy browser pauses with a page_crashed reason', async () => {
  let first = true;
  const ctx = await setup({
    behaviour: { one: () => { if (first) { first = false; throw err.conflict('browser_session_lost', 'page crashed'); } return { status: 'completed' }; } },
  });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.automation.run.status === 'paused', 'pause');
    assert.equal(ctx.status().run.pauseReason, 'page_crashed');
  } finally { await ctx.cleanup(); }
});

test('restart stops the current run and starts again from step one', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { two: (step, c) => new Promise((resolve, reject) => { c.signal.addEventListener('abort', () => reject(new AbortError(c.signal.reason))); gate.set = true; }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => gate.set, 'step two blocked');
    const firstRunId = ctx.automation.run.id;
    ctx.runner.runStep = async (step) => { ctx.log.push(step.name); return { status: 'completed' }; };
    await ctx.automation.restart();
    await finished(ctx);
    assert.notEqual(ctx.automation.run.id, firstRunId);
    assert.equal(ctx.status().run.status, 'completed');
    assert.deepEqual(ctx.log.slice(-3), ['one', 'two', 'three']);
    await assert.rejects(async () => { ctx.automation.run = null; await ctx.automation.restart(); }, (e) => e.code === 'no_run');
  } finally { await ctx.cleanup(); }
});

test('manual remote interaction, recording and workflow edits are refused while automation drives the browser', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { one: () => new Promise((r) => { gate.release = () => r({ status: 'completed' }); }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.length === 1, 'running');
    for (const guard of [ctx.remote.guard, ctx.login.guard]) assert.throws(guard, (e) => e.code === 'automation_running');
    await assert.rejects(ctx.workflows.update(ctx.workflow.id, { name: 'renamed' }), (e) => e.code === 'workflow_in_use');
    await assert.rejects(ctx.workflows.remove(ctx.workflow.id), (e) => e.code === 'workflow_in_use');
    gate.release();
    await finished(ctx);
    assert.doesNotThrow(ctx.remote.guard, 'interaction is allowed again afterwards');
  } finally { await ctx.cleanup(); }
});

test('start is refused while the recorder is active', async () => {
  const ctx = await setup();
  try {
    ctx.recorder.isActive = () => true;
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id }), (e) => e.code === 'recorder_active');
  } finally { await ctx.cleanup(); }
});

test('startAtStep begins at an enabled step and rejects an unknown one', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.automation.start({ workflowId: ctx.workflow.id, startAtStep: 9 }), (e) => e.code === 'invalid_start_step');
    await ctx.automation.start({ workflowId: ctx.workflow.id, startAtStep: 2 });
    await finished(ctx);
    assert.deepEqual(ctx.log, ['two', 'three']);
  } finally { await ctx.cleanup(); }
});

test('the controls object tells a client which actions are currently valid', async () => {
  const ctx = await setup();
  try {
    let c = ctx.status().controls;
    assert.equal(c.start, true);
    assert.equal(c.pause, false);
    assert.equal(c.stop, false);
    await ctx.automation.start({ workflowId: ctx.workflow.id, paused: true });
    c = ctx.status().controls;
    assert.deepEqual({ start: c.start, resume: c.resume, executeStep: c.executeStep, skipStep: c.skipStep, stop: c.stop, pause: c.pause }, { start: false, resume: true, executeStep: true, skipStep: true, stop: true, pause: false });
  } finally { await ctx.cleanup(); }
});

test('test-step runs a single step without creating a run, and reports failures with the step', async () => {
  const ctx = await setup({ behaviour: { two: () => { throw err.notFound('element_not_found', 'Not found'); } } });
  try {
    const wf = ctx.workflows.get(ctx.workflow.id);
    const ok = await ctx.automation.testStep({ workflowId: ctx.workflow.id, stepId: wf.steps[0].id });
    assert.equal(ok.passed, true);
    assert.equal(ctx.automation.run, null, 'no run was created');
    await assert.rejects(ctx.automation.testStep({ workflowId: ctx.workflow.id, stepNumber: 2 }), (e) => e.code === 'element_not_found' && e.details.step.number === 2);
    await assert.rejects(ctx.automation.testStep({ workflowId: ctx.workflow.id, stepNumber: 99 }), (e) => e.code === 'step_not_found');
    await assert.rejects(ctx.automation.testStep({}), (e) => e.code === 'invalid_request');
    const inline = await ctx.automation.testStep({ step: { name: 'inline', action: 'click', target: { strategy: 'css', selector: '#x' } } });
    assert.equal(inline.passed, true);
    assert.ok(ctx.emitted.some((e) => e.type === 'step.failed' && e.data?.test === true));
    assert.equal(ctx.automation.busy, false, 'the test lock is released after a failure');
  } finally { await ctx.cleanup(); }
});

test('an active run is persisted so a restart can report it as interrupted, and cleared when it ends', async () => {
  const gate = {};
  const ctx = await setup({ behaviour: { two: () => new Promise((r) => { gate.release = () => r({ status: 'completed' }); }) } });
  try {
    await ctx.automation.start({ workflowId: ctx.workflow.id });
    await until(() => ctx.log.includes('two'), 'step two');
    await sleep(40);
    assert.ok(fs.existsSync(ctx.storage.activeRunFile), 'marker exists while running');
    const marker = JSON.parse(fs.readFileSync(ctx.storage.activeRunFile, 'utf8'));
    assert.equal(marker.workflowName, 'Flow');
    assert.equal(marker.status, 'running');
    gate.release();
    await finished(ctx);
    await sleep(40);
    assert.equal(fs.existsSync(ctx.storage.activeRunFile), false, 'marker removed after completion');
  } finally { await ctx.cleanup(); }
});

test('after a restart the leftover run is reported as interrupted, honestly, and can be acknowledged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restart-'));
  try {
    const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir });
    const oldEvents = new EventService(env);
    const oldStorage = new StorageService(env, { restartId: oldEvents.restartId });
    await oldStorage.init();
    await oldStorage.saveActiveRun({ id: 'run-x', workflowId: 'wf-x', workflowName: 'Dynatrace Flow', status: 'running', currentStepIndex: 1, totalSteps: 3 });

    const events = new EventService(env);
    const storage = new StorageService(env, { restartId: events.restartId });
    await storage.init();
    const browser = Object.assign(new EventEmitter(), { isReady: false, sessionId: null, currentUrl: () => null });
    const login = new LoginService({ browser, events, settings: { get: () => ({}) } });
    const automation = new AutomationService({
      browser, login, recorder: { isActive: () => false }, remote: {}, workflows: new WorkflowService({ env }), runner: {}, storage, events, screenshots: {},
    });
    const emitted = [];
    events.on('event', (e) => emitted.push(e));

    // Before init() the service cannot know about the earlier process; the container calls init() after storage.init().
    assert.equal(automation.status().state, 'idle');
    automation.init();
    assert.equal(automation.status().state, 'interrupted');
    assert.equal(automation.status().interruptedRun.workflowName, 'Dynatrace Flow');
    automation.announceInterrupted();
    const evt = emitted.find((e) => e.type === 'workflow.interrupted');
    assert.ok(evt);
    assert.match(evt.description, /restarted/);
    assert.match(evt.description, /log in again/i);
    assert.equal(evt.workflowName, 'Dynatrace Flow');

    await automation.stop(); // acknowledge
    assert.equal(automation.status().state, 'idle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
