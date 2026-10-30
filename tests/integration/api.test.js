'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, TOKEN, DASHBOARD } = require('../helpers/harness');
const { createFakeLauncher } = require('../helpers/fake-browser');

const fakeBrowserOverrides = (launcher) => ({ browser: { launcher, memoryProbe: () => ({ availableMB: 1000, limitMB: 2000 }) } });
let app;

test.before(async () => {
  app = await startApp({ container: fakeBrowserOverrides(createFakeLauncher()) });
});
test.after(async () => app.close());

const ok = (res, status = 200) => {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(res.json.ok, true);
  return res.json.data;
};
const fail = (res, status, code) => {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(res.json.ok, false);
  if (code) assert.equal(res.json.error.code, code);
  return res.json.error;
};

// ---- health ---------------------------------------------------------------------------------------------

test('GET /api/status needs no token and reveals only liveness facts without one', async () => {
  const data = ok(await app.request('GET', '/api/status', { token: null }));
  assert.equal(data.status, 'ok');
  assert.equal(data.authenticated, false);
  assert.ok(data.version && typeof data.uptimeSeconds === 'number' && data.restartId);
  for (const secret of ['memory', 'currentUrl', 'browser', 'sessionId', 'storage', 'render', 'login']) assert.ok(!(secret in data), `${secret} must not be public`);
});

test('GET /api/status with the token returns the full picture the specification lists', async () => {
  const data = ok(await app.request('GET', '/api/status'));
  assert.equal(data.authenticated, true);
  for (const key of ['status', 'version', 'uptimeSeconds', 'browser', 'currentUrl', 'currentWorkflow', 'currentWorkflowStatus', 'memory', 'sessionId', 'restartId']) {
    assert.ok(key in data, key);
  }
  assert.equal(data.browser.running, false);
  assert.equal(data.currentWorkflowStatus, 'idle');
  for (const key of ['limitMB', 'usedMB', 'rssMB']) assert.equal(typeof data.memory[key], 'number', key);
});

test('the API token never appears in any status or error response', async () => {
  const bodies = [
    (await app.request('GET', '/api/status')).text,
    (await app.request('GET', '/api/settings')).text,
    (await app.request('GET', '/api/browser/status', { token: 'wrong' })).text,
    (await app.request('GET', '/api/nope')).text,
    (await app.request('POST', '/api/workflows', { body: '{bad json' })).text,
  ];
  for (const text of bodies) assert.ok(!text.includes(TOKEN));
});

// ---- authentication -------------------------------------------------------------------------------------

const PROTECTED = [
  ['GET', '/api/browser/status'], ['POST', '/api/browser/launch'], ['POST', '/api/browser/close'], ['POST', '/api/browser/open-url'],
  ['GET', '/api/browser/screenshot'], ['POST', '/api/browser/click'], ['POST', '/api/browser/hover'], ['POST', '/api/browser/type'],
  ['POST', '/api/browser/keypress'], ['POST', '/api/browser/scroll'], ['POST', '/api/browser/refresh'],
  ['POST', '/api/login/open'], ['POST', '/api/login/confirm'], ['POST', '/api/login/cancel'], ['GET', '/api/login/status'],
  ['POST', '/api/recorder/start'], ['POST', '/api/recorder/stop'], ['GET', '/api/recorder/status'], ['GET', '/api/recorder/selected-element'],
  ['POST', '/api/recorder/select-element'], ['POST', '/api/recorder/clear-selection'],
  ['GET', '/api/workflows'], ['POST', '/api/workflows'], ['POST', '/api/workflows/import'], ['GET', `/api/workflows/${crypto.randomUUID()}`],
  ['PUT', `/api/workflows/${crypto.randomUUID()}`], ['DELETE', `/api/workflows/${crypto.randomUUID()}`], ['GET', `/api/workflows/${crypto.randomUUID()}/export`],
  ['POST', '/api/automation/start'], ['POST', '/api/automation/pause'], ['POST', '/api/automation/resume'], ['POST', '/api/automation/stop'],
  ['POST', '/api/automation/restart'], ['POST', '/api/automation/execute-step'], ['POST', '/api/automation/skip-step'], ['POST', '/api/automation/test-step'],
  ['GET', '/api/automation/status'],
  ['GET', '/api/screenshots'], ['POST', '/api/screenshots'], ['GET', `/api/screenshots/${crypto.randomUUID()}`], ['GET', `/api/screenshots/${crypto.randomUUID()}/download`],
  ['DELETE', `/api/screenshots/${crypto.randomUUID()}`], ['DELETE', '/api/screenshots'], ['GET', '/api/screenshots/export'],
  ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/events'],
];

// The auth-failure limiter (30 failures / 15 min per address) is part of the product, so these bulk tests each run on
// their own app instance instead of exhausting the budget of the shared one that the rest of the file relies on.
async function withFreshApp(fn) {
  const fresh = await startApp({ env: { RATE_LIMIT_PER_MINUTE: '5000' }, container: fakeBrowserOverrides(createFakeLauncher()) });
  try {
    return await fn(fresh);
  } finally {
    await fresh.close();
  }
}
const bodyFor = (method) => (method === 'GET' || method === 'DELETE' ? undefined : {});

test('every protected endpoint rejects a missing token with 401 and a challenge header', async () => {
  // Split across instances so no single address crosses the brute-force limit while testing 47 endpoints.
  const half = Math.ceil(PROTECTED.length / 2);
  for (const slice of [PROTECTED.slice(0, half), PROTECTED.slice(half)]) {
    await withFreshApp(async (a) => {
      for (const [method, url] of slice) {
        const res = await a.request(method, url, { token: null, body: bodyFor(method) });
        assert.equal(res.status, 401, `${method} ${url}`);
        assert.equal(res.json.error.code, 'missing_token', `${method} ${url}`);
        assert.match(res.headers.get('www-authenticate') || '', /Bearer/);
      }
    });
  }
});

test('every protected endpoint rejects a wrong token with 401', async () => {
  const half = Math.ceil(PROTECTED.length / 2);
  for (const slice of [PROTECTED.slice(0, half), PROTECTED.slice(half)]) {
    await withFreshApp(async (a) => {
      for (const [method, url] of slice) {
        const res = await a.request(method, url, { token: 'not-the-right-token-at-all-000000', body: bodyFor(method) });
        assert.equal(res.status, 401, `${method} ${url}`);
        assert.equal(res.json.error.code, 'invalid_token', `${method} ${url}`);
      }
    });
  }
});

test('the token is accepted only from the Authorization header, never the URL or body', async () => {
  await withFreshApp(async (a) => {
    assert.equal((await a.request('GET', `/api/browser/status?token=${TOKEN}`, { token: null })).status, 401);
    assert.equal((await a.request('GET', `/api/browser/status?access_token=${TOKEN}`, { token: null })).status, 401);
    assert.equal((await a.request('POST', '/api/login/cancel', { token: null, body: { token: TOKEN } })).status, 401);
    assert.equal((await a.request('GET', '/api/browser/status', { token: null, headers: { Authorization: `Basic ${TOKEN}` } })).status, 401);
    assert.equal((await a.request('GET', '/api/browser/status', { token: null, headers: { 'X-API-Key': TOKEN } })).status, 401);
  });
});

test('repeated authentication failures are rate limited (brute-force protection)', async () => {
  const limited = await startApp({ container: fakeBrowserOverrides(createFakeLauncher()) });
  try {
    let tooMany = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await limited.request('GET', '/api/browser/status', { token: 'guess-guess-guess-guess-guess-0' });
      if (res.status === 429) { tooMany = res; break; }
    }
    assert.ok(tooMany, 'brute forcing is eventually throttled');
    assert.equal(tooMany.json.error.code, 'too_many_auth_failures');
  } finally {
    await limited.close();
  }
});

// ---- CORS -----------------------------------------------------------------------------------------------

test('CORS: the configured dashboard origin is allowed, including project-path GitHub Pages URLs', async () => {
  const res = await app.request('GET', '/api/status', { headers: { Origin: DASHBOARD } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), DASHBOARD);
  assert.match(res.headers.get('access-control-expose-headers') || '', /Content-Disposition/);
  assert.match(res.headers.get('vary') || '', /Origin/);
  assert.equal(res.headers.get('access-control-allow-credentials'), null, 'cookies are never used');
});

test('CORS: preflight from the dashboard is answered; from a stranger it is refused with no CORS headers', async () => {
  const pre = await app.request('OPTIONS', '/api/workflows', { token: null, headers: { Origin: DASHBOARD, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), DASHBOARD);
  assert.match(pre.headers.get('access-control-allow-headers') || '', /Authorization/i);
  assert.match(pre.headers.get('access-control-allow-methods') || '', /DELETE/);

  const bad = await app.request('OPTIONS', '/api/workflows', { token: null, headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('CORS: foreign, look-alike and "null" origins are refused even with a valid token', async () => {
  for (const origin of ['https://evil.example', 'https://dash-user.github.io.evil.example', 'http://dash-user.github.io', 'https://other-user.github.io', 'null']) {
    const res = await app.request('GET', '/api/status', { headers: { Origin: origin } });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.error.code, 'origin_not_allowed');
    assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
  }
});

test('CORS: same-origin requests (the built-in test console) work without CORS headers', async () => {
  const res = await app.request('GET', '/api/status', { headers: { Origin: app.base } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS: requests with no Origin (curl, server-side) are unaffected', async () => {
  assert.equal((await app.request('GET', '/api/status')).status, 200);
});

// ---- validation & error handling -----------------------------------------------------------------------

test('errors use one consistent envelope with a request id', async () => {
  const res = await app.request('GET', '/api/workflows/not-a-uuid');
  const error = fail(res, 400, 'invalid_id');
  assert.ok(error.message && error.status === 400 && error.requestId);
  assert.equal(res.headers.get('x-request-id'), error.requestId);
});

test('malformed JSON, wrong content type, unknown fields and bad types are rejected clearly', async () => {
  fail(await app.request('POST', '/api/workflows', { body: '{bad json' }), 400, 'invalid_json');
  fail(await app.request('POST', '/api/workflows', { body: 'name=x', headers: { 'Content-Type': 'text/plain' } }), 400, 'unsupported_media_type');
  fail(await app.request('POST', '/api/browser/click', { body: { x: 'a', y: 1 } }), 422, 'invalid_request');
  fail(await app.request('POST', '/api/browser/click', { body: { x: 1, y: 1, extra: true } }), 422, 'invalid_request');
  fail(await app.request('POST', '/api/browser/click', { body: [] }), 422, 'invalid_body');
  const err = fail(await app.request('POST', '/api/browser/open-url', { body: {} }), 422, 'invalid_request');
  assert.ok(err.details.problems.some((p) => p.path === 'url'));
});

test('request bodies over the size limit are rejected with 413', async () => {
  fail(await app.request('POST', '/api/workflows/import', { body: { name: 'big', description: 'x'.repeat(700 * 1024) } }), 413, 'payload_too_large');
});

test('unknown routes return a JSON 404, not an HTML page or a stack trace', async () => {
  const res = await app.request('GET', '/api/does/not/exist');
  fail(res, 404, 'route_not_found');
  assert.ok(!/at .*\.js:\d+/.test(res.text));
});

test('query parameters are validated', async () => {
  fail(await app.request('GET', '/api/screenshots?limit=abc'), 422, 'invalid_query');
  fail(await app.request('GET', '/api/screenshots?bogus=1'), 422, 'invalid_query');
  fail(await app.request('GET', '/api/browser/screenshot?format=gif'), 422, 'invalid_query');
});

test('security headers are present on API responses', async () => {
  const res = await app.request('GET', '/api/status');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
});

// ---- browser (fake launcher) ---------------------------------------------------------------------------

test('browser lifecycle: launch, idempotent launch, status, close', async () => {
  const before = ok(await app.request('GET', '/api/browser/status'));
  assert.equal(before.connected, false);
  assert.equal(before.state, 'closed');

  const launched = ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  assert.equal(launched.connected, true);
  assert.equal(launched.alreadyRunning, false);
  assert.ok(launched.sessionId);
  assert.equal(launched.viewport.width, 1920);
  assert.equal(launched.viewport.height, 1080);

  const again = ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.sessionId, launched.sessionId);

  const status = ok(await app.request('GET', '/api/status'));
  assert.equal(status.browser.running, true);
  assert.equal(status.sessionId, launched.sessionId);

  const closed = ok(await app.request('POST', '/api/browser/close', { body: {} }));
  assert.equal(closed.wasRunning, true);
  assert.equal(ok(await app.request('GET', '/api/browser/status')).connected, false);
  assert.equal(ok(await app.request('POST', '/api/browser/close', { body: {} })).wasRunning, false, 'closing twice is harmless');
});

test('browser endpoints that need a browser say so plainly when it is not running', async () => {
  for (const [method, url, body] of [['POST', '/api/browser/open-url', { url: 'https://example.com/' }], ['POST', '/api/browser/click', { x: 1, y: 1 }], ['POST', '/api/browser/type', { text: 'a' }], ['POST', '/api/browser/keypress', { key: 'Enter' }], ['POST', '/api/browser/scroll', { deltaY: 10 }], ['POST', '/api/browser/refresh', {}], ['GET', '/api/browser/screenshot'], ['POST', '/api/screenshots', {}], ['POST', '/api/recorder/start', {}]]) {
    const error = fail(await app.request(method, url, { body }), 409, 'browser_not_running');
    assert.ok(error.hint);
  }
});

test('open-url validates the target and refuses dangerous destinations', async () => {
  ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'http://127.0.0.1:22/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'https://user:pw@example.com/', 'not a url']) {
    const res = await app.request('POST', '/api/browser/open-url', { body: { url } });
    assert.equal(res.status, 400, url);
    assert.match(res.json.error.code, /^(invalid_url|invalid_url_scheme|url_not_allowed)$/, url);
  }
  const good = ok(await app.request('POST', '/api/browser/open-url', { body: { url: 'https://example.com/path?token=secret123' } }));
  assert.ok(!good.url.includes('secret123'), 'sensitive query values are redacted in responses');
});

test('remote interaction: coordinates are validated and typed text is never echoed back', async () => {
  ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  fail(await app.request('POST', '/api/browser/click', { body: { x: -5, y: 10 } }), 422);
  fail(await app.request('POST', '/api/browser/click', { body: { x: 5000, y: 10 } }), 422, 'coordinates_out_of_range');
  const clicked = ok(await app.request('POST', '/api/browser/click', { body: { x: 100.5, y: 200 } }));
  assert.equal(clicked.clicked.x, 100.5);

  const secret = 'SuperSecretPassword!9';
  const typed = await app.request('POST', '/api/browser/type', { body: { text: secret, pressEnter: true } });
  assert.equal(ok(typed).typedCharacters, secret.length);
  assert.ok(!typed.text.includes(secret), 'the response does not echo the text');
  fail(await app.request('POST', '/api/browser/type', { body: { text: '' } }), 422);
  fail(await app.request('POST', '/api/browser/type', { body: { text: 'x'.repeat(2001) } }), 422);

  ok(await app.request('POST', '/api/browser/keypress', { body: { key: 'Enter' } }));
  ok(await app.request('POST', '/api/browser/keypress', { body: { key: 'Control+A' } }));
  fail(await app.request('POST', '/api/browser/keypress', { body: { key: 'Bogus' } }), 422, 'invalid_key');
  fail(await app.request('POST', '/api/browser/keypress', { body: { key: 'Evil+A' } }), 422, 'invalid_key');
  ok(await app.request('POST', '/api/browser/scroll', { body: { deltaY: 400 } }));
  fail(await app.request('POST', '/api/browser/scroll', { body: {} }), 422, 'invalid_scroll');
  ok(await app.request('POST', '/api/browser/refresh', { body: {} }));
  ok(await app.request('POST', '/api/browser/close', { body: {} }));
});

test('the live view returns an image with viewport headers, or JSON with base64', async () => {
  ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  const raw = await app.request('GET', '/api/browser/screenshot', { raw: true });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /^image\//);
  assert.equal(raw.headers.get('x-viewport-width'), '1920');
  assert.equal(raw.headers.get('x-viewport-height'), '1080');
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.ok((await raw.arrayBuffer()).byteLength > 0);
  const b64 = ok(await app.request('GET', '/api/browser/screenshot?encoding=base64&format=png'));
  assert.equal(b64.mimeType, 'image/png');
  assert.ok(Buffer.from(b64.image, 'base64').length > 0);
  assert.deepEqual(b64.viewport, { width: 1920, height: 1080 });
  ok(await app.request('POST', '/api/browser/close', { body: {} }));
});

test('browser launch failures are reported without crashing the service', async () => {
  const launcher = createFakeLauncher({ fail: 'Failed to launch: spawn ENOMEM' });
  const broken = await startApp({ container: fakeBrowserOverrides(launcher) });
  try {
    const error = fail(await broken.request('POST', '/api/browser/launch', { body: {} }), 500, 'insufficient_memory');
    assert.ok(error.hint);
    assert.equal(ok(await broken.request('GET', '/api/status')).browser.running, false);
    launcher.failWith = 'Browser exploded';
    fail(await broken.request('POST', '/api/browser/launch', { body: {} }), 500, 'browser_launch_failed');
    launcher.failWith = null;
    ok(await broken.request('POST', '/api/browser/launch', { body: {} }));
  } finally {
    await broken.close();
  }
});

test('launch is refused with 503 when there is not enough free memory', async () => {
  const lowMem = await startApp({
    env: { MIN_FREE_MEMORY_MB: '300' },
    container: { browser: { launcher: createFakeLauncher(), memoryProbe: () => ({ availableMB: 80, limitMB: 512 }) } },
  });
  try {
    const error = fail(await lowMem.request('POST', '/api/browser/launch', { body: {} }), 503, 'insufficient_memory');
    assert.equal(error.details.availableMB, 80);
    assert.equal(lowMem.container.services.browser.isReady, false);
  } finally {
    await lowMem.close();
  }
});

test('a Chromium crash is detected: the session is reported lost and login must be repeated', async () => {
  const launcher = createFakeLauncher();
  const crashy = await startApp({ container: fakeBrowserOverrides(launcher) });
  try {
    ok(await crashy.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } }));
    ok(await crashy.request('POST', '/api/login/confirm', { body: {} }));
    assert.equal(ok(await crashy.request('GET', '/api/login/status')).eligibleForAutomation, true);

    launcher.last.kill(); // Chromium dies underneath the service
    const status = ok(await crashy.request('GET', '/api/status'));
    assert.equal(status.browser.running, false);
    assert.match(status.browser.connectionStatus, /disconnected/);
    const login = ok(await crashy.request('GET', '/api/login/status'));
    assert.equal(login.state, 'lost');
    assert.equal(login.eligibleForAutomation, false);
    fail(await crashy.request('POST', '/api/browser/click', { body: { x: 1, y: 1 } }), 409, 'browser_not_running');
    fail(await crashy.request('POST', '/api/login/confirm', { body: {} }), 409);

    ok(await crashy.request('POST', '/api/login/open', { body: { url: 'https://example.com/login' } }));
    assert.equal(ok(await crashy.request('GET', '/api/login/status')).state, 'waiting_for_login');
  } finally {
    await crashy.close();
  }
});

// ---- login ----------------------------------------------------------------------------------------------

test('login flow: open -> waiting -> confirm -> eligible; cancel path; confirm requires opening first', async () => {
  const flow = await startApp({ container: fakeBrowserOverrides(createFakeLauncher()) });
  try {
    fail(await flow.request('POST', '/api/login/confirm', { body: {} }), 409, 'login_not_started');
    assert.equal(ok(await flow.request('GET', '/api/login/status')).state, 'idle');

    const opened = ok(await flow.request('POST', '/api/login/open', { body: {} }));
    assert.equal(opened.state, 'waiting_for_login');
    assert.equal(opened.loginUrl, 'https://aaj23525.apps.dynatrace.com/', 'the configured default login URL');
    assert.equal(opened.eligibleForAutomation, false);
    assert.equal(flow.container.services.browser.page.url(), 'https://aaj23525.apps.dynatrace.com/');

    const confirmed = ok(await flow.request('POST', '/api/login/confirm', { body: {} }));
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(confirmed.eligibleForAutomation, true);
    assert.match(confirmed.note, /not an independent verification|acknowledgement/);

    ok(await flow.request('POST', '/api/login/open', { body: {} }));
    const cancelled = ok(await flow.request('POST', '/api/login/cancel', { body: {} }));
    assert.equal(cancelled.state, 'cancelled');
    fail(await flow.request('POST', '/api/login/confirm', { body: {} }), 409, 'login_cancelled');
  } finally {
    await flow.close();
  }
});

test('the login URL is configurable through settings and through the request', async () => {
  const flow = await startApp({ container: fakeBrowserOverrides(createFakeLauncher()) });
  try {
    ok(await flow.request('PUT', '/api/settings', { body: { defaultLoginUrl: 'https://login.example.org/start' } }));
    assert.equal(ok(await flow.request('POST', '/api/login/open', { body: {} })).loginUrl, 'https://login.example.org/start');
    assert.equal(ok(await flow.request('POST', '/api/login/open', { body: { url: 'https://other.example.org/' } })).loginUrl, 'https://other.example.org/');
    fail(await flow.request('POST', '/api/login/open', { body: { url: 'file:///etc/passwd' } }), 400);
    fail(await flow.request('PUT', '/api/settings', { body: { defaultLoginUrl: 'javascript:alert(1)' } }), 400);
  } finally {
    await flow.close();
  }
});

test('the built-in demo site (and only it) may be set as the login URL; other private addresses stay refused', async () => {
  const flow = await startApp({ container: fakeBrowserOverrides(createFakeLauncher()) });
  try {
    const demo = flow.services.fixture.baseUrl();
    assert.equal(ok(await flow.request('PUT', '/api/settings', { body: { defaultLoginUrl: demo } })).settings.defaultLoginUrl, demo);
    assert.equal(ok(await flow.request('POST', '/api/login/open', { body: {} })).loginUrl, demo, '"Open Login Page" works with the demo site');
    for (const url of [`http://127.0.0.1:${flow.port}/api/status`, `http://127.0.0.1:${flow.port}/api/test/fixture/../status`, 'http://127.0.0.1:9/', 'http://10.0.0.5/', 'http://169.254.169.254/']) {
      const res = await flow.request('PUT', '/api/settings', { body: { defaultLoginUrl: url } });
      assert.equal(res.status, 400, url);
      assert.equal(res.json.error.code, 'url_not_allowed', url);
    }
    assert.equal(ok(await flow.request('GET', '/api/settings')).settings.defaultLoginUrl, demo, 'rejected values changed nothing');
  } finally {
    await flow.close();
  }
});

// ---- settings -------------------------------------------------------------------------------------------

test('settings: read defaults, update, validate, reset', async () => {
  const s = ok(await app.request('GET', '/api/settings'));
  assert.equal(s.settings.viewportWidth, 1920);
  assert.equal(s.settings.screenshotFormat, 'png');
  assert.equal(s.settings.headless, true);
  assert.ok(s.bounds.viewportWidth && s.options.screenshotFormat);
  const updated = ok(await app.request('PUT', '/api/settings', { body: { viewportWidth: 1280, viewportHeight: 720, elementTimeout: 8000 } }));
  assert.deepEqual(updated.changed.sort(), ['elementTimeout', 'viewportHeight', 'viewportWidth']);
  assert.equal(updated.settings.viewportWidth, 1280);
  fail(await app.request('PUT', '/api/settings', { body: { viewportWidth: 10 } }), 422);
  fail(await app.request('PUT', '/api/settings', { body: { unknown: 1 } }), 422);
  fail(await app.request('PUT', '/api/settings', { body: {} }), 422);
  const reset = ok(await app.request('POST', '/api/settings/reset', { body: {} }));
  assert.equal(reset.settings.viewportWidth, 1920);
});

test('changing the viewport applies to the running browser', async () => {
  ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  ok(await app.request('PUT', '/api/settings', { body: { viewportWidth: 1000, viewportHeight: 600 } }));
  const b = ok(await app.request('GET', '/api/browser/status'));
  assert.deepEqual(b.viewport, { width: 1000, height: 600 });
  ok(await app.request('POST', '/api/settings/reset', { body: {} }));
  ok(await app.request('POST', '/api/browser/close', { body: {} }));
});

test('headless changes report that a relaunch is required while the browser is running', async () => {
  ok(await app.request('POST', '/api/browser/launch', { body: {} }));
  const res = ok(await app.request('PUT', '/api/settings', { body: { headless: false } }));
  assert.equal(res.requiresRelaunch, true);
  ok(await app.request('POST', '/api/settings/reset', { body: {} }));
  ok(await app.request('POST', '/api/browser/close', { body: {} }));
});

// ---- recorder state -------------------------------------------------------------------------------------

test('recorder status and selection endpoints behave when nothing is selected', async () => {
  const status = ok(await app.request('GET', '/api/recorder/status'));
  assert.equal(status.active, false);
  assert.ok(status.limitations.length >= 3, 'known limitations are reported');
  const sel = ok(await app.request('GET', '/api/recorder/selected-element'));
  assert.equal(sel.hasSelection, false);
  assert.equal(sel.selection, null);
  assert.equal(ok(await app.request('POST', '/api/recorder/clear-selection', { body: {} })).cleared, false);
  fail(await app.request('POST', '/api/recorder/select-element', { body: { x: 1, y: 1 } }), 409);
  fail(await app.request('POST', '/api/recorder/check-locator', { body: { locator: { strategy: 'css' } } }), 422, 'invalid_locator');
});
