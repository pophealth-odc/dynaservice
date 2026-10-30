'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp, TOKEN, sleep, waitFor } = require('../helpers/harness');
const { createFakeLauncher } = require('../helpers/fake-browser');

const fake = () => ({ browser: { launcher: createFakeLauncher(), memoryProbe: () => ({ availableMB: 1000, limitMB: 2000 }) } });

/** Minimal SSE reader built on fetch streaming, the same technique the test console uses. */
async function openStream(base, { token = TOKEN, lastEventId } = {}) {
  const controller = new AbortController();
  const headers = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  const res = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
  const events = [];
  let closed = false;
  const done = (async () => {
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const raw of parts) {
          if (!raw.trim() || raw.startsWith(':') || raw.startsWith('retry')) continue;
          const frame = { id: null, event: null, data: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          events.push(frame);
        }
      }
    } catch {
      /* aborted */
    }
    closed = true;
  })();
  return { res, events, controller, close: () => controller.abort(), done, get closed() { return closed; } };
}

test('SSE: unauthenticated callers cannot open the stream', async () => {
  const app = await startApp({ container: fake() });
  try {
    const res = await fetch(`${app.base}/api/events`, { headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 401);
    const wrong = await fetch(`${app.base}/api/events`, { headers: { Authorization: 'Bearer nope-nope-nope-nope-nope-nope' } });
    assert.equal(wrong.status, 401);
    const viaUrl = await fetch(`${app.base}/api/events?token=${TOKEN}`);
    assert.equal(viaUrl.status, 401, 'the token is never accepted in the URL');
  } finally {
    await app.close();
  }
});

test('SSE: a connected client receives a snapshot first, then real events as they happen', async () => {
  const app = await startApp({ container: fake() });
  try {
    const stream = await openStream(app.base);
    assert.equal(stream.res.status, 200);
    assert.match(stream.res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(stream.res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.res.headers.get('x-accel-buffering'), 'no');

    await waitFor(() => stream.events.length >= 1, { what: 'service.connected' });
    const hello = stream.events[0];
    assert.equal(hello.event, 'service.connected');
    for (const key of ['browser', 'login', 'recorder', 'automation', 'screenshots', 'restart']) assert.ok(key in hello.data.data.snapshot, `snapshot.${key}`);
    assert.equal(hello.data.data.snapshot.automation.state, 'idle');

    await app.request('POST', '/api/browser/launch', { body: {} });
    await app.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } });
    await app.request('POST', '/api/login/confirm', { body: {} });
    await app.request('POST', '/api/recorder/start', { body: {} });
    await app.request('POST', '/api/recorder/stop', { body: {} });
    await waitFor(() => stream.events.some((e) => e.event === 'recording.stopped'), { what: 'recording.stopped' });

    const types = stream.events.map((e) => e.event);
    for (const expected of ['browser.starting', 'browser.ready', 'login.page_opened', 'login.waiting', 'login.confirmed', 'recording.started', 'recording.stopped']) {
      assert.ok(types.includes(expected), expected);
    }
    assert.ok(types.indexOf('browser.ready') < types.indexOf('login.page_opened'));
    assert.ok(types.indexOf('login.waiting') < types.indexOf('login.confirmed'));
    const ready = stream.events.find((e) => e.event === 'browser.ready').data;
    for (const field of ['timestamp', 'description', 'workflowId', 'workflowName', 'currentStep', 'totalSteps', 'completedSteps', 'failedSteps', 'progress', 'currentUrl']) assert.ok(field in ready, field);
    stream.close();
  } finally {
    await app.close();
  }
});

test('SSE: a full run delivers started -> step events -> completed with real progress numbers', async () => {
  const app = await startApp({ container: fake() });
  try {
    const stream = await openStream(app.base);
    await waitFor(() => stream.events.length >= 1);
    await app.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } });
    await app.request('POST', '/api/login/confirm', { body: {} });
    // The fake page has no DOM, so use a workflow whose steps are screenshot captures only.
    const wf = await app.request('POST', '/api/workflows', { body: { name: 'Shots', steps: [
      { name: 'First', action: 'capture_screenshot', wait: { condition: 'none' }, delay: 0 },
      { name: 'Second', action: 'capture_screenshot', wait: { condition: 'none' }, delay: 0 },
    ] } });
    const id = wf.json.data.workflow.id;
    const start = await app.request('POST', '/api/automation/start', { body: { workflowId: id } });
    assert.equal(start.status, 202);
    await waitFor(() => stream.events.some((e) => e.event === 'workflow.completed'), { what: 'workflow.completed', timeout: 15000 });

    const run = stream.events.filter((e) => /^(workflow|step|screenshot)\./.test(e.event));
    const order = run.map((e) => e.event);
    assert.equal(order[0], 'workflow.started');
    assert.equal(order.at(-1), 'workflow.completed');
    const completed = run.filter((e) => e.event === 'step.completed').map((e) => e.data);
    assert.deepEqual(completed.map((d) => d.completedSteps), [1, 2]);
    assert.deepEqual(completed.map((d) => d.progress), [50, 100]);
    assert.ok(completed.every((d) => d.workflowName === 'Shots' && d.totalSteps === 2));
    assert.equal(order.filter((e) => e === 'screenshot.saved').length, 2);
    assert.ok(run.some((e) => e.event === 'screenshot.capturing'));
    stream.close();
  } finally {
    await app.close();
  }
});

test('SSE: reconnecting with Last-Event-ID replays only the events that were missed', async () => {
  const app = await startApp({ container: fake() });
  try {
    const first = await openStream(app.base);
    await waitFor(() => first.events.length >= 1);
    await app.request('POST', '/api/browser/launch', { body: {} });
    await waitFor(() => first.events.some((e) => e.event === 'browser.ready'));
    const lastSeen = first.events.filter((e) => e.event === 'browser.ready').at(-1).id;
    first.close(); // the network drops

    await app.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } }); // happens while disconnected
    await app.request('POST', '/api/login/confirm', { body: {} });

    const second = await openStream(app.base, { lastEventId: lastSeen });
    await waitFor(() => second.events.some((e) => e.event === 'login.confirmed'), { what: 'replayed login.confirmed' });
    const types = second.events.map((e) => e.event);
    assert.equal(types[0], 'service.connected');
    assert.ok(types.includes('login.page_opened'), 'missed events are replayed');
    assert.ok(types.includes('login.confirmed'));
    assert.ok(!types.includes('browser.ready'), 'events seen before the drop are not repeated');
    assert.ok(second.events[0].data.data.replayed >= 2);
    second.close();
  } finally {
    await app.close();
  }
});

test('SSE: a client that reconnects after a service restart is told so and given a snapshot to resynchronise', async () => {
  const app = await startApp({ container: fake() });
  try {
    const stream = await openStream(app.base, { lastEventId: 'abcd1234:42' }); // id issued by a previous process
    await waitFor(() => stream.events.some((e) => e.event === 'service.restarted'), { what: 'service.restarted' });
    const types = stream.events.map((e) => e.event);
    assert.deepEqual(types.slice(0, 2), ['service.connected', 'service.restarted']);
    const restarted = stream.events[1].data;
    assert.match(restarted.description, /browser session/);
    assert.ok(stream.events[0].data.data.snapshot, 'snapshot lets the client redraw without extra requests');
    stream.close();
  } finally {
    await app.close();
  }
});

test('SSE: closing the browser mid-session emits browser.disconnected and session.expired', async () => {
  const launcher = createFakeLauncher();
  const app = await startApp({ container: { browser: { launcher, memoryProbe: () => ({ availableMB: 1000, limitMB: 2000 }) } } });
  try {
    const stream = await openStream(app.base);
    await waitFor(() => stream.events.length >= 1);
    await app.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } });
    await app.request('POST', '/api/login/confirm', { body: {} });
    launcher.last.kill();
    await waitFor(() => stream.events.some((e) => e.event === 'session.expired'), { what: 'session.expired' });
    const types = stream.events.map((e) => e.event);
    assert.ok(types.includes('browser.disconnected'));
    assert.ok(types.includes('session.expired'));
    stream.close();
  } finally {
    await app.close();
  }
});

test('SSE: a disconnecting client does not disturb the service or other clients', async () => {
  const app = await startApp({ container: fake() });
  try {
    const a = await openStream(app.base);
    const b = await openStream(app.base);
    await waitFor(() => a.events.length >= 1 && b.events.length >= 1);
    a.close();
    await sleep(50);
    await app.request('POST', '/api/browser/launch', { body: {} });
    await waitFor(() => b.events.some((e) => e.event === 'browser.ready'));
    await waitFor(() => app.services.events.clients.size === 1, { what: 'dead client to be removed' });
    assert.equal(app.services.events.clients.size, 1);
    b.close();
    await waitFor(() => app.services.events.clients.size === 0);
  } finally {
    await app.close();
  }
});

test('SSE: stream count is limited to protect the free instance', async () => {
  const app = await startApp({ env: { SSE_MAX_CLIENTS: '2' }, container: fake() });
  try {
    const a = await openStream(app.base);
    const b = await openStream(app.base);
    await waitFor(() => a.events.length >= 1 && b.events.length >= 1);
    const c = await fetch(`${app.base}/api/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(c.status, 429);
    assert.equal((await c.json()).error.code, 'too_many_event_streams');
    a.close();
    b.close();
  } finally {
    await app.close();
  }
});

// ---- restart simulation ---------------------------------------------------------------------------------

test('RESTART: a run that was in progress is reported as interrupted by the next process, and the browser session is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restart-int-'));
  try {
    // Process 1: start a run that blocks inside step one, then "crash" (we simply abandon it without a clean shutdown).
    const first = await startApp({ dataDir: dir, container: fake() });
    await first.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } });
    await first.request('POST', '/api/login/confirm', { body: {} });
    const wf = await first.request('POST', '/api/workflows', { body: { name: 'Long flow', steps: [
      { name: 'One', action: 'capture_screenshot', wait: { condition: 'none' }, delay: 0 },
      { name: 'Two', action: 'capture_screenshot', wait: { condition: 'none' }, delay: 30000 },
      { name: 'Three', action: 'capture_screenshot', wait: { condition: 'none' }, delay: 0 },
    ] } });
    await first.request('POST', '/api/automation/start', { body: { workflowId: wf.json.data.workflow.id } });
    await waitFor(async () => (await first.request('GET', '/api/automation/status')).json.data.run?.steps[1]?.status === 'running', { what: 'step two running' });
    await first.services.storage.flush();
    assert.ok(fs.existsSync(first.services.storage.activeRunFile));

    // A real crash kills the process instantly: nothing gets to react to it. Both processes live in this one Node
    // process, so freeze the disk exactly as it is at the moment of the "crash" and let process 2 start from that
    // snapshot. (If the abandoned process-1 loop were left running it would react to the closing browser and rewrite
    // the marker, which a dead process never would.)
    const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restart-crashed-'));
    fs.cpSync(dir, crashed, { recursive: true });
    await first.container.shutdown();
    await new Promise((resolve) => { first.server.close(resolve); first.server.closeAllConnections?.(); });

    // Process 2: a fresh container on the filesystem as the crash left it.
    const second = await startApp({ dataDir: crashed, container: fake() });
    try {
      second.services.automation.announceInterrupted();
      const status = (await second.request('GET', '/api/automation/status')).json.data;
      assert.equal(status.state, 'interrupted');
      assert.equal(status.interruptedRun.workflowName, 'Long flow');
      assert.equal(status.interruptedRun.status, 'interrupted');
      assert.match(status.interruptedRun.reason, /restarted/);
      assert.equal(status.run, null, 'run state itself is gone: nothing pretends the run survived');
      assert.equal(status.controls.resume, false);

      const full = (await second.request('GET', '/api/status')).json.data;
      assert.equal(full.browser.running, false, 'the browser session did not survive');
      assert.equal(full.previousRun.workflowName, 'Long flow');
      assert.notEqual(full.restartId, first.services.events.restartId);
      assert.equal(full.storage.previousInstanceDetected, true);

      assert.equal((await second.request('GET', '/api/login/status')).json.data.state, 'idle', 'login must be repeated');
      const start = await second.request('POST', '/api/automation/start', { body: { workflowId: wf.json.data.workflow.id } });
      assert.equal(start.status, 409);
      assert.match(start.json.error.code, /browser_not_running|login_required/);

      const stream = await openStream(second.base);
      await waitFor(() => stream.events.length >= 1);
      assert.equal(stream.events[0].data.data.snapshot.restart.interruptedRun.workflowName, 'Long flow', 'a late-connecting dashboard still learns about it');
      stream.close();

      await second.request('POST', '/api/automation/stop', { body: {} });
      assert.equal((await second.request('GET', '/api/automation/status')).json.data.state, 'idle', 'acknowledged');
    } finally {
      await second.close();
      fs.rmSync(crashed, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RESTART: workflows and screenshots on a surviving filesystem are recovered, and flagged as recovered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restart-data-'));
  try {
    const first = await startApp({ dataDir: dir, container: fake() });
    await first.request('POST', '/api/browser/launch', { body: {} });
    const wf = await first.request('POST', '/api/workflows', { body: { name: 'Keep me', steps: [{ name: 'S', action: 'capture_screenshot' }] } });
    const shot = await first.request('POST', '/api/screenshots', { body: {} });
    assert.equal(shot.status, 201);
    await first.container.shutdown();
    await new Promise((resolve) => { first.server.close(resolve); first.server.closeAllConnections?.(); });

    const second = await startApp({ dataDir: dir, container: fake() });
    try {
      const workflows = (await second.request('GET', '/api/workflows')).json.data.workflows;
      assert.equal(workflows[0].name, 'Keep me');
      assert.equal(workflows[0].id, wf.json.data.workflow.id);
      const shots = (await second.request('GET', '/api/screenshots')).json.data;
      assert.equal(shots.total, 1);
      assert.equal(shots.items[0].recoveredFromPreviousProcess, true);
      const dl = await second.request('GET', `/api/screenshots/${shots.items[0].id}/download`, { raw: true });
      assert.equal(dl.status, 200);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RESTART: on a fresh filesystem (Render redeploy) everything is empty and the service says so honestly', async () => {
  const app = await startApp({ container: fake() });
  try {
    assert.deepEqual((await app.request('GET', '/api/workflows')).json.data.workflows, []);
    const shots = (await app.request('GET', '/api/screenshots')).json.data;
    assert.equal(shots.total, 0);
    assert.equal(shots.storage.temporary, true);
    const status = (await app.request('GET', '/api/status')).json.data;
    assert.equal(status.storage.persistent, false);
    assert.equal(status.storage.temporary, true);
    assert.match(status.storage.note, /may be lost/);
    assert.equal(status.previousRun, null);
    const gone = await app.request('GET', '/api/screenshots/3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11');
    assert.equal(gone.status, 404);
    assert.match(gone.json.error.message, /restarts or sleeps/);
    const wf = await app.request('GET', '/api/workflows/3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11');
    assert.equal(wf.status, 404);
    assert.match(wf.json.error.message, /import them again/);
  } finally {
    await app.close();
  }
});
