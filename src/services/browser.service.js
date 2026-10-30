'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { err } = require('../errors');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/date-utils');
const { getMemoryInfo } = require('../utils/memory');
const { assertNavigableUrl, sanitizeUrl, isPrivateHost } = require('../utils/url-utils');
const { toAppError, firstLine } = require('../utils/playwright-errors');

const LAUNCH_ARGS = ['--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check'];
const LOW_MEMORY_ARGS = [
  '--renderer-process-limit=1',
  '--disable-background-networking',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
];

/**
 * Owns the single Chromium instance, its one browser context and the active page.
 *
 * Only one session exists at a time to stay inside Render Free's CPU / memory budget. Cookies and
 * storage live only inside this in-memory context: nothing is written to disk, logged or returned.
 *
 * Emits: 'session-lost' ({ reason }) when the browser closes or disconnects unexpectedly or is closed on purpose.
 */
class BrowserService extends EventEmitter {
  constructor({ env, settings, events, fixture = null, memoryProbe = getMemoryInfo, launcher = chromium }) {
    super();
    this.env = env;
    this.settings = settings;
    this.events = events;
    this.fixture = fixture;
    this.memoryProbe = memoryProbe;
    this.launcher = launcher;

    this.state = 'closed'; // closed | starting | ready | closing
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.launchedAt = null;
    this.headless = null;
    this.pageCrashed = false;
    this.lastUrl = null; // raw URL, kept only in memory to recover a crashed page
    this.lastError = null;
    this.closedReason = null;
    this.blockedRequests = 0;
    this.lastDialog = null;
    this._starting = null;
    this._closing = null;
    this._recovering = null;
    this._pageListeners = new WeakSet();

    settings.on('change', ({ changed, values }) => this._applySettings(changed, values));
  }

  // ---------------------------------------------------------------------------------------------
  // Availability / status
  // ---------------------------------------------------------------------------------------------

  executableFound() {
    try {
      return fs.existsSync(this.launcher.executablePath());
    } catch {
      return false;
    }
  }

  get isReady() {
    return this.state === 'ready' && Boolean(this.browser?.isConnected());
  }

  currentUrl({ raw = false } = {}) {
    if (!this.isReady || !this.page || this.page.isClosed()) return null;
    const url = this.page.url();
    return raw ? url : sanitizeUrl(url);
  }

  async status() {
    const base = {
      available: this.executableFound(),
      state: this.state,
      connected: this.isReady,
      sessionId: this.sessionId,
      launchedAt: this.launchedAt,
      headless: this.headless,
      pageState: !this.isReady ? 'none' : this.pageCrashed ? 'crashed' : this.page?.isClosed() ? 'closed' : 'ok',
      pageCount: this.isReady ? this.context.pages().length : 0,
      url: this.currentUrl(),
      title: null,
      viewport: this.isReady ? this.page?.viewportSize?.() ?? null : null,
      closedReason: this.closedReason,
      lastError: this.lastError,
      blockedRequests: this.blockedRequests,
      engine: 'chromium',
    };
    if (this.isReady && this.page && !this.page.isClosed() && !this.pageCrashed) {
      try {
        base.title = await Promise.race([this.page.title(), new Promise((r) => setTimeout(() => r(null), 1500))]);
      } catch {
        base.title = null;
      }
    }
    return base;
  }

  // ---------------------------------------------------------------------------------------------
  // Launch / close
  // ---------------------------------------------------------------------------------------------

  async launch({ headless } = {}) {
    if (this._closing) await this._closing.catch(() => {});
    if (this.isReady) return { alreadyRunning: true, ...(await this.status()) };
    if (this._starting) {
      await this._starting;
      return { alreadyRunning: false, ...(await this.status()) };
    }
    this._starting = this._doLaunch({ headless }).finally(() => {
      this._starting = null;
    });
    await this._starting;
    return { alreadyRunning: false, ...(await this.status()) };
  }

  async _doLaunch({ headless }) {
    const values = this.settings.get();
    const useHeadless = headless ?? values.headless;

    if (!this.executableFound()) {
      throw err.unavailable('browser_not_installed', 'The Chromium executable was not found.', {
        hint: 'Run "npx playwright install chromium" (the Docker image already contains it).',
      });
    }
    const mem = this.memoryProbe();
    if (this.env.minFreeMemoryMB > 0 && mem.availableMB < this.env.minFreeMemoryMB) {
      throw err.unavailable('insufficient_memory', `Not enough free memory to start Chromium (${mem.availableMB} MB available).`, {
        details: { availableMB: mem.availableMB, requiredMB: this.env.minFreeMemoryMB, limitMB: mem.limitMB },
        hint: 'Close other work, wait for the service to settle, or lower MIN_FREE_MEMORY_MB at your own risk.',
      });
    }

    this.state = 'starting';
    this.closedReason = null;
    this.lastError = null;
    this.events.emitEvent('browser.starting', 'Starting Chromium.');
    try {
      const args = [...LAUNCH_ARGS, ...(this.env.browserLowMemory ? LOW_MEMORY_ARGS : [])];
      const browser = await this.launcher.launch({ headless: useHeadless, args, timeout: 60000 });
      this.browser = browser;
      this.headless = useHeadless;
      browser.on('disconnected', () => this._onDisconnected(browser));

      const context = await browser.newContext({
        viewport: { width: values.viewportWidth, height: values.viewportHeight },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        permissions: [],
        locale: 'en-US',
      });
      this.context = context;
      context.setDefaultTimeout(values.elementTimeout);
      context.setDefaultNavigationTimeout(values.navigationTimeout);
      await this._installRequestGuard(context);
      context.on('page', (p) => this._onNewPage(p));

      const page = await context.newPage();
      this._adoptPage(page);
      this.sessionId = crypto.randomBytes(6).toString('hex');
      this.launchedAt = nowIso();
      this.pageCrashed = false;
      this.state = 'ready';
      logger.info('Chromium started', { sessionId: this.sessionId, headless: useHeadless });
      this.events.emitEvent('browser.ready', 'Chromium is ready.', { data: { sessionId: this.sessionId } });
    } catch (e) {
      this.lastError = firstLine(e);
      await this._teardown();
      this.state = 'closed';
      this.closedReason = 'launch_failed';
      logger.error('Chromium failed to start', { error: e });
      const insufficient = /out of memory|cannot allocate|enomem|spawn .*eagain/i.test(String(e?.message));
      throw err.internal(insufficient ? 'insufficient_memory' : 'browser_launch_failed', 'Chromium could not be started.', {
        details: { reason: firstLine(e) },
        hint: insufficient ? 'The container ran out of memory while starting the browser.' : undefined,
      });
    }
  }

  /** Block sub-requests that target private networks (SSRF) unless private URLs were explicitly enabled. */
  async _installRequestGuard(context) {
    if (this.env.allowPrivateUrls) return;
    await context.route(
      (url) => {
        if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
        if (this.fixture?.isFixtureUrl(url.href)) return false;
        return isPrivateHost(url.hostname);
      },
      (route) => {
        this.blockedRequests += 1;
        return route.abort('blockedbyclient').catch(() => {});
      },
    );
  }

  _onNewPage(page) {
    // Login and SSO flows often open a popup; follow it so the user can complete the flow remotely.
    if (this.state !== 'ready') return;
    this._adoptPage(page);
    this.pageCrashed = false;
  }

  _adoptPage(page) {
    this.page = page;
    const values = this.settings.get();
    page.setViewportSize({ width: values.viewportWidth, height: values.viewportHeight }).catch(() => {});
    if (this._pageListeners.has(page)) return;
    this._pageListeners.add(page);

    page.on('crash', () => {
      if (this.page !== page) return;
      this.pageCrashed = true;
      logger.warn('Browser page crashed');
      this.events.emitEvent('browser.page_crashed', 'The browser page crashed. It will be recreated on the next action.');
      this.emit('page-crashed');
    });
    page.on('close', () => {
      if (this.page !== page || this.state !== 'ready') return;
      const remaining = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
      this.page = remaining.at(-1) ?? null;
      if (!this.page) this.pageCrashed = true; // forces recreation (about:blank + last URL) on next use
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.lastUrl = frame.url();
    });
    // Dialogs are always dismissed, never accepted: automation must not confirm anything implicitly.
    page.on('dialog', (dialog) => {
      this.lastDialog = { type: dialog.type(), at: nowIso() };
      dialog.dismiss().catch(() => {});
    });
  }

  _onDisconnected(browser) {
    if (this.browser !== browser) return;
    const intentional = this.state === 'closing';
    this.state = 'closed';
    this.closedReason = intentional ? 'closed' : 'disconnected';
    this._clearHandles();
    if (!intentional) {
      logger.warn('Chromium disconnected unexpectedly');
      this.events.emitEvent('browser.disconnected', 'Chromium closed or disconnected unexpectedly; the browser session was lost.');
    }
    this.emit('session-lost', { reason: this.closedReason });
  }

  _clearHandles() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.launchedAt = null;
    this.pageCrashed = false;
  }

  async _teardown() {
    const browser = this.browser;
    this._clearHandles();
    if (browser) await browser.close().catch(() => {});
  }

  async close() {
    if (this._closing) return this._closing;
    if (this._starting) await this._starting.catch(() => {});
    if (this.state === 'closed' && !this.browser) return { closed: true, wasRunning: false };
    const wasRunning = this.isReady;
    this._closing = (async () => {
      this.state = 'closing';
      const browser = this.browser;
      try {
        await browser?.close();
      } catch (e) {
        logger.warn('Error while closing Chromium', { error: e });
      }
      this._clearHandles();
      this.state = 'closed';
      this.closedReason = 'closed';
      this.lastUrl = null;
      this.emit('session-lost', { reason: 'closed' });
      return { closed: true, wasRunning };
    })().finally(() => {
      this._closing = null;
    });
    return this._closing;
  }

  // ---------------------------------------------------------------------------------------------
  // Page access
  // ---------------------------------------------------------------------------------------------

  /** The live page. Recreates the page when it crashed or was closed; throws when there is no browser. */
  async getPage() {
    if (!this.isReady) {
      throw err.conflict('browser_not_running', 'The browser is not running.', {
        hint: 'Call POST /api/browser/launch. Browser sessions are lost when the service restarts.',
      });
    }
    if (this.page && !this.page.isClosed() && !this.pageCrashed) return this.page;
    return this._recoverPage();
  }

  async _recoverPage() {
    if (this._recovering) return this._recovering;
    this._recovering = (async () => {
      const old = this.page;
      if (old && !old.isClosed()) await old.close({ runBeforeUnload: false }).catch(() => {});
      try {
        const page = await this.context.newPage();
        this._adoptPage(page);
        this.pageCrashed = false;
        if (this.lastUrl && /^https?:/i.test(this.lastUrl)) {
          await page.goto(this.lastUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        this.events.emitEvent('browser.page_recovered', 'The browser page was recreated. You may need to log in again.');
        return page;
      } catch (e) {
        throw toAppError(e, 'action');
      }
    })().finally(() => {
      this._recovering = null;
    });
    return this._recovering;
  }

  /** Run `fn(page)` converting Playwright failures into AppErrors. */
  async withPage(fn, context = 'action') {
    const page = await this.getPage();
    try {
      return await fn(page);
    } catch (e) {
      throw toAppError(e, context);
    }
  }

  /** Validate a URL against the navigation policy (http/https only, no private hosts except the built-in fixture). */
  checkUrl(url) {
    return assertNavigableUrl(url, {
      allowPrivate: this.env.allowPrivateUrls,
      isException: (href) => Boolean(this.fixture?.isFixtureUrl(href)),
    });
  }

  async navigate(url, { waitUntil = 'domcontentloaded', timeout } = {}) {
    const target = this.checkUrl(url);
    const values = this.settings.get();
    return this.withPage(async (page) => {
      const response = await page.goto(target, { waitUntil, timeout: timeout ?? values.navigationTimeout });
      if (values.additionalPageDelay > 0 && waitUntil !== 'commit') {
        await page.waitForLoadState('load', { timeout: Math.min(values.navigationTimeout, 10000) }).catch(() => {});
      }
      return { url: sanitizeUrl(page.url()), status: response?.status() ?? null, ok: response ? response.ok() : null };
    }, 'navigation');
  }

  async screenshotBuffer({ format, type, quality } = {}) {
    const values = this.settings.get();
    const fmt = format ?? values.screenshotFormat;
    const kind = type ?? values.screenshotType;
    return this.withPage(async (page) => {
      const opts = { type: fmt, fullPage: kind === 'fullPage', animations: 'disabled', caret: 'hide', timeout: 20000 };
      if (fmt === 'jpeg') opts.quality = quality ?? values.screenshotQuality;
      const buffer = await page.screenshot(opts);
      return { buffer, format: fmt, type: kind, viewport: page.viewportSize(), url: sanitizeUrl(page.url()) };
    }, 'screenshot');
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  _applySettings(changed, values) {
    if (!this.isReady) return;
    if (changed.includes('elementTimeout')) this.context.setDefaultTimeout(values.elementTimeout);
    if (changed.includes('navigationTimeout')) this.context.setDefaultNavigationTimeout(values.navigationTimeout);
    if ((changed.includes('viewportWidth') || changed.includes('viewportHeight')) && this.page && !this.page.isClosed()) {
      this.page.setViewportSize({ width: values.viewportWidth, height: values.viewportHeight }).catch(() => {});
    }
  }
}

module.exports = { BrowserService };
