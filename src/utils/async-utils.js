'use strict';

class AbortError extends Error {
  constructor(reason = 'aborted') {
    super(`Operation aborted (${reason})`);
    this.name = 'AbortError';
    this.reason = reason;
  }
}

const reasonOf = (signal) => (typeof signal?.reason === 'string' ? signal.reason : signal?.reason?.reason || 'aborted');

/** Sleep that rejects with AbortError as soon as the signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError(reasonOf(signal)));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError(reasonOf(signal)));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve with `promise`, but reject immediately when `signal` aborts.
 * The underlying promise keeps running (Playwright calls cannot be cancelled), so its late
 * rejection is swallowed to avoid unhandled-rejection noise.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new AbortError(reasonOf(signal)));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(new AbortError(reasonOf(signal)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Resolve with `promise`, or with `fallback` if it does not settle within `ms` (never rejects on timeout). */
function withTimeout(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Serialises async work: callers run one at a time, in arrival order. */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
    this.pending = 0;
  }

  async runExclusive(fn) {
    this.pending += 1;
    const previous = this._tail;
    let release;
    this._tail = new Promise((r) => {
      release = r;
    });
    try {
      await previous;
      return await fn();
    } finally {
      this.pending -= 1;
      release();
    }
  }

  get locked() {
    return this.pending > 0;
  }
}

/** A promise that can be settled from outside. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

module.exports = { AbortError, sleep, raceAbort, withTimeout, Mutex, deferred };
