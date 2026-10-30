'use strict';

const { EventEmitter } = require('node:events');

/**
 * A minimal stand-in for Playwright's `chromium` launcher so API integration tests can run without a real browser.
 * It records calls and lets a test simulate a crash. Behaviour that depends on a real DOM is covered by the
 * browser tests, not by this fake.
 */
class FakePage extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this._url = 'about:blank';
    this._closed = false;
    this.calls = [];
    this.mouse = {
      move: async (x, y) => this.calls.push(['mouse.move', x, y]),
      click: async (x, y, o) => this.calls.push(['mouse.click', x, y, o]),
      wheel: async (dx, dy) => this.calls.push(['mouse.wheel', dx, dy]),
    };
    this.keyboard = {
      type: async (text) => this.calls.push(['keyboard.type', text.length]),
      press: async (key) => this.calls.push(['keyboard.press', key]),
    };
  }

  url() { return this._url; }
  isClosed() { return this._closed; }
  viewportSize() { return this._viewport || { width: 1920, height: 1080 }; }
  async setViewportSize(v) { this._viewport = v; }
  async title() { return 'Fake page'; }
  async goto(url) { this._url = url; this.calls.push(['goto', url]); return { status: () => 200, ok: () => true }; }
  async reload() { this.calls.push(['reload']); }
  async waitForLoadState() {}
  async waitForTimeout() {}
  /**
   * The service only evaluates small probes in the page (login-form detection, scroll position). A page with no DOM
   * answers "no" to all of them. Returning a truthy object here would make the runner believe a login form is visible.
   */
  async evaluate(fn) {
    return /scrollX|scrollY/.test(String(fn)) ? { x: 0, y: 0 } : false;
  }
  mainFrame() { return this; }
  frames() { return [this]; }
  async screenshot(opts = {}) {
    this.calls.push(['screenshot', opts.type]);
    // A real (tiny) PNG, so downloads and ZIP exports carry valid image bytes.
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  }
  async close() { this._closed = true; this.emit('close'); }
  crash() { this.emit('crash'); }
}

class FakeContext extends EventEmitter {
  constructor(browser) {
    super();
    this.browser = browser;
    this._pages = [];
  }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async route() {}
  pages() { return this._pages.filter((p) => !p._closed); }
  async newPage() {
    const page = new FakePage(this);
    this._pages.push(page);
    return page;
  }
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this._connected = true;
    this.contexts = [];
  }
  isConnected() { return this._connected; }
  async newContext() {
    const context = new FakeContext(this);
    this.contexts.push(context);
    return context;
  }
  async close() {
    if (!this._connected) return;
    this._connected = false;
    this.emit('disconnected');
  }
  /** Simulate Chromium dying underneath the service. */
  kill() {
    this._connected = false;
    this.emit('disconnected');
  }
}

function createFakeLauncher({ fail = null } = {}) {
  const launcher = {
    launches: 0,
    last: null,
    failWith: fail,
    executablePath: () => process.execPath, // any existing file satisfies the "installed" check
    async launch() {
      launcher.launches += 1;
      if (launcher.failWith) throw new Error(launcher.failWith);
      launcher.last = new FakeBrowser();
      return launcher.last;
    },
  };
  return launcher;
}

module.exports = { createFakeLauncher, FakeBrowser, FakePage };
