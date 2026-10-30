'use strict';

const { err } = require('../errors');
const { Mutex } = require('../utils/async-utils');
const { sanitizeUrl } = require('../utils/url-utils');
const { toAppError } = require('../utils/playwright-errors');

const KEY_NAMES = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const MAX_TYPE_LENGTH = 2000;
const MAX_SCROLL = 20000;

/** Validates a key such as "Enter" or "Control+A". Single printable characters are allowed. */
function parseKey(key) {
  if (typeof key !== 'string' || !key || key.length > 40) throw err.unprocessable('invalid_key', 'key must be a key name such as "Enter" or "Control+A".');
  const parts = key.split('+');
  const main = parts.pop();
  if (parts.some((m) => !MODIFIERS.has(m))) throw err.unprocessable('invalid_key', `Unknown modifier in "${key}". Use Shift, Control, Alt or Meta.`);
  const isChar = [...main].length === 1;
  if (!isChar && !KEY_NAMES.has(main)) {
    throw err.unprocessable('invalid_key', `Unsupported key "${main}".`, { details: { supported: [...KEY_NAMES] } });
  }
  return key;
}

/**
 * Screenshot-based remote control of the cloud browser. The dashboard shows a screenshot and sends
 * viewport coordinates; this service replays them through Playwright's mouse and keyboard.
 *
 * Typed text is never logged, returned or stored: login forms pass through here.
 * Interactions are serialised so a click cannot interleave with a keypress or an automation step.
 */
class RemoteBrowserService {
  constructor({ browser, events, settings, recorder = null }) {
    this.browser = browser;
    this.events = events;
    this.settings = settings;
    this.recorder = recorder;
    this.lock = new Mutex();
    this.guard = null; // set by AutomationService: () => throws while a workflow is running
  }

  setRecorder(recorder) {
    this.recorder = recorder;
  }

  _assertNotAutomating() {
    if (this.guard) this.guard();
  }

  async _run(fn, context = 'action') {
    this._assertNotAutomating();
    return this.lock.runExclusive(async () => {
      this._assertNotAutomating();
      const page = await this.browser.getPage();
      try {
        return await fn(page);
      } catch (e) {
        throw toAppError(e, context);
      }
    });
  }

  viewport(page) {
    return page.viewportSize() || { width: this.settings.get().viewportWidth, height: this.settings.get().viewportHeight };
  }

  _point(page, x, y) {
    const vp = this.viewport(page);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw err.unprocessable('invalid_coordinates', 'x and y must be numbers.');
    if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
      throw err.unprocessable('coordinates_out_of_range', `Coordinates (${x}, ${y}) are outside the ${vp.width}x${vp.height} viewport.`, { details: { viewport: vp } });
    }
    return { x: Math.min(x, vp.width - 1), y: Math.min(y, vp.height - 1), viewport: vp };
  }

  async _settle(page, ms = 250) {
    // A brief pause so the returned screenshot reflects the result of the interaction.
    await page.waitForTimeout(ms).catch(() => {});
  }

  /** Common return value after an interaction. The screenshot itself is fetched separately (GET /browser/screenshot). */
  async _result(page, extra = {}) {
    return { ok: true, url: sanitizeUrl(page.url()), viewport: this.viewport(page), recording: this.recorder?.isActive() ?? false, ...extra };
  }

  async screenshot({ format = 'jpeg', quality = 70 } = {}) {
    const fmt = format === 'png' ? 'png' : 'jpeg';
    // Not serialised with interactions: viewing must stay possible while a workflow runs.
    const page = await this.browser.getPage();
    try {
      const buffer = await page.screenshot({ type: fmt, quality: fmt === 'jpeg' ? quality : undefined, animations: 'disabled', caret: 'hide', timeout: 15000 });
      return { buffer, format: fmt, viewport: this.viewport(page), url: sanitizeUrl(page.url()), title: await page.title().catch(() => null) };
    } catch (e) {
      throw toAppError(e, 'screenshot');
    }
  }

  async click({ x, y, button = 'left', clickCount = 1 }) {
    if (!BUTTONS.has(button)) throw err.unprocessable('invalid_button', 'button must be left, right or middle.');
    if (![1, 2].includes(clickCount)) throw err.unprocessable('invalid_click_count', 'clickCount must be 1 or 2.');
    return this._run(async (page) => {
      const point = this._point(page, x, y);
      // While recording, a click selects the element instead of activating it.
      if (this.recorder?.isActive()) {
        const selection = await this.recorder.selectAt(page, point.x, point.y);
        return this._result(page, { recorded: true, selection });
      }
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y, { button, clickCount, delay: 30 });
      await this._settle(page);
      return this._result(page, { clicked: { x: point.x, y: point.y, button } });
    });
  }

  async hover({ x, y }) {
    return this._run(async (page) => {
      const point = this._point(page, x, y);
      await page.mouse.move(point.x, point.y, { steps: 2 });
      let hovered = null;
      if (this.recorder?.isActive()) hovered = await this.recorder.hoverAt(page, point.x, point.y);
      else await this._settle(page, 150);
      return this._result(page, { hovered: { x: point.x, y: point.y }, element: hovered });
    });
  }

  /** Type into whatever currently has focus. The text is intentionally never recorded or echoed back. */
  async type({ text, delay = 0, pressEnter = false }) {
    if (typeof text !== 'string' || text.length === 0) throw err.unprocessable('invalid_text', 'text must be a non-empty string.');
    if (text.length > MAX_TYPE_LENGTH) throw err.unprocessable('text_too_long', `text must be at most ${MAX_TYPE_LENGTH} characters.`);
    if (!Number.isInteger(delay) || delay < 0 || delay > 500) throw err.unprocessable('invalid_delay', 'delay must be an integer between 0 and 500 ms.');
    return this._run(async (page) => {
      await page.keyboard.type(text, { delay });
      if (pressEnter) await page.keyboard.press('Enter');
      await this._settle(page);
      return this._result(page, { typedCharacters: [...text].length, pressedEnter: Boolean(pressEnter) });
    });
  }

  async keypress({ key, times = 1 }) {
    parseKey(key);
    if (!Number.isInteger(times) || times < 1 || times > 20) throw err.unprocessable('invalid_times', 'times must be an integer between 1 and 20.');
    return this._run(async (page) => {
      for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
      await this._settle(page);
      return this._result(page, { pressed: key, times });
    });
  }

  async scroll({ deltaX = 0, deltaY = 0, x, y }) {
    for (const [name, v] of [['deltaX', deltaX], ['deltaY', deltaY]]) {
      if (!Number.isFinite(v) || Math.abs(v) > MAX_SCROLL) throw err.unprocessable('invalid_scroll', `${name} must be a number between -${MAX_SCROLL} and ${MAX_SCROLL}.`);
    }
    if (deltaX === 0 && deltaY === 0) throw err.unprocessable('invalid_scroll', 'Provide a non-zero deltaX or deltaY.');
    return this._run(async (page) => {
      const vp = this.viewport(page);
      const px = x === undefined ? vp.width / 2 : this._point(page, x, y ?? vp.height / 2).x;
      const py = y === undefined ? vp.height / 2 : this._point(page, x ?? vp.width / 2, y).y;
      await page.mouse.move(px, py);
      await page.mouse.wheel(deltaX, deltaY);
      await this._settle(page, 300);
      const position = await page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })).catch(() => null);
      return this._result(page, { scrolled: { deltaX, deltaY }, scrollPosition: position });
    });
  }

  async refresh() {
    return this._run(async (page) => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: this.settings.get().navigationTimeout });
      await this._settle(page, 300);
      return this._result(page, { reloaded: true });
    }, 'navigation');
  }

  /** Select the element at a point while recording (under the same lock as every other interaction). */
  async selectElement({ x, y, activate = false }) {
    if (!this.recorder?.isActive()) throw err.conflict('recorder_not_active', 'Start recording before selecting elements.');
    return this._run(async (page) => {
      const point = this._point(page, x, y);
      const selection = await this.recorder.selectAt(page, point.x, point.y, { activate });
      if (activate) await this._settle(page, 400);
      return selection;
    });
  }

  async openUrl(url) {
    return this._run(async () => {
      const result = await this.browser.navigate(url);
      return { ok: true, ...result, viewport: this.viewport(await this.browser.getPage()) };
    }, 'navigation');
  }

  /** Move the keyboard focus to the next/previous field, e.g. when using on-screen controls. */
  async focusNext(reverse = false) {
    return this.keypress({ key: reverse ? 'Shift+Tab' : 'Tab' });
  }
}

module.exports = { RemoteBrowserService, parseKey, KEY_NAMES };
