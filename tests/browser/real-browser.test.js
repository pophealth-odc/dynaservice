'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { startApp, sleep, waitFor } = require('../helpers/harness');

/*
 * Browser integration tests: real Playwright Chromium, real server, the built-in demo site.
 * They are skipped (with a clear reason) when Chromium is not installed, never silently passed.
 */
const installed = (() => {
  try { return fs.existsSync(chromium.executablePath()); } catch { return false; }
})();
const opts = { skip: installed ? false : 'Playwright Chromium is not installed (run: npm run install:browsers)', timeout: 90000 };

let app;
let fx;
test.before(async () => {
  if (!installed) return;
  app = await startApp();
  fx = app.services.fixture.baseUrl();
});
test.after(async () => { if (app) await app.close(); });

// A test that fails midway must not leave the recorder armed or automation running for the tests after it:
// an armed recorder swallows the keystrokes a later login would need and turns one failure into a dozen.
test.beforeEach(async () => {
  if (!app) return;
  const { recorder, automation, browser } = app.services;
  await automation.stop().catch(() => {});
  if (automation.run?.loopActive) await automation.run.done.catch(() => {});
  await recorder.stop().catch(() => {});
  await recorder.clearSelection().catch(() => {});
  if (browser.isReady) {
    await app.request('POST', '/api/settings/reset', { body: {} });
    // The demo site keeps its "session" in sessionStorage of the page's origin; start every test logged out so a
    // test that opens the login page really sees the login form, whatever the previous test did.
    const page = browser.page;
    if (page && !page.isClosed()) {
      await page.goto(fx, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(() => { sessionStorage.clear(); window.__demoDeleted = 0; }).catch(() => {});
      await page.goto(fx, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
});

const call = async (method, url, body) => {
  const res = await app.request(method, url, { body });
  if (res.json && res.json.ok === false) {
    const e = new Error(`${method} ${url} -> ${res.status} ${res.json.error.code}: ${res.json.error.message}`);
    e.code = res.json.error.code;
    e.status = res.status;
    e.error = res.json.error;
    throw e;
  }
  return res.json ? res.json.data : res;
};
const page = () => app.services.browser.page;
const rejectsWith = async (promise, code) => {
  try { await promise; } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail(`expected ${code} but the call succeeded`);
};

async function demoLogin() {
  await call('POST', '/api/browser/launch', {});
  await call('POST', '/api/login/open', { url: fx });
  await call('POST', '/api/browser/type', { text: 'tester' });
  await call('POST', '/api/browser/keypress', { key: 'Tab' });
  await call('POST', '/api/browser/type', { text: 'demo', pressEnter: true });
  await sleep(350);
  await call('POST', '/api/browser/type', { text: '123456', pressEnter: true });
  await waitFor(async () => /\/problems/.test((await call('GET', '/api/browser/status')).url || ''), { what: 'demo app to log in' });
  await call('POST', '/api/login/confirm', {});
}
const open = async (rel) => { await call('POST', '/api/browser/open-url', { url: fx + rel }); await sleep(250); };
const centre = (selector) => page().evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, selector);

test('Chromium launches headless with the default 1920x1080 viewport and reports its status', opts, async () => {
  const launched = await call('POST', '/api/browser/launch', {});
  assert.equal(launched.connected, true);
  assert.equal(launched.headless, true);
  assert.deepEqual(launched.viewport, { width: 1920, height: 1080 });
  const status = await call('GET', '/api/browser/status');
  assert.equal(status.state, 'ready');
  assert.equal(status.pageState, 'ok');
  assert.equal(status.engine, 'chromium');
  const full = await call('GET', '/api/status');
  assert.equal(full.browser.running, true);
  assert.equal(full.browser.headless, true);
});

test('website navigation works and reports URL, title and HTTP status', opts, async () => {
  const nav = await call('POST', '/api/browser/open-url', { url: fx });
  assert.equal(nav.status, 200);
  assert.equal(nav.url, fx);
  const status = await call('GET', '/api/browser/status');
  assert.equal(status.title, 'Sign in - Demo Monitoring App');
  assert.equal(status.url, fx);
});

test('navigation failures map to clear errors instead of hanging or crashing', opts, async () => {
  await rejectsWith(call('POST', '/api/browser/open-url', { url: 'https://this-host-does-not-exist.invalid/' }), 'navigation_failed');
  await rejectsWith(call('POST', '/api/browser/open-url', { url: 'http://127.0.0.1:9/' }), 'url_not_allowed');
  assert.equal((await call('GET', '/api/browser/status')).connected, true, 'the browser survived');
});

test('the navigation timeout setting is honoured', opts, async () => {
  // A deliberately slow server on loopback. Loopback is refused by default (SSRF), so this runs on a dedicated service
  // instance started with ALLOW_PRIVATE_URLS=true, which is the documented local-development switch.
  const slow = require('node:http').createServer((req, res) => { setTimeout(() => res.end('late'), 5000); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const local = await startApp({ env: { ALLOW_PRIVATE_URLS: 'true' } });
  try {
    await local.request('POST', '/api/browser/launch', { body: {} });
    await local.request('PUT', '/api/settings', { body: { navigationTimeout: 1000 } });
    const started = Date.now();
    const res = await local.request('POST', '/api/browser/open-url', { body: { url: `http://127.0.0.1:${slow.address().port}/` } });
    assert.equal(res.status, 504);
    assert.equal(res.json.error.code, 'navigation_timeout');
    assert.ok(Date.now() - started < 4000, 'gave up after about one second, not five');
    assert.equal((await local.request('GET', '/api/browser/status')).json.data.connected, true, 'the browser survived the timeout');
  } finally {
    await local.close();
    slow.closeAllConnections?.();
    slow.close();
  }
});

test('manual login through remote interaction: credentials are typed remotely and never exposed', opts, async () => {
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await call('POST', '/api/browser/launch', {});
    const opened = await call('POST', '/api/login/open', { url: fx });
    assert.equal(opened.state, 'waiting_for_login');
    assert.equal(opened.eligibleForAutomation, false);
    await rejectsWith(call('POST', '/api/automation/start', { workflowId: crypto.randomUUID() }), 'workflow_not_found');

    const t1 = await app.request('POST', '/api/browser/type', { body: { text: 'tester' } });
    await call('POST', '/api/browser/keypress', { key: 'Tab' });
    const t2 = await app.request('POST', '/api/browser/type', { body: { text: 'demo', pressEnter: true } });
    await sleep(350);
    const t3 = await app.request('POST', '/api/browser/type', { body: { text: '123456', pressEnter: true } });
    for (const t of [t1, t2, t3]) {
      assert.ok(!t.text.includes('demo') && !t.text.includes('123456') && !t.text.includes('tester'), 'typed text is not echoed');
    }
    await waitFor(async () => /\/problems/.test((await call('GET', '/api/browser/status')).url || ''), { what: 'login to complete' });
    const confirmed = await call('POST', '/api/login/confirm', {});
    assert.equal(confirmed.eligibleForAutomation, true);

    const dump = JSON.stringify([await call('GET', '/api/status'), await call('GET', '/api/login/status'), await call('GET', '/api/browser/status'), await call('GET', '/api/settings')]);
    assert.ok(!dump.includes('"demo"') && !dump.includes('123456'));
    // The login note says cookies are never collected, so match cookie VALUES rather than the word. The demo site's
    // session lives in sessionStorage; plant a real cookie as well to prove cookie values are not exposed either.
    await page().context().addCookies([{ name: 'sid', value: 'COOKIE-VALUE-9f8e7d6c5b4a', url: fx }]);
    const withCookie = JSON.stringify([await call('GET', '/api/status'), await call('GET', '/api/browser/status'), await call('GET', '/api/login/status')]);
    assert.ok(!withCookie.includes('COOKIE-VALUE-9f8e7d6c5b4a'), 'cookie values are never exposed through the API');
    await page().context().clearCookies();
  } finally {
    console.log = original;
  }
  assert.ok(!logs.join('\n').includes('123456'));
});

test('remote screenshot, coordinate clicks, hover, key presses and scrolling work', opts, async () => {
  await demoLogin();
  await open('services');
  const shot = await app.request('GET', '/api/browser/screenshot?format=png', { raw: true });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await shot.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1920, 'PNG width equals the viewport width');
  assert.equal(png.readUInt32BE(20), 1080);

  await open('problems');
  const link = await centre('[data-route="reports"]');
  const clicked = await call('POST', '/api/browser/click', link);
  assert.match(clicked.url, /\/reports$/, 'a coordinate click navigated the SPA');
  const hover = await call('POST', '/api/browser/hover', await centre('#nav-problems'));
  assert.equal(hover.hovered.x > 0, true);

  await open('problems');
  await call('POST', '/api/browser/scroll', { deltaY: 600 });
  await call('POST', '/api/browser/keypress', { key: 'Tab', times: 2 });
  const scrolled = await call('POST', '/api/browser/scroll', { deltaY: 300 });
  assert.ok(scrolled.scrollPosition && typeof scrolled.scrollPosition.y === 'number');
  const refreshed = await call('POST', '/api/browser/refresh', {});
  assert.equal(refreshed.reloaded, true);
});

test('recorder: hover highlights, click selects without activating the site, full metadata and a unique locator', opts, async () => {
  await demoLogin();
  await open('problems');
  assert.equal((await call('POST', '/api/recorder/start', {})).active, true);
  const target = await centre('[data-route="services"]');
  await call('POST', '/api/browser/hover', target);
  assert.equal(await page().evaluate(() => Boolean(document.getElementById('__ss-picker-overlay'))), true, 'a highlight border is drawn');
  const tooltip = await page().evaluate(() => document.querySelector('[data-ss-picker="tooltip"]')?.textContent || '');
  assert.match(tooltip, /^a/, 'the tooltip describes the element');
  assert.match(tooltip, /link/);

  const urlBefore = (await call('GET', '/api/browser/status')).url;
  const out = await call('POST', '/api/browser/click', target);
  assert.equal(out.recorded, true);
  assert.equal((await call('GET', '/api/browser/status')).url, urlBefore, 'the selected link was NOT followed');

  const { selection } = await call('GET', '/api/recorder/selected-element');
  const e = selection.element;
  assert.equal(e.tag, 'a');
  assert.equal(e.text, 'Services');
  assert.equal(e.role, 'link');
  assert.equal(e.accessibleName, 'Services');
  assert.ok(e.classes.includes('nav-link'));
  assert.equal(e.dataAttributes['data-route'], 'services');
  assert.ok(selection.cssSelector && selection.xpath);
  assert.equal(selection.page.title, 'Problems - Demo Monitoring App');
  assert.equal(selection.frame.isTopFrame, true);
  assert.equal(selection.locators.unique, true);
  assert.equal(selection.locators.primary.strategy, 'data');
  assert.equal(await page().locator(`xpath=${selection.xpath}`).count(), 1, 'the XPath fallback resolves to exactly one element');
  assert.deepEqual(selection.locators.candidates.map((c) => c.strategy).slice(0, 3), ['data', 'role', 'css'], 'locator priority order');

  await call('POST', '/api/recorder/stop', {});
  assert.equal(await page().evaluate(() => Boolean(document.getElementById('__ss-picker-overlay'))), false, 'highlight removed');
  await call('POST', '/api/browser/click', target);
  assert.match((await call('GET', '/api/browser/status')).url, /\/services$/, 'normal page interaction is restored after recording stops');
});

test('recorder: ambiguity is reported and a unique, position-based locator is chosen instead', opts, async () => {
  await demoLogin();
  await open('problems');
  await call('POST', '/api/recorder/start', {});
  const pos = await page().evaluate(() => { const r = document.querySelectorAll('.row-open')[1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  const { selection } = await call('POST', '/api/recorder/select-element', pos);
  await call('POST', '/api/recorder/stop', {});
  const byStrategy = Object.fromEntries(selection.locators.candidates.map((c) => [c.strategy + (c.label.includes('position') ? ':pos' : ''), c.matches]));
  assert.ok(byStrategy.role > 1, `role locator is ambiguous (${byStrategy.role})`);
  assert.ok(byStrategy.text > 1, 'text locator is ambiguous');
  assert.equal(selection.locators.unique, true);
  assert.equal(await page().locator(`css=${selection.locators.primary.selector}`).count(), 1);
  assert.ok(selection.warnings.some((w) => /position-based/.test(w)), 'the fragility of a position locator is called out');
});

test('recorder: open shadow DOM and same-origin iframes are supported', opts, async () => {
  await demoLogin();
  await open('services/checkout');
  await call('POST', '/api/recorder/start', {});
  const pos = await page().evaluate(() => {
    const b = document.querySelector('status-badge').shadowRoot.querySelector('.check').getBoundingClientRect();
    const f = document.querySelector('#metrics-frame').getBoundingClientRect();
    return { shadow: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }, frame: { x: Math.round(f.left + 60), y: Math.round(f.top + 62) } };
  });
  const sh = (await call('POST', '/api/recorder/select-element', pos.shadow)).selection;
  assert.equal(sh.element.inShadowDom, true);
  assert.deepEqual(sh.element.shadowHosts, ['status-badge#status-badge']);
  assert.equal(sh.locators.unique, true);
  assert.equal(sh.xpath, null, 'XPath cannot pierce shadow DOM, so none is offered');

  const fr = (await call('POST', '/api/recorder/select-element', pos.frame)).selection;
  assert.equal(fr.frame.isTopFrame, false);
  assert.deepEqual(fr.frame.path, ['#metrics-frame']);
  assert.match(fr.frame.url, /frame\.html$/);
  assert.equal(fr.element.id, 'frame-button');
  assert.equal(fr.locators.unique, true);
  await call('POST', '/api/recorder/stop', {});

  // The recorded locators must actually work for automation, including through the iframe and the shadow root.
  const wf = await call('POST', '/api/workflows', { name: 'Shadow and frame', steps: [
    { name: 'Check status', action: 'click', target: sh.locators.primary },
    { name: 'Load metrics', action: 'click', target: fr.locators.primary },
  ] });
  await call('POST', '/api/automation/start', { workflowId: wf.workflow.id });
  await waitFor(async () => ['completed', 'failed', 'paused'].includes((await call('GET', '/api/automation/status')).run?.status), { what: 'run', timeout: 30000 });
  const run = (await call('GET', '/api/automation/status')).run;
  assert.equal(run.status, 'completed', run.message);
  assert.equal(await page().evaluate(() => document.querySelector('status-badge').shadowRoot.getElementById('state').textContent), 'Status: healthy');
  assert.equal(await page().frames().find((f) => f !== page().mainFrame()).evaluate(() => document.getElementById('frame-output').textContent), 'Metrics loaded from inside the iframe.');
});

test('recorder: sensitive fields never leak their name or value and a destructive element is flagged', opts, async () => {
  await call('POST', '/api/browser/launch', {});
  await call('POST', '/api/browser/open-url', { url: fx });
  await sleep(200);
  await call('POST', '/api/recorder/start', {});
  const pw = await centre('#password');
  const { selection } = await call('POST', '/api/recorder/select-element', pw);
  assert.equal(selection.element.sensitive, true);
  assert.equal(selection.element.accessibleName, '');
  assert.ok(!selection.locators.candidates.some((c) => c.strategy === 'role' || c.strategy === 'text'));
  assert.ok(selection.warnings.some((w) => /sensitive/i.test(w)));
  assert.ok(!JSON.stringify(selection).includes('Password"'), 'placeholder text is withheld');
  await call('POST', '/api/recorder/stop', {});

  await demoLogin();
  await open('reports');
  await call('POST', '/api/recorder/start', {});
  const del = (await call('POST', '/api/recorder/select-element', await centre('#btn-delete'))).selection;
  await call('POST', '/api/recorder/stop', {});
  assert.equal(del.safety.destructive, true);
  assert.ok(del.warnings.some((w) => /allowDestructive/.test(w)));
  assert.equal(del.suggestedStep.allowDestructive, false);
});

test('recorder: a selection can be saved as a workflow step through the API', opts, async () => {
  await demoLogin();
  await open('problems');
  const wf = (await call('POST', '/api/workflows', { name: 'Recorded', steps: [] })).workflow;
  await call('POST', '/api/recorder/start', {});
  await call('POST', '/api/recorder/select-element', await centre('#nav-problems'));
  await call('POST', '/api/recorder/stop', {});
  const added = await call('POST', `/api/workflows/${wf.id}/steps`, { fromSelection: true, name: 'Open Problems', screenshot: true });
  assert.equal(added.addedStep.name, 'Open Problems');
  assert.equal(added.addedStep.action, 'click');
  assert.equal(added.addedStep.target.strategy, 'id');
  assert.equal(added.addedStep.screenshot, true);
  assert.equal(added.addedStep.allowDestructive, false);
  const check = await call('POST', '/api/recorder/check-locator', { locator: added.addedStep.target });
  assert.deepEqual({ matches: check.matches, unique: check.unique }, { matches: 1, unique: true });
});

test('recorder: "select and continue" (activate) performs the click, keeps recording, and refuses destructive elements', opts, async () => {
  await demoLogin();
  await open('problems');
  await call('POST', '/api/recorder/start', {});
  const nav = await centre('[data-route="services"]');
  const urlBefore = (await call('GET', '/api/browser/status')).url;

  // A plain selection never follows the link.
  const plain = (await call('POST', '/api/recorder/select-element', nav)).selection;
  assert.equal(plain.activated, false);
  assert.equal((await call('GET', '/api/browser/status')).url, urlBefore, 'plain select does not navigate');

  // With activate the same element is selected AND clicked, so the user can reach the next page.
  const act = (await call('POST', '/api/recorder/select-element', { ...nav, activate: true })).selection;
  assert.equal(act.activated, true);
  assert.equal(act.activation.performed, true);
  await waitFor(async () => /\/services$/.test((await call('GET', '/api/browser/status')).url), { what: 'navigation after activate' });
  assert.equal((await call('GET', '/api/recorder/status')).active, true, 'recording continues on the next page');

  // Recording is re-armed on the new page: a normal click selects instead of following the link.
  await waitFor(async () => page().evaluate(() => !document.getElementById('services-list').hidden), { what: 'services list' });
  const service = await centre('[data-service="checkout"]');
  const here = (await call('GET', '/api/browser/status')).url;
  assert.equal((await call('POST', '/api/browser/click', service)).recorded, true);
  assert.equal((await call('GET', '/api/browser/status')).url, here, 'site actions are blocked again after activation');
  await call('POST', '/api/recorder/stop', {});

  // A destructive-looking element is selected but never clicked, even with activate.
  await open('reports');
  await call('POST', '/api/recorder/start', {});
  const del = (await call('POST', '/api/recorder/select-element', { ...(await centre('#btn-delete')), activate: true })).selection;
  await call('POST', '/api/recorder/stop', {});
  assert.equal(del.activation.performed, false);
  assert.match(del.activation.reason, /Not clicked/);
  assert.equal(await page().evaluate(() => window.__demoDeleted || 0), 0, 'the Delete handler never ran');
});

test('the picker is re-armed after a page navigation while recording, so site actions stay blocked', opts, async () => {
  await demoLogin();
  await open('problems');
  await call('POST', '/api/recorder/start', {});
  await page().goto(fx + 'reports');
  await sleep(500);
  await call('POST', '/api/browser/click', await centre('#btn-delete'));
  assert.equal(await page().evaluate(() => window.__demoDeleted || 0), 0, 'the Delete handler did not run');
  await call('POST', '/api/recorder/stop', {});
});

test('workflow execution: ordered steps, SPA routes without page loads, async content, screenshots per step', opts, async () => {
  await demoLogin();
  await open('problems');
  const wf = (await call('POST', '/api/workflows', { name: 'Dynatrace Dashboard Navigation', steps: [
    { name: 'Open Problems', action: 'click', target: { strategy: 'id', selector: '#nav-problems' }, screenshot: true, delay: 100 },
    { name: 'Open Services', action: 'click', target: { strategy: 'data', selector: '[data-route="services"]' }, wait: { condition: 'element_visible', target: { strategy: 'css', selector: '[data-testid="services-list"]' } }, screenshot: true, delay: 100 },
    { name: 'Open Selected Service', action: 'click', target: { strategy: 'role', role: 'link', name: 'checkout-service' }, wait: { condition: 'url_matches', urlPattern: '/services/checkout' }, screenshot: true, delay: 100 },
    { name: 'Wait for details', action: 'wait_for_element', target: { strategy: 'css', selector: '[data-testid="service-details"]' } },
    { name: 'Final shot', action: 'capture_screenshot', delay: 0 },
  ] })).workflow;

  let navigations = 0;
  page().on('load', () => { navigations += 1; });
  await call('POST', '/api/automation/start', { workflowId: wf.id });
  await waitFor(async () => ['completed', 'failed', 'paused'].includes((await call('GET', '/api/automation/status')).run?.status), { what: 'run to finish', timeout: 60000 });
  const run = (await call('GET', '/api/automation/status')).run;
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed']);
  assert.equal(run.progress, 100);
  assert.equal(navigations, 0, 'the SPA navigated entirely without full page loads, and the engine coped');
  assert.match(page().url(), /\/services\/checkout$/);

  const shots = await call('GET', `/api/screenshots?runId=${run.id}`);
  assert.equal(shots.total, 4, 'one screenshot per step that asked for one, no duplicates');
  assert.deepEqual(shots.items.map((s) => s.stepNumber).sort(), [1, 2, 3, 5]);
  assert.ok(shots.items.every((s) => s.workflowName === 'Dynatrace Dashboard Navigation' && s.sourceUrl && s.pageTitle));
  const first = shots.items.find((s) => s.stepNumber === 1);
  assert.match(first.filename, /^Dynatrace_Dashboard_Navigation_Open_Problems_\d{4}-\d{2}-\d{2}_\d{6}\.png$/);
});

test('a step whose element is hidden or absent fails with a precise reason, and can be retried after the page changes', opts, async () => {
  await demoLogin();
  await open('problems');
  const run = async (target) => {
    const wf = (await call('POST', '/api/workflows', { name: `Needs ${Math.random()}`, steps: [{ name: 'Click it', action: 'click', timeout: 1200, target, delay: 0 }] })).workflow;
    await call('POST', '/api/automation/start', { workflowId: wf.id });
    await waitFor(async () => (await call('GET', '/api/automation/status')).run?.status === 'failed', { what: 'failure', timeout: 20000 });
    return (await call('GET', '/api/automation/status')).run;
  };

  // Present in the DOM but inside a hidden view: the engine says so instead of claiming it does not exist.
  const hidden = await run({ strategy: 'id', selector: '#btn-refresh' });
  assert.equal(hidden.steps[0].error.code, 'element_not_visible');
  assert.equal(hidden.failedSteps, 1);

  // Not in the DOM at all.
  await call('POST', '/api/automation/stop', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run?.status === 'stopped', { what: 'stop' });
  const absent = await run({ strategy: 'id', selector: '#no-such-element' });
  assert.equal(absent.steps[0].error.code, 'element_not_found');
  assert.ok(absent.steps[0].error.hint, 'the failure explains what to check');

  // Retrying after the situation is fixed completes the same step (the failed step is retried, not skipped).
  await call('POST', '/api/automation/stop', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run?.status === 'stopped', { what: 'stop' });
  const retry = await run({ strategy: 'id', selector: '#btn-refresh' });
  assert.equal(retry.steps[0].status, 'failed');
  await open('reports'); // the user navigates to the page that has the button
  await call('POST', '/api/automation/resume', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run?.status === 'completed', { what: 'retry to succeed', timeout: 20000 });
  assert.equal((await call('GET', '/api/automation/status')).run.steps[0].attempts, 2);
});

test('an ambiguous locator fails clearly; fallbacks and index make it usable', opts, async () => {
  await demoLogin();
  await open('problems');
  const ambiguous = { strategy: 'css', selector: '.row-open' };
  const e1 = await rejectsWith(call('POST', '/api/automation/test-step', { step: { name: 'Amb', action: 'click', timeout: 1000, target: ambiguous } }), 'element_ambiguous');
  assert.equal(e1.error.details.count, 3);
  const withIndex = await call('POST', '/api/automation/test-step', { step: { name: 'Second', action: 'click', timeout: 3000, target: { ...ambiguous, index: 1 } } });
  assert.equal(withIndex.passed, true);
  assert.match(await page().textContent('#problem-detail'), /P-1002/, 'the second row was opened');
  const fallback = await call('POST', '/api/automation/test-step', { step: { name: 'Fallback', action: 'click', timeout: 3000, target: { strategy: 'css', selector: '#gone', fallbacks: [{ strategy: 'css', selector: '.row-open', index: 2 }] } } });
  assert.equal(fallback.result.usedFallback, true);
  assert.match(await page().textContent('#problem-detail'), /P-1003/);
});

test('destructive-looking clicks are blocked unless the step AND the run both allow them', opts, async () => {
  await demoLogin();
  await open('reports');
  const danger = (allow) => ({ name: 'Delete all', action: 'click', timeout: 2000, target: { strategy: 'id', selector: '#btn-delete' }, allowDestructive: allow });
  const blocked = await rejectsWith(call('POST', '/api/automation/test-step', { step: danger(false), confirmDestructive: true }), 'destructive_action_blocked');
  assert.equal(blocked.status, 403);
  await rejectsWith(call('POST', '/api/automation/test-step', { step: danger(true), confirmDestructive: false }), 'destructive_action_blocked');
  assert.equal(await page().evaluate(() => window.__demoDeleted || 0), 0, 'never clicked in either refused case');
  const allowed = await call('POST', '/api/automation/test-step', { step: danger(true), confirmDestructive: true });
  assert.equal(allowed.passed, true);
  assert.equal(await page().evaluate(() => window.__demoDeleted || 0), 1, 'clicked once both permissions were given');
});

test('pause / resume / skip / stop against the real browser', opts, async () => {
  await demoLogin();
  await open('problems');
  const wf = (await call('POST', '/api/workflows', { name: 'Controls', steps: [
    { name: 'A', action: 'click', target: { strategy: 'id', selector: '#nav-problems' }, delay: 1200 },
    { name: 'B', action: 'click', target: { strategy: 'data', selector: '[data-route="reports"]' }, delay: 1200 },
    { name: 'C', action: 'click', target: { strategy: 'data', selector: '[data-route="services"]' }, delay: 1200 },
  ] })).workflow;
  await call('POST', '/api/automation/start', { workflowId: wf.id });
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.steps[0].status === 'running');
  assert.equal((await call('POST', '/api/automation/pause', {})).state, 'pausing');
  await rejectsWith(call('POST', '/api/browser/click', { x: 10, y: 10 }), 'automation_running');
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.status === 'paused', { what: 'paused', timeout: 15000 });
  const paused = (await call('GET', '/api/automation/status')).run;
  assert.deepEqual(paused.steps.map((s) => s.status), ['completed', 'pending', 'pending']);
  const urlWhilePaused = page().url();
  await sleep(1500);
  assert.equal(page().url(), urlWhilePaused, 'nothing moves while paused');
  assert.equal((await call('POST', '/api/browser/hover', { x: 5, y: 5 })).ok, true, 'manual interaction is possible again while paused');

  await call('POST', '/api/automation/skip-step', {});
  assert.equal((await call('GET', '/api/automation/status')).run.steps[1].status, 'skipped');
  await call('POST', '/api/automation/resume', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.steps[2].status === 'running', { what: 'step C' });
  await call('POST', '/api/automation/stop', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.status === 'stopped', { what: 'stopped', timeout: 15000 });
  assert.equal((await call('GET', '/api/automation/status')).controls.start, true);
});

test('losing authentication mid-run pauses for manual re-login; resuming after confirming continues', opts, async () => {
  await demoLogin();
  await open('problems');
  const wf = (await call('POST', '/api/workflows', { name: 'Expiry', steps: [
    { name: 'Reports', action: 'click', target: { strategy: 'data', selector: '[data-route="reports"]' }, delay: 300 },
    { name: 'Services', action: 'click', target: { strategy: 'data', selector: '[data-route="services"]' }, delay: 300 },
  ] })).workflow;
  await call('POST', '/api/automation/start', { workflowId: wf.id, paused: true });
  await call('POST', '/api/automation/execute-step', {});
  await waitFor(async () => { const r = (await call('GET', '/api/automation/status')).run; return r.status === 'paused' && r.steps[0].status === 'completed'; }, { what: 'first step' });

  // Simulate the site's session expiring: the demo app shows its login form again (sessionStorage cleared, reload).
  await page().evaluate(() => sessionStorage.clear());
  await page().goto(fx);
  await sleep(300);
  await call('POST', '/api/automation/execute-step', {}).catch(() => {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.pauseReason === 'session_expired', { what: 'session_expired pause', timeout: 20000 });
  const run = (await call('GET', '/api/automation/status')).run;
  assert.equal(run.status, 'paused');
  assert.equal(run.loginRequired, true);
  assert.match(run.message, /log in again/i);
  await rejectsWith(call('POST', '/api/automation/resume', {}), 'session_expired');
  assert.equal((await call('GET', '/api/login/status')).state, 'expired');

  await call('POST', '/api/browser/type', { text: 'tester' });
  await call('POST', '/api/browser/keypress', { key: 'Tab' });
  await call('POST', '/api/browser/type', { text: 'demo', pressEnter: true });
  await sleep(350);
  await call('POST', '/api/browser/type', { text: '123456', pressEnter: true });
  await waitFor(async () => /\/problems/.test((await call('GET', '/api/browser/status')).url || ''), { what: 'second login' });
  await call('POST', '/api/login/confirm', {});
  await call('POST', '/api/automation/resume', {});
  await waitFor(async () => (await call('GET', '/api/automation/status')).run.status === 'completed', { what: 'completion after re-login', timeout: 30000 });
});

test('killing Chromium is detected: session lost, automation refused, relaunch and login recover', opts, async () => {
  await demoLogin();
  const sessionBefore = (await call('GET', '/api/browser/status')).sessionId;
  await app.services.browser.browser.close(); // Chromium disappears without the service asking
  await waitFor(async () => !(await call('GET', '/api/browser/status')).connected, { what: 'disconnect detection' });
  const status = await call('GET', '/api/status');
  assert.equal(status.browser.running, false);
  assert.match(status.browser.connectionStatus, /disconnected/);
  assert.equal((await call('GET', '/api/login/status')).state, 'lost');
  await rejectsWith(call('POST', '/api/browser/click', { x: 5, y: 5 }), 'browser_not_running');
  await call('POST', '/api/browser/launch', {});
  assert.notEqual((await call('GET', '/api/browser/status')).sessionId, sessionBefore);
  assert.equal((await call('GET', '/api/login/status')).eligibleForAutomation, false, 'the old confirmation does not carry over');
  await demoLogin();
  assert.equal((await call('GET', '/api/login/status')).eligibleForAutomation, true);
});

test('a crashed page is recreated on the next action without losing the browser', opts, async () => {
  await demoLogin();
  const events = [];
  app.services.events.on('event', (e) => events.push(e.type));
  const cdp = await page().context().newCDPSession(page());
  // Page.crash kills the renderer, so the CDP call itself never gets an answer: do not wait for it.
  cdp.send('Page.crash').catch(() => {});
  await waitFor(() => app.services.browser.pageCrashed, { what: 'crash flag', timeout: 10000 });
  assert.equal((await call('GET', '/api/browser/status')).pageState, 'crashed');
  const shot = await app.request('GET', '/api/browser/screenshot', { raw: true });
  assert.equal(shot.status, 200, 'the next action recreated the page');
  await shot.arrayBuffer();
  assert.equal((await call('GET', '/api/browser/status')).pageState, 'ok');
  assert.ok(events.includes('browser.page_crashed') && events.includes('browser.page_recovered'));
});

test('private-network sub-requests made by a page are blocked inside the cloud browser (SSRF)', opts, async () => {
  // A real internal service that a malicious page would love to reach. The page used here has no CSP, so the only
  // thing that can stop the request is the service's own route guard (the demo site's CSP would stop it first and
  // prove nothing). The same request succeeds when the guard is switched off, which shows the test can fail.
  let hits = 0;
  const internal = require('node:http').createServer((req, res) => {
    hits += 1;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('INTERNAL-SECRET');
  });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${internal.address().port}/`;
  const attempt = async (service) => {
    await service.request('POST', '/api/browser/launch', { body: {} });
    const page$ = service.services.browser.page;
    await page$.setContent('<html><body>attacker page</body></html>');
    return page$.evaluate(async (u) => {
      try { return `READ:${await (await fetch(u)).text()}`; } catch { return 'blocked'; }
    }, target);
  };
  const guarded = await startApp();
  const unguarded = await startApp({ env: { ALLOW_PRIVATE_URLS: 'true' } });
  try {
    assert.equal(await attempt(guarded), 'blocked');
    assert.equal(hits, 0, 'the internal service never received the request');
    assert.ok(guarded.services.browser.blockedRequests >= 1, 'the blocked request was counted');
    assert.equal(await attempt(unguarded), 'READ:INTERNAL-SECRET', 'control: without the guard the same request gets through');
    assert.equal(hits, 1);
  } finally {
    await guarded.close();
    await unguarded.close();
    internal.closeAllConnections?.();
    internal.close();
  }
});

test('downloads and JavaScript dialogs cannot confirm anything on the user\'s behalf', opts, async () => {
  await demoLogin();
  await open('reports');
  const answer = await page().evaluate(() => window.confirm('Really delete everything?'));
  assert.equal(answer, false, 'confirm() is dismissed, never accepted');
  assert.equal(app.services.browser.lastDialog.type, 'confirm');
});

test('graceful shutdown closes Chromium and leaves no stray browser process', opts, async () => {
  await call('POST', '/api/browser/launch', {});
  const browser = app.services.browser.browser;
  await app.container.shutdown();
  assert.equal(browser.isConnected(), false);
  assert.equal(app.services.browser.isReady, false);
});
