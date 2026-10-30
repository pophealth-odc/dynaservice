'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { nowIso } = require('../utils/date-utils');
const { err } = require('../errors');

/** Every event type the service can publish. Clients may rely on this list. */
const EVENT_TYPES = Object.freeze([
  'service.connected',
  'service.restarted',
  'service.error',
  'browser.starting',
  'browser.ready',
  'browser.disconnected',
  'browser.page_crashed',
  'browser.page_recovered',
  'login.page_opened',
  'login.waiting',
  'login.confirmed',
  'login.cancelled',
  'session.expired',
  'recording.started',
  'element.selected',
  'recording.stopped',
  'workflow.started',
  'workflow.paused',
  'workflow.resumed',
  'workflow.stopped',
  'workflow.completed',
  'workflow.interrupted',
  'step.started',
  'step.waiting_for_element',
  'step.waiting_for_navigation',
  'step.completed',
  'step.failed',
  'step.skipped',
  'screenshot.capturing',
  'screenshot.saved',
  'screenshot.transferred',
  'screenshot.evicted',
]);

const BASE_FIELDS = {
  workflowId: null,
  workflowName: null,
  runId: null,
  currentStep: null,
  totalSteps: null,
  completedSteps: null,
  failedSteps: null,
  progress: null,
  currentUrl: null,
};

/**
 * Publishes real execution events to Server-Sent-Events clients and keeps a short replay buffer so a
 * client that reconnects (network drop, Render sleep) can catch up on what it missed.
 */
class EventService extends EventEmitter {
  constructor(env, { bufferSize = 300, heartbeatMs = 25000 } = {}) {
    super();
    this.env = env;
    this.restartId = crypto.randomBytes(4).toString('hex');
    this.startedAt = nowIso();
    this.seq = 0;
    this.bufferSize = bufferSize;
    this.heartbeatMs = heartbeatMs;
    this.buffer = [];
    this.clients = new Set();
    this.contextProvider = () => ({});
    this.snapshotProvider = () => ({});
    this.heartbeat = null;
  }

  /** Supplies the live run/browser fields merged into every event (progress, step, URL ...). */
  setContextProvider(fn) {
    this.contextProvider = fn;
  }

  setSnapshotProvider(fn) {
    this.snapshotProvider = fn;
  }

  emitEvent(type, description, extra = {}) {
    let context = {};
    try {
      context = this.contextProvider() || {};
    } catch {
      context = {};
    }
    this.seq += 1;
    const event = {
      id: `${this.restartId}:${this.seq}`,
      type,
      timestamp: nowIso(),
      description,
      ...BASE_FIELDS,
      ...context,
      ...extra,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const client of [...this.clients]) this._send(client, event);
    this.emit('event', event);
    return event;
  }

  _frame(event) {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  _send(client, event) {
    try {
      if (client.res.writableLength > 1024 * 1024) {
        // The client is not reading; drop it rather than buffering without bound.
        this._drop(client);
        return;
      }
      client.res.write(this._frame(event));
    } catch {
      this._drop(client);
    }
  }

  _drop(client) {
    this.clients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already closed */
    }
    if (this.clients.size === 0) this._stopHeartbeat();
  }

  _startHeartbeat() {
    if (this.heartbeat) return;
    // A comment line every ~25s stops intermediaries from closing an idle stream. It does not
    // generate service activity and is not a way to keep a free Render instance awake.
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        try {
          client.res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          this._drop(client);
        }
      }
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Attach an HTTP response as an SSE client.
   * `lastEventId` is the `id` of the last event the client saw (`<restartId>:<seq>`).
   */
  addClient(req, res, { lastEventId } = {}) {
    if (this.clients.size >= this.env.sseMaxClients) {
      throw err.tooMany('too_many_event_streams', `Only ${this.env.sseMaxClients} event streams are allowed at once.`);
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const client = { res };
    this.clients.add(client);
    this._startHeartbeat();
    const cleanup = () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this._stopHeartbeat();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    // Reconnection: replay what was missed if the previous id belongs to this process,
    // otherwise tell the client the service restarted and let it resynchronise from the snapshot.
    let restarted = false;
    let replay = [];
    if (lastEventId) {
      const [prevRestart, prevSeq] = String(lastEventId).split(':');
      if (prevRestart === this.restartId && Number.isInteger(Number(prevSeq))) {
        replay = this.buffer.filter((e) => Number(e.id.split(':')[1]) > Number(prevSeq));
      } else {
        restarted = true;
      }
    }

    let snapshot = {};
    try {
      snapshot = this.snapshotProvider() || {};
    } catch {
      snapshot = {};
    }
    // Direct, unbuffered frames: these two are addressed to this client only and are not replayed.
    this._writeDirect(client, 'service.connected', 'Event stream connected.', {
      data: { restartId: this.restartId, startedAt: this.startedAt, replayed: replay.length, snapshot },
    });
    if (restarted) {
      this._writeDirect(client, 'service.restarted', 'The service restarted since this client last connected; browser session and any running automation were lost.', {
        data: { restartId: this.restartId, previousEventId: lastEventId },
      });
    }
    for (const event of replay) this._send(client, event);
    return client;
  }

  _writeDirect(client, type, description, extra) {
    const event = { id: `${this.restartId}:0`, type, timestamp: nowIso(), description, ...BASE_FIELDS, ...extra };
    try {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      this._drop(client);
    }
    return event;
  }

  stats() {
    return { clients: this.clients.size, lastEventId: `${this.restartId}:${this.seq}`, buffered: this.buffer.length };
  }

  closeAll() {
    this._stopHeartbeat();
    for (const client of [...this.clients]) this._drop(client);
  }
}

module.exports = { EventService, EVENT_TYPES };
