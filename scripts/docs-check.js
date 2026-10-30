'use strict';

/*
 * Loads Swagger UI (/api/docs) in a real browser against a real server and checks that it renders under its
 * Content-Security-Policy, lists the operations, accepts the bearer token, and can execute a request.
 *
 *   node scripts/docs-check.js
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const { createEnv } = require(path.join(ROOT, 'src/config/settings'));
const { createContainer } = require(path.join(ROOT, 'src/container'));
const { createApp } = require(path.join(ROOT, 'src/app'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-docs-'));
const TOKEN = 'docs-token-0123456789abcdef0123456';
const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir, PORT: '0', LOG_LEVEL: 'silent' });

async function main() {
  const c = createContainer(env);
  await c.init();
  const server = await new Promise((resolve) => {
    const s = createApp(c).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  let ok = true;
  const check = (cond, label, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', label, extra); if (!cond) ok = false; };

  try {
    await page.goto(`${base}/api/docs/`);
    await page.waitForSelector('.swagger-ui .opblock', { timeout: 15000 });
    check(true, 'Swagger UI rendered under its CSP, title =', JSON.stringify(await page.title()));
    const ops = await page.locator('.opblock').count();
    check(ops === 55, `lists every operation (${ops} of 55)`);
    check((await page.locator('.info .title').innerText()).includes('Cloud Screenshot'), 'shows the API title');
    check(await page.locator('.authorize').first().isVisible(), 'has an Authorize button');

    // Authorize with the token, then execute GET /api/browser/status through the UI.
    await page.locator('.authorize').first().click();
    await page.locator('.auth-container input[type=text], .auth-container input[type=password]').first().fill(TOKEN);
    await page.locator('.auth-btn-wrapper .authorize').click();
    await page.locator('.btn-done').click();

    await page.locator('#operations-Browser-get_api_browser_status').scrollIntoViewIfNeeded();
    await page.locator('#operations-Browser-get_api_browser_status .opblock-summary-control').click();
    // The service enables "Try it out" by default (tryItOutEnabled), so the button already reads "Cancel" here.
    // Clicking it would switch try-out OFF again and remove the Execute button; only click it if it is still "Try it out".
    const tryOut = page.locator('#operations-Browser-get_api_browser_status .try-out__btn');
    check((await tryOut.innerText()).trim() === 'Cancel', 'Try it out is enabled by default for authorised testers');
    await page.locator('#operations-Browser-get_api_browser_status .execute').click();
    // The live table has a header cell ("Code") and a data cell ("200") with the same class; take the data cell.
    const cell = page.locator('#operations-Browser-get_api_browser_status .live-responses-table td.response-col_status:not(.col_header)');
    await cell.first().waitFor({ timeout: 10000 });
    const status = await cell.first().innerText();
    check(status.trim().startsWith('200'), 'executes an authenticated call from Swagger UI, status =', JSON.stringify(status.trim()));

    // Without the token the same call must be rejected.
    const anon = await page.evaluate(async () => (await fetch('/api/browser/status')).status);
    check(anon === 401, 'the same endpoint without a token is 401, status =', anon);
    await page.screenshot({ path: path.join(os.tmpdir(), 'swagger.png'), fullPage: false });
  } finally {
    const real = problems.filter((p) => !/status of 401/.test(p));
    check(real.length === 0, 'no console errors, page errors or failed requests', real.length ? JSON.stringify(real.slice(0, 5)) : '');
    await browser.close();
    await c.shutdown();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('docs-check failed:', e.message);
  process.exit(1);
});
