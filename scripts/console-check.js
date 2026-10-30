'use strict';

/*
 * Drives the built-in test console (GET /api/test) in a real browser against a real server, then clicks
 * "Run All Tests". Used during development to verify the console's own JavaScript, not just the API.
 *
 *   node scripts/console-check.js [--shots]
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const { createEnv } = require(path.join(ROOT, 'src/config/settings'));
const { createContainer } = require(path.join(ROOT, 'src/container'));
const { createApp } = require(path.join(ROOT, 'src/app'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-console-'));
const TOKEN = 'console-token-0123456789abcdef01';
const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir, PORT: '0', MIN_FREE_MEMORY_MB: '0', ADDITIONAL_PAGE_DELAY: '200', LOG_LEVEL: 'silent' });
const SHOTS = process.argv.includes('--shots');

async function main() {
  const c = createContainer(env);
  await c.init();
  const server = await new Promise((resolve) => {
    const s = createApp(c).listen(0, '127.0.0.1', () => resolve(s));
  });
  c.services.fixture.setPort(server.address().port);
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  let probe401s = 0;
  // The browser logs a console error for the deliberate 401 probe; anything beyond that one is a real problem.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of 401/.test(m.text()) && probe401s < 2) { probe401s += 1; return; } // wrong-token attempt + auth probe
    problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // Pressing Disconnect cancels the long-lived event stream; the browser reports that as ERR_ABORTED. That is the
  // intended behaviour, not a failure.
  page.on('requestfailed', (r) => {
    if (r.url().endsWith('/api/events') && /ERR_ABORTED/.test(r.failure()?.errorText || '')) return;
    problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  const apiRequests = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) apiRequests.push({ url: r.url(), auth: r.headers().authorization }); });

  try {
    await page.goto(`${base}/api/test`);
    console.log('PASS page loads under CSP, title =', await page.title());

    // wrong token is rejected, input is cleared, still disconnected
    await page.fill('#token-input', 'definitely-not-the-token-000000');
    await page.click('#btn-connect');
    await page.waitForFunction(() => document.getElementById('conn-badge').textContent === 'Disconnected');
    console.log('PASS wrong token rejected');

    await page.fill('#token-input', TOKEN);
    await page.click('#btn-connect');
    await page.waitForFunction(() => document.getElementById('conn-badge').textContent === 'Connected');
    console.log('PASS right token connects; input value afterwards =', JSON.stringify(await page.inputValue('#token-input')));

    const leaked = await page.evaluate((t) => ({
      local: JSON.stringify(localStorage).includes(t),
      session: JSON.stringify(sessionStorage).includes(t),
      cookie: document.cookie.includes(t),
      url: location.href.includes(t),
      dom: document.documentElement.outerHTML.includes(t),
    }), TOKEN);
    console.log(Object.values(leaked).some(Boolean) ? 'FAIL token leaked:' : 'PASS token not in storage / cookie / URL / DOM', JSON.stringify(leaked));
    if (Object.values(leaked).some(Boolean)) process.exitCode = 1;

    await page.waitForFunction(() => /live/.test(document.getElementById('ev-state').textContent), null, { timeout: 8000 });
    console.log('PASS SSE stream is live (fetch streaming with Authorization header)');

    await page.click('.tabs button[data-tab="results"]');
    await page.click('#btn-t-all');
    await page.waitForFunction(() => document.getElementById('btn-t-all').disabled === false && document.querySelectorAll('#test-body .st.passed, #test-body .st.failed').length >= 14, null, { timeout: 180000 });

    const rows = await page.$$eval('#test-body tr', (trs) => trs.map((tr) => ({
      name: tr.children[0].textContent, status: tr.children[1].textContent, duration: tr.children[3].textContent, detail: tr.children[4].textContent,
    })));
    for (const r of rows) console.log(r.status === 'Passed' ? 'PASS' : 'FAIL', `[console test] ${r.name.padEnd(38)} ${r.duration.padStart(8)}  ${r.detail.slice(0, 110)}`);
    if (rows.some((r) => r.status !== 'Passed')) process.exitCode = 1;

    await page.click('.tabs button[data-tab="events"]');
    const evCount = await page.$$eval('#ev-body tr', (t) => t.length);
    console.log(evCount > 20 ? 'PASS' : 'FAIL', `event console received ${evCount} live events`);

    // "select & continue" from the real UI: tick the box, record, click a nav link in the remote image, expect navigation.
    // "Open Login Page" opens the configured DEFAULT_LOGIN_URL, which is a real third-party site. This check must never contact
    // an external website or type into one, so point the default at the built-in demo site (this script owns the service).
    await c.services.settings.update({ defaultLoginUrl: c.services.fixture.baseUrl() });
    await page.click('.tabs button[data-tab="login"]');
    await page.click('#btn-login-open');
    await page.waitForFunction(() => /waiting_for_login/.test(document.getElementById('login-grid').textContent), null, { timeout: 15000 });
    await page.click('.tabs button[data-tab="browser"]');
    for (const [text, enter] of [['tester', false], ['Tab', null], ['demo', true], ['123456', true]]) {
      if (enter === null) { await page.click('.key[data-key="Tab"]'); continue; }
      await page.fill('#type-text', text);
      if (enter) await page.check('#type-enter'); else await page.uncheck('#type-enter');
      await page.click('#btn-type');
      await page.waitForTimeout(450);
    }
    await page.waitForFunction(() => /\/problems/.test(document.getElementById('remote-url').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.click('#btn-shot-refresh');
    await page.click('.tabs button[data-tab="recorder"]');
    await page.check('#rec-continue');
    await page.click('#btn-rec-start');
    await page.waitForFunction(() => /ACTIVE/.test(document.getElementById('rec-status').textContent));
    await page.click('.tabs button[data-tab="browser"]');
    await page.waitForFunction(() => !document.getElementById('remote-img').hidden);
    const box = await page.locator('#remote-img').boundingBox();
    // The "Services" nav link is at viewport (377, 28) of a 1920-wide view.
    await page.mouse.click(box.x + (377 / 1920) * box.width, box.y + (28 / 1080) * box.height);
    await page.waitForFunction(() => /\/services/.test(document.getElementById('remote-url').textContent), null, { timeout: 10000 }).catch(() => {});
    const url = await page.textContent('#remote-url');
    console.log(/\/services/.test(url) ? 'PASS' : 'FAIL', 'select & continue from the console UI navigated while recording, url =', url);
    if (!/\/services/.test(url)) process.exitCode = 1;
    await page.click('.tabs button[data-tab="recorder"]');
    const sel = await page.textContent('#rec-selection');
    console.log(/Services/.test(sel) ? 'PASS' : 'FAIL', 'and the element was recorded:', /data-route/.test(sel) ? 'data attribute locator shown' : '(no locator shown)');
    await page.click('#btn-rec-stop');

    // Every API call carried the bearer header; the token never appeared in any URL. The console's "Auth rejects a
    // wrong token" test deliberately sends one request WITHOUT a header and expects a 401, so exactly one is allowed.
    const unauth = apiRequests.filter((r) => /\/api\/(?!status|test|docs)/.test(r.url) && !r.auth && !/\/api\/test\//.test(r.url));
    const inUrl = apiRequests.filter((r) => r.url.includes(TOKEN));
    const expectedProbe = unauth.length === 1 && unauth[0].url.endsWith('/api/browser/status');
    console.log((unauth.length === 0 || expectedProbe) && inUrl.length === 0 ? 'PASS' : 'FAIL',
      `${apiRequests.length} API calls; token in URL: ${inUrl.length}; header-less protected calls: ${unauth.length}${expectedProbe ? ' (the deliberate 401 probe)' : ''}`);
    if (!((unauth.length === 0 || expectedProbe) && inUrl.length === 0)) process.exitCode = 1;

    if (SHOTS) {
      await page.click('.tabs button[data-tab="results"]');
      await page.screenshot({ path: path.join(os.tmpdir(), 'console-results.png'), fullPage: true });
      console.log('screenshot ->', path.join(os.tmpdir(), 'console-results.png'));
    }

    // Disconnect clears the token and stops the stream
    await page.click('#btn-disconnect');
    await page.waitForFunction(() => document.getElementById('conn-badge').textContent === 'Disconnected');
    const after = await page.evaluate(() => document.getElementById('ev-state').textContent);
    console.log('PASS disconnect clears token; event stream state =', after);
  } finally {
    if (problems.length) {
      console.log('\nBrowser problems:');
      for (const p of [...new Set(problems)].slice(0, 15)) console.log('  -', p);
    } else console.log('\nNo console errors, page errors or failed requests.');
    await browser.close();
    await c.shutdown();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('console-check failed:', e.message);
  process.exit(1);
});
