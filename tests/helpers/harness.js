'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv } = require('../../src/config/settings');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');

const TOKEN = 'test-token-0123456789abcdef0123456789';
const DASHBOARD = 'https://dash-user.github.io';

/** Environment source for tests, with overrides. Always points at its own temp directory. */
function envSource(overrides = {}) {
  return {
    NODE_ENV: 'test',
    API_TOKEN: TOKEN,
    DASHBOARD_ORIGIN: `${DASHBOARD}/some/project/path`,
    PORT: '0',
    MIN_FREE_MEMORY_MB: '0',
    ADDITIONAL_PAGE_DELAY: '100',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/**
 * Start a real HTTP server on a random port with a fresh container and temp data directory.
 * `containerOverrides` may inject a fake browser launcher or memory probe (see createContainer).
 */
async function startApp({ env: envOverrides = {}, container: containerOverrides, dataDir, init = true } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
  const env = createEnv(envSource({ DATA_DIR: dir, ...envOverrides }));
  const container = createContainer(env, containerOverrides);
  if (init) await container.init();
  const app = createApp(container);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  container.services.fixture.setPort(port);
  const base = `http://127.0.0.1:${port}`;

  /** fetch with the bearer token by default. Pass `token: null` for none. */
  async function request(method, urlPath, { body, token = TOKEN, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const res = await fetch(base + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function close() {
    await container.shutdown();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { env, container, services: container.services, server, base, port, dir, request, close, TOKEN };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

module.exports = { startApp, envSource, TOKEN, DASHBOARD, sleep, waitFor };
