'use strict';

const crypto = require('node:crypto');
const { err } = require('../errors');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/date-utils');
const { sanitizeUrl } = require('../utils/url-utils');
const { withTimeout } = require('../utils/async-utils');
const { toAppError, isClosed } = require('../utils/playwright-errors');
const { pickerBootstrap } = require('../automation/element-picker');
const { buildCandidates, pickBest, toStoredSpec, resolveLocator, validateLocatorSpec } = require('../automation/locator-builder');
const { assessElement, describeReason } = require('../automation/safety');

const MAX_FRAME_DEPTH = 5;
const HIGHLIGHT_TIMEOUT = 1500;

const LIMITATIONS = Object.freeze([
  'Elements inside closed shadow roots cannot be inspected; the host element is selected instead.',
  'Content rendered by the browser itself (PDF viewer, chrome:// pages, native <select> popups, file dialogs) cannot be selected.',
  'Elements drawn inside <canvas> or plugins are not DOM elements and cannot be selected.',
  'Clicks and hovers are replayed from a screenshot, so the selected element is the one visible at that point on the page.',
]);

/**
 * Visual element recorder.
 *
 * While recording is active the in-page picker swallows site click handlers, so selecting an element never
 * triggers the site's own action. Hover draws a border and tooltip into the page (visible in the remote
 * screenshot); a click selects the element and returns its metadata plus validated locators.
 */
class RecorderService {
  constructor({ browser, events }) {
    this.browser = browser;
    this.events = events;
    this.active = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.selection = null;
    this.hoverInfo = null;
    this.highlightFrame = null;
    this.selectionCount = 0;
    this._frameListener = null;
    this._pageWithListener = null;
    this.guard = null; // set by AutomationService: () => throws while a workflow is running
    browser.on('session-lost', () => this._reset('session_lost'));
  }

  isActive() {
    return this.active;
  }

  _reset(reason) {
    const was = this.active;
    this.active = false;
    this.selection = null;
    this.hoverInfo = null;
    this.highlightFrame = null;
    this._detachListeners();
    if (was) this.stoppedAt = nowIso();
    logger.debug('Recorder reset', { reason });
  }

  status() {
    return {
      active: this.active,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      hasSelection: Boolean(this.selection),
      selectionCount: this.selectionCount,
      hovering: this.hoverInfo,
      limitations: LIMITATIONS,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------------------------

  async _enableInFrame(frame) {
    try {
      await withTimeout(frame.evaluate(pickerBootstrap), 2000);
      await withTimeout(frame.evaluate(() => window.__ssPicker.enable()), 2000);
    } catch (e) {
      if (isClosed(e)) throw e;
      // Detached or restricted frames are skipped; they are reported through `limitations`.
    }
  }

  _detachListeners() {
    if (this._pageWithListener && this._frameListener) {
      try {
        this._pageWithListener.off('framenavigated', this._frameListener);
      } catch {
        /* page already gone */
      }
    }
    this._pageWithListener = null;
    this._frameListener = null;
  }

  async start() {
    if (this.guard) this.guard();
    const page = await this.browser.getPage();
    if (this.active) return this.status();
    try {
      for (const frame of page.frames()) await this._enableInFrame(frame);
    } catch (e) {
      throw toAppError(e);
    }
    // Pages and frames that navigate while recording must be re-armed, or their handlers would fire.
    this._frameListener = (frame) => {
      if (this.active) this._enableInFrame(frame).catch(() => {});
    };
    this._pageWithListener = page;
    page.on('framenavigated', this._frameListener);
    this.active = true;
    this.startedAt = nowIso();
    this.stoppedAt = null;
    this.hoverInfo = null;
    this.events.emitEvent('recording.started', 'Recording started. Hover to highlight an element and click to select it; page actions are blocked.');
    return this.status();
  }

  async stop() {
    const wasActive = this.active;
    this.active = false;
    this.stoppedAt = nowIso();
    this.hoverInfo = null;
    this._detachListeners();
    if (this.browser.isReady && this.browser.page && !this.browser.page.isClosed()) {
      for (const frame of this.browser.page.frames()) {
        await withTimeout(frame.evaluate(() => window.__ssPicker?.disable()).catch(() => {}), 1500);
      }
    }
    this.highlightFrame = null;
    if (wasActive) this.events.emitEvent('recording.stopped', 'Recording stopped. Normal page interaction restored.');
    return this.status();
  }

  // ---------------------------------------------------------------------------------------------
  // Hit-testing
  // ---------------------------------------------------------------------------------------------

  /** Find the deepest element at viewport point (x, y), descending into iframes. */
  async _hitTest(page, x, y) {
    let frame = page.mainFrame();
    let px = x;
    let py = y;
    const frameSelectors = [];
    const frameChain = [];

    for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth += 1) {
      await withTimeout(frame.evaluate(pickerBootstrap), 2000);
      const handle = (await frame.evaluateHandle(({ ex, ey }) => window.__ssPicker.deepElementFromPoint(ex, ey), { ex: px, ey: py })).asElement();
      if (!handle) return null;

      const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
      if ((tag === 'iframe' || tag === 'frame') && depth < MAX_FRAME_DEPTH) {
        const child = await handle.contentFrame();
        if (child) {
          const geometry = await handle.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left + el.clientLeft, top: r.top + el.clientTop };
          });
          const selector = await this._frameSelector(frame, handle);
          if (selector) {
            frameSelectors.push(selector);
            frameChain.push({ url: sanitizeUrl(child.url()), name: child.name() || null });
            px -= geometry.left;
            py -= geometry.top;
            frame = child;
            continue;
          }
        }
      }
      return { frame, handle, x: px, y: py, frameSelectors, frameChain };
    }
    return null;
  }

  /** A CSS selector that uniquely identifies an <iframe> element inside its parent frame. */
  async _frameSelector(parentFrame, handle) {
    const [info, ancestry] = await Promise.all([
      handle.evaluate((el) => window.__ssPicker.describe(el)),
      handle.evaluate((el) => window.__ssPicker.ancestry(el)),
    ]);
    for (const candidate of buildCandidates(info, ancestry)) {
      if (!['id', 'data', 'css'].includes(candidate.strategy)) continue;
      try {
        if ((await parentFrame.locator(`css=${candidate.selector}`).count()) === 1) return candidate.selector;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  async _draw(hit, mode) {
    const previous = this.highlightFrame;
    if (previous && previous !== hit.frame && !previous.isDetached()) {
      await withTimeout(previous.evaluate(() => window.__ssPicker?.clearHighlight()).catch(() => {}), HIGHLIGHT_TIMEOUT);
    }
    await withTimeout(hit.handle.evaluate((el, m) => window.__ssPicker.highlightElement(el, m), mode).catch(() => {}), HIGHLIGHT_TIMEOUT);
    this.highlightFrame = hit.frame;
  }

  // ---------------------------------------------------------------------------------------------
  // Hover / select
  // ---------------------------------------------------------------------------------------------

  /** Hover at a viewport point: draw the highlight and return a short description. */
  async hoverAt(page, x, y) {
    const hit = await this._hitTest(page, x, y);
    if (!hit) {
      this.hoverInfo = null;
      return null;
    }
    const info = await hit.handle.evaluate((el) => window.__ssPicker.describe(el));
    if (!this.selection) await this._draw(hit, 'hover');
    this.hoverInfo = { tag: info.tag, id: info.id, classes: info.classes.slice(0, 4), role: info.role, name: info.name, text: info.text };
    return this.hoverInfo;
  }

  /**
   * Select the element at a viewport point and build its metadata and validated locators.
   * @returns the selection object (also kept as the current selection)
   */
  async selectAt(page, x, y, { activate = false } = {}) {
    if (!this.active) throw err.conflict('recorder_not_active', 'Start recording before selecting elements.');
    const hit = await this._hitTest(page, x, y);
    if (!hit) {
      throw err.notFound('no_element_at_point', 'No selectable element was found at that point.', {
        hint: 'The point may be over restricted browser content, a canvas, or a closed shadow root.',
      });
    }
    const { frame, handle, frameSelectors, frameChain } = hit;
    const [info, ancestry] = await Promise.all([
      handle.evaluate((el) => window.__ssPicker.describe(el)),
      handle.evaluate((el) => window.__ssPicker.ancestry(el)),
    ]);

    const candidates = buildCandidates(info, ancestry, { frames: frameSelectors });
    const evaluated = [];
    for (const candidate of candidates) {
      const spec = toStoredSpec(candidate);
      const locator = resolveLocator(page, spec);
      let matches = -1;
      let relation = null;
      try {
        matches = await locator.count();
        if (matches === 1) {
          const matchHandle = await locator.elementHandle({ timeout: 1000 });
          if (matchHandle) {
            relation = await handle.evaluate((picked, match) => {
              if (picked === match) return 'same';
              if (picked.contains(match)) return 'descendant';
              if (match.contains(picked)) return 'ancestor';
              return 'other';
            }, matchHandle);
            await matchHandle.dispose();
          }
        }
      } catch (e) {
        if (isClosed(e)) throw toAppError(e);
        matches = -1;
      }
      evaluated.push({ ...candidate, matches, relation, unique: matches === 1 && relation !== 'other' });
    }

    const best = pickBest(evaluated, { description: describeForUser(info) });
    const safety = assessElement(info);
    const pageTitle = await withTimeout(page.title().catch(() => null), 1500);
    const cssCandidate = evaluated.find((c) => ['id', 'data', 'css'].includes(c.strategy) && c.unique);
    const xpathCandidate = evaluated.find((c) => c.strategy === 'xpath');

    const warnings = [...(best.warnings || [])];
    if (info.possibleClosedShadowRoot) warnings.push('This custom element may contain a closed shadow root whose contents cannot be inspected.');
    if (info.sensitive) warnings.push('This looks like a sensitive field (password / one-time code). Its name and value are not recorded, and the automation never types into fields.');
    if (safety.destructive) warnings.push(`This element ${describeReason(safety.reason)}. Clicking it requires allowDestructive on the step and confirmDestructive when starting the run.`);
    if (!info.visible) warnings.push('The element is currently not visible.');

    const selection = {
      id: crypto.randomUUID(),
      selectedAt: nowIso(),
      element: {
        tag: info.tag,
        id: info.id,
        classes: info.classes,
        text: info.text,
        role: info.role,
        accessibleName: info.name,
        attributes: info.attributes,
        dataAttributes: info.dataAttributes,
        boundingBox: info.rect,
        visible: info.visible,
        disabled: info.disabled,
        sensitive: info.sensitive,
        inShadowDom: info.shadow.inShadow,
        shadowHosts: info.shadow.hostChain,
      },
      cssSelector: cssCandidate?.selector ?? null,
      xpath: xpathCandidate?.selector ?? null,
      page: { url: sanitizeUrl(page.url()), title: pageTitle },
      frame: {
        isTopFrame: frameSelectors.length === 0,
        url: sanitizeUrl(frame.url()),
        name: frame.name() || null,
        path: frameSelectors,
        chain: frameChain,
      },
      locators: {
        unique: best.unique,
        ambiguous: best.ambiguous,
        primary: best.primary,
        fallbacks: best.fallbacks,
        candidates: evaluated.map((c) => ({
          strategy: c.strategy,
          label: c.label,
          priority: c.priority,
          stability: c.stability,
          matches: c.matches,
          relation: c.relation,
          unique: c.unique,
        })),
        message: best.message ?? null,
      },
      safety: { destructive: safety.destructive, reason: safety.reason, matched: safety.matched },
      warnings,
      limitations: LIMITATIONS,
      activated: false,
    };
    selection.suggestedStep = best.primary
      ? {
          name: suggestStepName(info),
          action: 'click',
          target: best.primary,
          wait: { condition: 'page_ready' },
          screenshot: true,
          allowDestructive: false,
        }
      : null;

    this.selection = selection;
    this.selectionCount += 1;
    this.hoverInfo = null;
    await this._draw(hit, 'selected');
    this.events.emitEvent('element.selected', `Selected <${info.tag}>${info.id ? `#${info.id}` : ''}${best.unique ? '' : ' (locator not unique)'}.`, {
      data: { selectionId: selection.id, tag: info.tag, unique: best.unique, strategy: best.primary?.strategy ?? null },
    });

    if (activate) await this._activate(page, hit, selection, safety);
    return selection;
  }

  /**
   * "Select and continue": perform the real click on the just-selected element so the user can reach the next
   * page and record the next step. Refused for destructive-looking and sensitive elements.
   */
  async _activate(page, hit, selection, safety) {
    if (safety.destructive) {
      selection.activation = { performed: false, reason: `Not clicked: the element ${describeReason(safety.reason)}.` };
      return;
    }
    if (selection.element.sensitive || selection.element.disabled) {
      selection.activation = { performed: false, reason: 'Not clicked: the element is a sensitive or disabled field.' };
      return;
    }
    await withTimeout(page.evaluate(() => window.__ssPicker?.pause()).catch(() => {}), 1000);
    for (const f of page.frames()) await withTimeout(f.evaluate(() => window.__ssPicker?.pause()).catch(() => {}), 800);
    try {
      await hit.handle.click({ timeout: 5000 });
      selection.activation = { performed: true, reason: null };
      selection.activated = true;
    } catch (e) {
      selection.activation = { performed: false, reason: `Click failed: ${String(e.message).split('\n')[0].slice(0, 160)}` };
    } finally {
      for (const f of page.frames()) await withTimeout(f.evaluate(() => window.__ssPicker?.resume()).catch(() => {}), 800);
    }
    this.selection = selection;
  }

  // ---------------------------------------------------------------------------------------------
  // Selection access
  // ---------------------------------------------------------------------------------------------

  getSelection() {
    return this.selection;
  }

  requireSelection() {
    if (!this.selection) throw err.notFound('no_selection', 'No element is selected. Start recording and click an element first.');
    return this.selection;
  }

  async clearSelection() {
    const had = Boolean(this.selection);
    this.selection = null;
    this.hoverInfo = null;
    if (this.browser.isReady && this.browser.page && !this.browser.page.isClosed()) {
      for (const frame of this.browser.page.frames()) {
        await withTimeout(frame.evaluate(() => window.__ssPicker?.clearHighlight()).catch(() => {}), 1000);
      }
    }
    this.highlightFrame = null;
    return { cleared: had };
  }

  /** Validate a locator against the live page: how many elements match, and which one. */
  async checkLocator(spec) {
    const problems = validateLocatorSpec(spec);
    if (problems.length) throw err.unprocessable('invalid_locator', 'The locator is not valid.', { details: { problems } });
    const page = await this.browser.getPage();
    const locator = resolveLocator(page, spec);
    try {
      const count = await locator.count();
      return { matches: count, unique: count === 1, ambiguous: count > 1 };
    } catch (e) {
      throw toAppError(e);
    }
  }
}

function describeForUser(info) {
  const label = info.name || info.text || info.id || '';
  return `${info.tag}${label ? ` "${String(label).slice(0, 60)}"` : ''}`;
}

function suggestStepName(info) {
  const label = (info.name || info.text || '').trim();
  if (label && !info.sensitive) return `Click ${label.slice(0, 60)}`;
  return `Click ${info.id || info.tag}`;
}

module.exports = { RecorderService, LIMITATIONS };
