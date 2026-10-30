'use strict';

const { err } = require('../errors');
const { sleep, raceAbort, AbortError } = require('../utils/async-utils');
const { sanitizeUrl } = require('../utils/url-utils');
const { toAppError, isClosed, firstLine } = require('../utils/playwright-errors');
const { pickerBootstrap } = require('./element-picker');
const { describeSpec } = require('./locator-builder');
const { assessElement, describeReason } = require('./safety');
const wait = require('./wait-manager');

/** Heuristic: the page in front of us looks like a login form again, i.e. authentication expired. */
async function detectLoginPage(page) {
  try {
    return await page.evaluate(() => {
      const pw = document.querySelector('input[type="password"]');
      if (!pw) return false;
      const rect = pw.getBoundingClientRect();
      const style = getComputedStyle(pw);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  } catch {
    return false;
  }
}

async function describeResolved(locator) {
  try {
    await locator.evaluate(pickerBootstrap);
    return await locator.evaluate((el) => window.__ssPicker.describe(el));
  } catch {
    return null;
  }
}

/**
 * Executes individual workflow steps against the live page.
 *
 * It performs only the configured action. It never types, submits forms, logs out or deletes: clicks that look
 * destructive are refused unless the step and the run both explicitly allow them.
 */
class NavigationRunner {
  constructor({ browser, screenshots, settings, events, loginService }) {
    this.browser = browser;
    this.screenshots = screenshots;
    this.settings = settings;
    this.events = events;
    this.login = loginService;
  }

  stepTimeout(step) {
    return step.timeout ?? this.settings.get().elementTimeout;
  }

  stepDelay(step) {
    return step.delay ?? this.settings.get().additionalPageDelay;
  }

  /**
   * Run one step. `ctx` = { signal, run: {id, workflowId, workflowName, confirmDestructive, ...},
   *                         total, onPhase(label), isCancelled() }
   * Returns { status: 'completed', url, screenshot?, usedFallback?, durationMs }.
   */
  async runStep(step, ctx) {
    const started = Date.now();
    const { signal } = ctx;
    const page = await this.browser.getPage();
    const timeout = this.stepTimeout(step);
    const result = { status: 'completed', action: step.action };

    try {
      const urlBefore = page.url();
      switch (step.action) {
        case 'click':
          await this._click(page, step, ctx, timeout, result);
          break;
        case 'wait_for_element':
          await this._waitForElement(page, step, ctx, timeout, result);
          break;
        case 'wait_for_navigation':
          await this._waitForNavigation(page, step, ctx, timeout, urlBefore, result);
          break;
        case 'capture_screenshot':
          break;
        default:
          throw err.unprocessable('unsupported_action', `Unsupported action "${step.action}".`);
      }

      if (step.action !== 'capture_screenshot' || step.wait?.condition !== 'none') {
        await this._afterWait(page, step, ctx, timeout, urlBefore, result);
      }
      await this._expectedUrl(page, step, timeout, signal);

      const delay = this.stepDelay(step);
      if (delay > 0) {
        ctx.onPhase?.(`Waiting ${delay} ms before continuing`);
        await sleep(delay, signal);
      }

      if (await detectLoginPage(page)) {
        const expired = this.login.markExpired('login_page_detected');
        if (expired) throw err.conflict('session_expired', 'The page now shows a login form; authentication appears to have expired.', { hint: 'Log in again in the remote browser, confirm, then resume.' });
      }

      if (step.screenshot || step.action === 'capture_screenshot') {
        ctx.onPhase?.('Capturing screenshot');
        const existing = this.screenshots.findByRunStep(ctx.run.id, step.id);
        // A resumed or retried step must not produce a duplicate image.
        result.screenshot = existing
          ? this.screenshots.publicMeta(existing)
          : await this.screenshots.capture({
              workflowId: ctx.run.workflowId,
              workflowName: ctx.run.workflowName,
              runId: ctx.run.id,
              stepId: step.id,
              stepNumber: step.number,
              stepName: step.name,
              fullPage: step.screenshotFullPage ? true : undefined,
            });
        result.screenshotReused = Boolean(existing);
      }
    } catch (e) {
      if (e instanceof AbortError) throw e;
      throw this._classify(e, step);
    }
    result.url = sanitizeUrl(page.url());
    result.durationMs = Date.now() - started;
    return result;
  }

  _classify(e, step) {
    if (e?.name === 'AppError') return e;
    if (isClosed(e)) return toAppError(e);
    return toAppError(e, step.action === 'wait_for_navigation' ? 'navigation' : 'element');
  }

  // -- actions ----------------------------------------------------------------------------------

  async _click(page, step, ctx, timeout, result) {
    ctx.onPhase?.('Waiting for element');
    this.events.emitEvent('step.waiting_for_element', `Waiting for "${step.name}" target.`, { stepName: step.name });
    const resolved = await wait.resolveTarget(page, step.target, { state: 'visible', timeout, signal: ctx.signal });
    result.usedFallback = resolved.usedFallback;
    result.locator = describeSpec(resolved.spec);

    // Safety: never click something that looks destructive unless explicitly permitted twice.
    const info = await describeResolved(resolved.locator);
    const assessment = assessElement(info);
    result.safety = assessment;
    if (assessment.destructive && !(step.allowDestructive && ctx.run.confirmDestructive)) {
      throw err.forbidden('destructive_action_blocked', `Step "${step.name}" targets an element that ${describeReason(assessment.reason)}; it was not clicked.`, {
        details: { reason: assessment.reason, matched: assessment.matched },
        hint: 'If this is intended, set allowDestructive on the step and start the run with confirmDestructive=true.',
      });
    }
    if (info?.disabled) {
      throw err.unprocessable('element_not_interactable', `The element for "${step.name}" is disabled.`);
    }

    ctx.onPhase?.('Clicking element');
    try {
      await raceAbort(resolved.locator.click({ timeout: Math.min(timeout, 15000) }), ctx.signal);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      if (wait.isNotInteractable(e)) {
        throw err.unprocessable('element_not_interactable', `The element for "${step.name}" could not be clicked: ${firstLine(e)}`, {
          hint: 'Another element may be covering it (a dialog or overlay), or the page is still animating.',
        });
      }
      throw e;
    }
  }

  async _waitForElement(page, step, ctx, timeout, result) {
    ctx.onPhase?.('Waiting for element');
    this.events.emitEvent('step.waiting_for_element', `Waiting for "${step.name}" target.`, { stepName: step.name });
    const resolved = await wait.resolveTarget(page, step.target, { state: 'visible', timeout, signal: ctx.signal });
    result.usedFallback = resolved.usedFallback;
    result.locator = describeSpec(resolved.spec);
  }

  async _waitForNavigation(page, step, ctx, timeout, urlBefore, result) {
    ctx.onPhase?.('Waiting for navigation');
    this.events.emitEvent('step.waiting_for_navigation', `Waiting for navigation after "${step.name}".`, { stepName: step.name });
    const pattern = step.wait?.urlPattern || step.expectedUrl;
    if (pattern) await wait.waitForUrl(page, pattern, { timeout, signal: ctx.signal });
    else await wait.waitForUrlChange(page, urlBefore, { timeout, signal: ctx.signal });
    result.navigated = true;
  }

  async _afterWait(page, step, ctx, timeout, urlBefore, result) {
    const w = step.wait || { condition: 'page_ready' };
    const target = w.target || step.target;
    switch (w.condition) {
      case 'none':
        return;
      case 'element_visible':
        ctx.onPhase?.('Waiting for element to appear');
        this.events.emitEvent('step.waiting_for_element', `Waiting for an element after "${step.name}".`, { stepName: step.name });
        await wait.resolveTarget(page, target, { state: 'visible', timeout, signal: ctx.signal });
        return;
      case 'element_hidden':
        ctx.onPhase?.('Waiting for element to disappear');
        await wait.resolveTarget(page, target, { state: 'hidden', timeout, signal: ctx.signal });
        return;
      case 'url_matches':
        ctx.onPhase?.('Waiting for URL');
        this.events.emitEvent('step.waiting_for_navigation', `Waiting for URL after "${step.name}".`, { stepName: step.name });
        await wait.waitForUrl(page, w.urlPattern || step.expectedUrl, { timeout, signal: ctx.signal });
        return;
      case 'url_change':
        if (step.action === 'wait_for_navigation') return; // already handled
        ctx.onPhase?.('Waiting for navigation');
        this.events.emitEvent('step.waiting_for_navigation', `Waiting for navigation after "${step.name}".`, { stepName: step.name });
        await wait.waitForUrlChange(page, urlBefore, { timeout, signal: ctx.signal });
        return;
      case 'page_ready':
      default:
        ctx.onPhase?.('Waiting for page to settle');
        result.pageSettled = (await wait.waitForPageReady(page, { timeout: Math.min(timeout, 20000), signal: ctx.signal })).settled;
    }
  }

  async _expectedUrl(page, step, timeout, signal) {
    if (!step.expectedUrl || step.wait?.condition === 'url_matches' || step.action === 'wait_for_navigation') return;
    await wait.waitForUrl(page, step.expectedUrl, { timeout: Math.min(timeout, 10000), signal });
  }
}

module.exports = { NavigationRunner, detectLoginPage };
