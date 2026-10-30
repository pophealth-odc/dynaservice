'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEnv, ConfigError, SettingsStore } = require('../../src/config/settings');
const { createSecurity } = require('../../src/config/security');
const os = require('node:os');
const fs = require('node:fs');

const TOKEN = 'unit-token-0123456789abcdef0123456789';
const base = (extra = {}) => ({ NODE_ENV: 'test', API_TOKEN: TOKEN, ...extra });

test('createEnv applies the documented defaults', () => {
  const env = createEnv(base());
  assert.equal(env.port, 3000);
  assert.equal(env.host, '0.0.0.0');
  assert.equal(env.defaults.viewportWidth, 1920);
  assert.equal(env.defaults.viewportHeight, 1080);
  assert.equal(env.defaults.navigationTimeout, 30000);
  assert.equal(env.defaults.elementTimeout, 15000);
  assert.equal(env.defaults.additionalPageDelay, 5000);
  assert.equal(env.defaults.headless, true);
  assert.equal(env.defaults.screenshotFormat, 'png');
  assert.equal(env.defaults.screenshotType, 'viewport');
  assert.equal(env.defaults.defaultLoginUrl, 'https://aaj23525.apps.dynatrace.com/');
  assert.ok(env.screenshotDir.replace(/\\/g, '/').endsWith('screenshot-automation/screenshots'));
});

test('createEnv honours the environment variables from .env.example', () => {
  const env = createEnv(base({ PORT: '10000', DEFAULT_VIEWPORT_WIDTH: '1280', DEFAULT_VIEWPORT_HEIGHT: '720', NAVIGATION_TIMEOUT: '20000', ELEMENT_TIMEOUT: '9000', ADDITIONAL_PAGE_DELAY: '1000', BROWSER_HEADLESS: 'false', SCREENSHOT_DIR: path.join(os.tmpdir(), 'x', 'shots') }));
  assert.equal(env.port, 10000);
  assert.equal(env.defaults.viewportWidth, 1280);
  assert.equal(env.defaults.navigationTimeout, 20000);
  assert.equal(env.defaults.elementTimeout, 9000);
  assert.equal(env.defaults.additionalPageDelay, 1000);
  assert.equal(env.defaults.headless, false);
  assert.equal(env.screenshotDir, path.resolve(os.tmpdir(), 'x', 'shots'));
});

test('a missing, placeholder or short API_TOKEN stops the service from starting', () => {
  assert.throws(() => createEnv({ NODE_ENV: 'test' }), (e) => e instanceof ConfigError && /API_TOKEN is not set/.test(e.message));
  assert.throws(() => createEnv({ NODE_ENV: 'test', API_TOKEN: 'GENERATE_A_SECURE_RANDOM_TOKEN' }), (e) => /placeholder/.test(e.message));
  assert.throws(() => createEnv({ NODE_ENV: 'test', API_TOKEN: 'short' }), (e) => /at least/.test(e.message));
  assert.throws(() => createEnv({ NODE_ENV: 'production', API_TOKEN: 'a'.repeat(20) }), (e) => /at least 24/.test(e.message));
});

test('configuration errors never contain the token', () => {
  const secret = 'S3cretValueThatMustNeverAppear1234567';
  for (const extra of [{ PORT: 'abc' }, { DASHBOARD_ORIGIN: '*' }, { DEFAULT_LOGIN_URL: 'file:///x' }, { BROWSER_HEADLESS: 'maybe' }]) {
    try {
      createEnv({ NODE_ENV: 'test', API_TOKEN: secret, ...extra });
      assert.fail('expected a ConfigError');
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(secret));
    }
  }
});

test('invalid numeric and boolean variables are rejected with a clear message', () => {
  assert.throws(() => createEnv(base({ PORT: '99999' })), /PORT/);
  assert.throws(() => createEnv(base({ DEFAULT_VIEWPORT_WIDTH: '10' })), /DEFAULT_VIEWPORT_WIDTH/);
  assert.throws(() => createEnv(base({ NAVIGATION_TIMEOUT: '5.5' })), /NAVIGATION_TIMEOUT/);
  assert.throws(() => createEnv(base({ BROWSER_HEADLESS: 'perhaps' })), /BROWSER_HEADLESS/);
});

test('DASHBOARD_ORIGIN is reduced to bare origins and wildcards are refused', () => {
  const env = createEnv(base({ DASHBOARD_ORIGIN: 'https://me.github.io/my-project/, http://localhost:5173/app' }));
  assert.deepEqual(env.dashboardOrigins, ['https://me.github.io', 'http://localhost:5173']);
  assert.throws(() => createEnv(base({ DASHBOARD_ORIGIN: '*' })), /wildcard/i);
  assert.throws(() => createEnv(base({ DASHBOARD_ORIGIN: 'https://*.github.io' })), /wildcard/i);
  assert.throws(() => createEnv(base({ DASHBOARD_ORIGIN: 'not-an-origin' })), /invalid origin/);
});

test('the placeholder dashboard origin produces a warning rather than being silently trusted', () => {
  const env = createEnv(base({ DASHBOARD_ORIGIN: 'https://YOUR-USERNAME.github.io' }));
  assert.ok(env.warnings.some((w) => /placeholder/.test(w)));
});

test('security: bearer parsing and constant-time token comparison', () => {
  const sec = createSecurity(createEnv(base()));
  assert.equal(sec.parseBearer(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(sec.parseBearer(`bearer ${TOKEN}`), TOKEN);
  assert.equal(sec.parseBearer(`Basic ${TOKEN}`), null);
  assert.equal(sec.parseBearer('Bearer'), null);
  assert.equal(sec.parseBearer(undefined), null);
  assert.equal(sec.tokenMatches(TOKEN), true);
  assert.equal(sec.tokenMatches(`${TOKEN}x`), false);
  assert.equal(sec.tokenMatches(TOKEN.slice(0, -1)), false);
  assert.equal(sec.tokenMatches(''), false);
  assert.equal(sec.tokenMatches('x'.repeat(5000)), false);
  assert.equal(sec.tokenMatches(null), false);
});

test('security: origin classification (same-origin, dashboard, foreign, none)', () => {
  const sec = createSecurity(createEnv(base({ DASHBOARD_ORIGIN: 'https://me.github.io/proj' })));
  const req = (origin, host = 'svc.onrender.com') => ({ get: (h) => ({ origin, host }[h.toLowerCase()]) });
  assert.deepEqual(sec.classifyOrigin(req(undefined)), { present: false, allowed: true, crossOrigin: false, origin: null });
  assert.equal(sec.classifyOrigin(req('https://svc.onrender.com')).crossOrigin, false, 'same origin is not cross-origin');
  assert.equal(sec.classifyOrigin(req('http://svc.onrender.com')).allowed, true, 'scheme differences behind a TLS proxy are tolerated');
  const dash = sec.classifyOrigin(req('https://me.github.io'));
  assert.equal(dash.allowed, true);
  assert.equal(dash.crossOrigin, true);
  assert.equal(sec.classifyOrigin(req('https://evil.example')).allowed, false);
  assert.equal(sec.classifyOrigin(req('https://me.github.io.evil.example')).allowed, false, 'suffix tricks do not match');
  assert.equal(sec.classifyOrigin(req('null')).allowed, false);
});

test('SettingsStore validates, persists and resets runtime settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-settings-'));
  try {
    const env = createEnv(base({ DATA_DIR: dir }));
    fs.mkdirSync(env.runtimeDir, { recursive: true });
    const store = new SettingsStore(env);
    const changes = [];
    store.on('change', (c) => changes.push(c.changed));

    const result = await store.update({ viewportWidth: 1280, headless: false });
    assert.deepEqual(result.changed.sort(), ['headless', 'viewportWidth']);
    assert.equal(result.requiresRelaunch, true, 'headless only applies on next launch');
    assert.equal(store.get().viewportWidth, 1280);

    await assert.rejects(store.update({ viewportWidth: 10 }), (e) => e.code === 'invalid_settings');
    await assert.rejects(store.update({ screenshotFormat: 'gif' }), (e) => e.code === 'invalid_settings');
    await assert.rejects(store.update({ nonsense: 1 }), (e) => e.code === 'invalid_settings');
    await assert.rejects(store.update({ defaultLoginUrl: 'javascript:alert(1)' }), (e) => e.code === 'invalid_url_scheme');
    assert.equal(store.get().viewportWidth, 1280, 'a rejected update changes nothing');

    const reloaded = new SettingsStore(env);
    await reloaded.load();
    assert.equal(reloaded.get().viewportWidth, 1280, 'overrides survive within the same filesystem');

    await store.reset();
    assert.equal(store.get().viewportWidth, 1920);
    assert.ok(changes.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
