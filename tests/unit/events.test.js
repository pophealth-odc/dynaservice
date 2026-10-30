'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EventService, EVENT_TYPES } = require('../../src/services/event.service');

const env = { sseMaxClients: 3 };

/** A fake HTTP request/response pair that records the SSE frames written to it. */
function fakeClient() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.chunks = [];
  res.headers = {};
  res.writableLength = 0;
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (h) => { Object.assign(res.headers, h); return res; };
  res.flushHeaders = () => {};
  res.write = (s) => { res.chunks.push(s); return true; };
  res.end = () => { res.ended = true; };
  res.frames = () => res.chunks.join('').split('\n\n').filter((f) => f.trim() && !f.startsWith(':') && !f.startsWith('retry')).map((raw) => {
    const f = { id: null, event: null, data: null };
    for (const line of raw.split('\n')) {
      if (line.startsWith('id: ')) f.id = line.slice(4);
      else if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
    }
    return f;
  });
  return { req, res };
}

test('the event catalogue covers every event the specification lists', () => {
  const required = [
    'service.connected', 'service.restarted', 'browser.starting', 'browser.ready', 'login.page_opened', 'login.waiting', 'login.confirmed',
    'recording.started', 'element.selected', 'recording.stopped', 'workflow.started', 'step.started', 'step.waiting_for_element',
    'step.waiting_for_navigation', 'screenshot.capturing', 'screenshot.saved', 'screenshot.transferred', 'step.completed', 'step.failed',
    'workflow.paused', 'workflow.resumed', 'workflow.stopped', 'workflow.completed', 'browser.disconnected', 'session.expired', 'service.error',
  ];
  for (const type of required) assert.ok(EVENT_TYPES.includes(type), type);
});

test('events carry the documented fields and merge live run context', () => {
  const svc = new EventService(env);
  svc.setContextProvider(() => ({ workflowId: 'w1', workflowName: 'Flow', currentStep: { number: 2, name: 'Two' }, totalSteps: 3, completedSteps: 1, failedSteps: 0, progress: 33, currentUrl: 'https://x/' }));
  const e = svc.emitEvent('step.started', 'Step 2 started.');
  for (const key of ['id', 'type', 'timestamp', 'description', 'workflowId', 'workflowName', 'currentStep', 'totalSteps', 'completedSteps', 'failedSteps', 'progress', 'currentUrl']) {
    assert.ok(key in e, key);
  }
  assert.equal(e.workflowName, 'Flow');
  assert.equal(e.progress, 33);
  assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
  assert.match(e.id, new RegExp(`^${svc.restartId}:\\d+$`));
});

test('explicit event fields override the context; a failing context provider never breaks emit', () => {
  const svc = new EventService(env);
  svc.setContextProvider(() => ({ workflowName: 'From context' }));
  assert.equal(svc.emitEvent('x', 'd', { workflowName: 'Explicit' }).workflowName, 'Explicit');
  svc.setContextProvider(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => svc.emitEvent('x', 'd'));
});

test('a connecting client gets service.connected with a snapshot, in SSE format', () => {
  const svc = new EventService(env);
  svc.setSnapshotProvider(() => ({ automation: { state: 'idle' } }));
  const { req, res } = fakeClient();
  svc.addClient(req, res, {});
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  const [first] = res.frames();
  assert.equal(first.event, 'service.connected');
  assert.equal(first.data.data.snapshot.automation.state, 'idle');
  assert.equal(first.data.data.restartId, svc.restartId);
  svc.closeAll();
});

test('live events are delivered to every connected client', () => {
  const svc = new EventService(env);
  const a = fakeClient();
  const b = fakeClient();
  svc.addClient(a.req, a.res, {});
  svc.addClient(b.req, b.res, {});
  svc.emitEvent('step.completed', 'done');
  for (const c of [a, b]) {
    const last = c.res.frames().at(-1);
    assert.equal(last.event, 'step.completed');
    assert.equal(last.id, last.data.id);
  }
  svc.closeAll();
});

test('reconnecting with Last-Event-ID replays only the missed events', () => {
  const svc = new EventService(env);
  const e1 = svc.emitEvent('step.started', 'one');
  svc.emitEvent('step.completed', 'two');
  svc.emitEvent('workflow.completed', 'three');
  const { req, res } = fakeClient();
  svc.addClient(req, res, { lastEventId: e1.id });
  const types = res.frames().map((f) => f.event);
  assert.deepEqual(types, ['service.connected', 'step.completed', 'workflow.completed']);
  assert.equal(res.frames()[0].data.data.replayed, 2);
  svc.closeAll();
});

test('a Last-Event-ID from a previous process yields service.restarted instead of a bogus replay', () => {
  const svc = new EventService(env);
  svc.emitEvent('step.started', 'one');
  const { req, res } = fakeClient();
  svc.addClient(req, res, { lastEventId: 'deadbeef:57' });
  const types = res.frames().map((f) => f.event);
  assert.deepEqual(types, ['service.connected', 'service.restarted']);
  assert.match(res.frames()[1].data.description, /restarted/);
  svc.closeAll();
});

test('the replay buffer is bounded', () => {
  const svc = new EventService(env, { bufferSize: 5 });
  for (let i = 0; i < 20; i += 1) svc.emitEvent('x', String(i));
  assert.equal(svc.buffer.length, 5);
  assert.equal(svc.buffer[0].description, '15');
});

test('the number of concurrent streams is limited', () => {
  const svc = new EventService(env);
  for (let i = 0; i < 3; i += 1) { const c = fakeClient(); svc.addClient(c.req, c.res, {}); }
  const extra = fakeClient();
  assert.throws(() => svc.addClient(extra.req, extra.res, {}), (e) => e.code === 'too_many_event_streams' && e.status === 429);
  svc.closeAll();
});

test('a client that disconnects is removed and the heartbeat stops with the last one', () => {
  const svc = new EventService(env, { heartbeatMs: 10_000 });
  const c = fakeClient();
  svc.addClient(c.req, c.res, {});
  assert.equal(svc.clients.size, 1);
  assert.ok(svc.heartbeat);
  c.req.emit('close');
  assert.equal(svc.clients.size, 0);
  assert.equal(svc.heartbeat, null);
});

test('a client that stops reading is dropped instead of buffering without bound', () => {
  const svc = new EventService(env);
  const c = fakeClient();
  svc.addClient(c.req, c.res, {});
  c.res.writableLength = 5 * 1024 * 1024;
  svc.emitEvent('x', 'y');
  assert.equal(svc.clients.size, 0);
  assert.equal(c.res.ended, true);
});

test('a write error drops only that client', () => {
  const svc = new EventService(env);
  const bad = fakeClient();
  const good = fakeClient();
  svc.addClient(bad.req, bad.res, {});
  svc.addClient(good.req, good.res, {});
  bad.res.write = () => { throw new Error('socket closed'); };
  svc.emitEvent('x', 'y');
  assert.equal(svc.clients.size, 1);
  assert.equal(good.res.frames().at(-1).event, 'x');
  svc.closeAll();
});
