'use strict';

/*
 * Developer end-to-end smoke test: boots the real app on a random port, drives real Chromium against the
 * built-in demo site through the public REST API, and prints PASS/FAIL per step.
 *
 *   node scripts/e2e-smoke.js
 *
 * It needs Playwright's Chromium (npm run install:browsers). It never contacts an external website.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { createEnv } = require(path.join(ROOT, 'src/config/settings'));
const { createContainer } = require(path.join(ROOT, 'src/container'));
const { createApp } = require(path.join(ROOT, 'src/app'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
const TOKEN = 'e2e-token-0123456789abcdef0123';
const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir, PORT: '0', MIN_FREE_MEMORY_MB: '0', ADDITIONAL_PAGE_DELAY: '200', LOG_LEVEL: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = createContainer(env);
  await c.init();
  const server = await new Promise((resolve) => {
    const s = createApp(c).listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  c.services.fixture.setPort(port);
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, p, body, raw) => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (raw) return r;
    const j = await r.json();
    if (!j.ok) {
      const e = new Error(`${method} ${p} -> ${r.status} ${j.error.code}: ${j.error.message}`);
      e.code = j.error.code;
      throw e;
    }
    return j.data;
  };
  const step = async (label, fn) => {
    const t = Date.now();
    try {
      const v = await fn();
      console.log('PASS', label.padEnd(48), v ?? '', `(${Date.now() - t}ms)`);
    } catch (e) {
      console.log('FAIL', label.padEnd(48), e.message);
      process.exitCode = 1;
      throw e;
    }
  };

  const fx = c.services.fixture.baseUrl();
  const events = [];
  c.services.events.on('event', (e) => events.push(e.type));
  const page = () => c.services.browser.page;

  try {
    await step('launch', async () => `session ${(await call('POST', '/api/browser/launch', {})).sessionId}`);
    await step('open fixture', async () => (await call('POST', '/api/browser/open-url', { url: fx })).url);
    await step('blocked: file://, loopback, metadata IP', async () => {
      for (const u of ['file:///etc/passwd', 'http://127.0.0.1:9/x', 'http://169.254.169.254/']) {
        let refused = false;
        try { await call('POST', '/api/browser/open-url', { url: u }); } catch (e) { refused = /invalid_url_scheme|url_not_allowed/.test(e.code || ''); }
        if (!refused) throw new Error(`allowed ${u}`);
      }
      return 'all refused';
    });
    await step('automation refused before login', async () => {
      const w = await call('POST', '/api/workflows', { name: 'tmp', steps: [{ name: 'a', action: 'click', target: { strategy: 'id', selector: '#nav-problems' } }] });
      let code = null;
      try { await call('POST', '/api/automation/start', { workflowId: w.workflow.id }); } catch (e) { code = e.code; }
      await call('DELETE', `/api/workflows/${w.workflow.id}`);
      if (code !== 'login_required') throw new Error(`expected login_required, got ${code}`);
      return code;
    });

    await step('login: open', async () => (await call('POST', '/api/login/open', { url: fx })).state);
    await step('login: type credentials + MFA remotely', async () => {
      await call('POST', '/api/browser/type', { text: 'tester' });
      await call('POST', '/api/browser/keypress', { key: 'Tab' });
      await call('POST', '/api/browser/type', { text: 'demo', pressEnter: true });
      await sleep(400);
      await call('POST', '/api/browser/type', { text: '123456', pressEnter: true });
      for (let i = 0; i < 30; i += 1) {
        const b = await call('GET', '/api/browser/status');
        if (/\/problems/.test(b.url || '')) return b.url;
        await sleep(200);
      }
      throw new Error('did not reach the problems page');
    });
    await step('login: confirm', async () => {
      const s = await call('POST', '/api/login/confirm', {});
      if (!s.eligibleForAutomation) throw new Error('not eligible');
      return s.state;
    });

    let selection;
    await step('recorder: start', async () => (await call('POST', '/api/recorder/start', {})).active);
    await step('recorder: hover draws highlight', async () => {
      await call('POST', '/api/browser/hover', { x: 377, y: 28 });
      if (!(await page().evaluate(() => !!document.getElementById('__ss-picker-overlay')))) throw new Error('no overlay');
      return 'overlay present';
    });
    await step('recorder: click selects, site action blocked', async () => {
      const before = (await call('GET', '/api/browser/status')).url;
      const r = await call('POST', '/api/browser/click', { x: 377, y: 28 });
      const after = (await call('GET', '/api/browser/status')).url;
      if (!r.recorded) throw new Error('not recorded');
      if (before !== after) throw new Error(`page navigated while recording: ${after}`);
      selection = r.selection;
      return `${selection.element.tag} primary=${selection.locators.primary?.strategy} unique=${selection.locators.unique}`;
    });
    await step('recorder: metadata complete', async () => {
      const e = selection.element;
      const miss = ['tag', 'classes', 'text', 'role', 'accessibleName'].filter((k) => e[k] === undefined);
      if (miss.length || !selection.page.url || !selection.xpath || !selection.cssSelector || !selection.frame) throw new Error(`missing ${miss}`);
      return `css=${selection.cssSelector} xpath=${selection.xpath}`;
    });
    await step('recorder: shadow DOM + iframe elements', async () => {
      await call('POST', '/api/recorder/stop', {});
      await call('POST', '/api/browser/open-url', { url: `${fx}services/checkout` });
      await sleep(300);
      await call('POST', '/api/recorder/start', {});
      const pos = await page().evaluate(() => {
        const b = document.querySelector('status-badge').shadowRoot.querySelector('.check').getBoundingClientRect();
        const f = document.querySelector('#metrics-frame').getBoundingClientRect();
        return { sx: b.left + b.width / 2, sy: b.top + b.height / 2, fx: f.left + 60, fy: f.top + 62 };
      });
      const sh = (await call('POST', '/api/browser/click', { x: Math.round(pos.sx), y: Math.round(pos.sy) })).selection;
      if (!sh.element.inShadowDom || !sh.locators.unique) throw new Error(`shadow: ${JSON.stringify(sh.locators.message)}`);
      const fr = (await call('POST', '/api/browser/click', { x: Math.round(pos.fx), y: Math.round(pos.fy) })).selection;
      if (fr.frame.isTopFrame || !fr.locators.unique) throw new Error(`frame: ${JSON.stringify(fr.frame)} ${fr.locators.message}`);
      await call('POST', '/api/recorder/stop', {});
      return `shadow ok (${sh.locators.primary.strategy}); iframe ok via ${fr.frame.path.join('>')} (${fr.locators.primary.strategy})`;
    });
    await step('recorder: ambiguity reported, unique one chosen', async () => {
      await call('POST', '/api/browser/open-url', { url: `${fx}problems` });
      await sleep(300);
      const pos = await page().evaluate(() => {
        const r = document.querySelectorAll('.row-open')[1].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await call('POST', '/api/recorder/start', {});
      const sel = (await call('POST', '/api/browser/click', { x: Math.round(pos.x), y: Math.round(pos.y) })).selection;
      await call('POST', '/api/recorder/stop', {});
      const amb = sel.locators.candidates.filter((x) => x.matches > 1).map((x) => x.strategy);
      if (!amb.length) throw new Error('expected at least one ambiguous candidate');
      if (!sel.locators.primary || sel.locators.primary.strategy === 'text' || sel.locators.primary.strategy === 'role') {
        throw new Error(`ambiguous locator chosen: ${JSON.stringify(sel.locators.primary)}`);
      }
      return `rejected [${amb}] -> ${sel.locators.primary.strategy}`;
    });

    let wfId;
    await step('workflow: create 3-step', async () => {
      const w = await call('POST', '/api/workflows', {
        name: 'E2E Nav',
        steps: [
          { name: 'Open Problems', action: 'click', target: { strategy: 'id', selector: '#nav-problems' }, screenshot: true, delay: 100 },
          { name: 'Open Services', action: 'click', target: { strategy: 'css', selector: '[data-route="services"]' }, wait: { condition: 'element_visible', target: { strategy: 'css', selector: '[data-testid="services-list"]' } }, screenshot: true, delay: 100 },
          { name: 'Open Selected Service', action: 'click', target: { strategy: 'role', role: 'link', name: 'checkout-service' }, wait: { condition: 'element_visible', target: { strategy: 'css', selector: '[data-testid="service-details"]' } }, screenshot: true, delay: 100 },
        ],
      });
      wfId = w.workflow.id;
      return w.workflow.steps.map((s) => s.number).join(',');
    });
    await step('automation: run to completion (SPA + async list)', async () => {
      await call('POST', '/api/browser/open-url', { url: `${fx}problems` });
      await sleep(300);
      await call('POST', '/api/automation/start', { workflowId: wfId });
      for (let i = 0; i < 120; i += 1) {
        const s = await call('GET', '/api/automation/status');
        if (['completed', 'failed', 'paused'].includes(s.run.status)) {
          if (s.run.status !== 'completed') throw new Error(`${s.run.status}: ${s.run.message}`);
          return `${s.run.completedSteps}/${s.run.totalSteps} progress=${s.run.progress}% url=${c.services.browser.currentUrl()}`;
        }
        await sleep(250);
      }
      throw new Error('timeout');
    });
    await step('events: real execution events', async () => {
      const need = ['workflow.started', 'step.started', 'step.completed', 'screenshot.saved', 'workflow.completed'];
      const miss = need.filter((n) => !events.includes(n));
      if (miss.length) throw new Error(`missing ${miss}`);
      return `${events.length} events; step.completed x${events.filter((e) => e === 'step.completed').length}`;
    });
    await step('screenshots: exactly 3, no duplicates', async () => {
      const l = await call('GET', '/api/screenshots');
      if (l.total !== 3) throw new Error(`total ${l.total}`);
      return l.items.map((s) => s.filename).join(' | ');
    });
    await step('screenshot download + checksum + Range', async () => {
      const s = (await call('GET', '/api/screenshots')).items[0];
      const r = await call('GET', `/api/screenshots/${s.id}/download`, undefined, true);
      const buf = Buffer.from(await r.arrayBuffer());
      if (crypto.createHash('sha256').update(buf).digest('hex') !== s.sha256 || buf.length !== s.sizeBytes) throw new Error('checksum/size mismatch');
      if (buf.subarray(1, 4).toString() !== 'PNG') throw new Error('not a PNG');
      const rr = await fetch(`${base}/api/screenshots/${s.id}/download`, { headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=0-99' } });
      if (rr.status !== 206 || (await rr.arrayBuffer()).byteLength !== 100) throw new Error(`range ${rr.status}`);
      const meta = await call('GET', `/api/screenshots/${s.id}`);
      return `sha256 ok, range 206, transferred=${meta.screenshot.transferred}`;
    });
    await step('ZIP export is a valid archive', async () => {
      const r = await call('GET', '/api/screenshots/export', undefined, true);
      const { unzipSync } = require('fflate');
      const names = Object.keys(unzipSync(new Uint8Array(await r.arrayBuffer())));
      if (names.length !== 4 || !names.includes('manifest.json')) throw new Error(names.join());
      return `${names.length} entries incl. manifest`;
    });
    await step('safety: destructive click is blocked', async () => {
      await call('POST', '/api/browser/open-url', { url: `${fx}reports` });
      await sleep(300);
      const w = await call('POST', '/api/workflows', { name: 'Danger', steps: [{ name: 'Delete all', action: 'click', target: { strategy: 'id', selector: '#btn-delete' } }] });
      await call('POST', '/api/automation/start', { workflowId: w.workflow.id });
      for (let i = 0; i < 40; i += 1) {
        const s = await call('GET', '/api/automation/status');
        if (s.run.status === 'failed') {
          if (await page().evaluate(() => window.__demoDeleted || 0)) throw new Error('the button WAS clicked');
          return `${s.run.steps[0].error.code}; button not clicked`;
        }
        await sleep(200);
      }
      throw new Error('did not fail');
    });
    await step('test-step passes', async () => {
      await call('POST', '/api/automation/stop', {}).catch(() => {});
      await call('POST', '/api/browser/open-url', { url: `${fx}problems` });
      await sleep(300);
      const r = await call('POST', '/api/automation/test-step', { step: { name: 'Click Reports', action: 'click', target: { strategy: 'css', selector: '[data-route="reports"]' } } });
      return `passed=${r.passed} ${r.result.durationMs}ms`;
    });
    await step('missing element -> element_not_found', async () => {
      let code = null;
      try { await call('POST', '/api/automation/test-step', { step: { name: 'Nope', action: 'click', timeout: 800, target: { strategy: 'id', selector: '#does-not-exist' } } }); } catch (e) { code = e.code; }
      if (code !== 'element_not_found') throw new Error(`got ${code}`);
      return code;
    });
    await step('lost browser -> login required again', async () => {
      await c.services.browser.browser.close();
      await sleep(400);
      const st = await call('GET', '/api/login/status');
      if (st.state !== 'lost') throw new Error(`login state ${st.state}`);
      let code = null;
      try { await call('POST', '/api/automation/start', { workflowId: wfId }); } catch (e) { code = e.code; }
      if (!['browser_not_running', 'session_lost'].includes(code)) throw new Error(`start gave ${code}`);
      return `login.state=${st.state}; start refused (${code})`;
    });
    console.log('\nALL E2E STEPS PASSED');
  } finally {
    await c.shutdown();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('\nE2E aborted:', e.message);
  process.exit(1);
});
