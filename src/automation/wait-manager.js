'use strict';

const { err } = require('../errors');
const { sleep, raceAbort, AbortError } = require('../utils/async-utils');
const { isClosed, firstLine } = require('../utils/playwright-errors');
const { matchUrlPattern, sanitizeUrl } = require('../utils/url-utils');
const { resolveLocator, specChain, describeSpec } = require('./locator-builder');

const POLL_MS = 120;

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new AbortError(typeof signal.reason === 'string' ? signal.reason : signal.reason?.reason || 'aborted');
};

/** Page-closed errors must surface as a lost session; everything else inside a poll is transient. */
function rethrowIfClosed(e) {
  if (isClosed(e)) throw e;
}

/**
 * Wait until the page has settled: document parsed, load event seen (best effort) and the DOM has stopped
 * changing for `quietMs`. This covers full page loads and single-page-app route changes alike, which
 * `load` events alone cannot.
 */
async function waitForPageReady(page, { timeout = 15000, quietMs = 500, signal } = {}) {
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(0, deadline - Date.now());
  throwIfAborted(signal);
  // Give a navigation triggered by the previous action a moment to begin before judging the state.
  await sleep(Math.min(150, remaining()), signal);
  try {
    await raceAbort(page.waitForLoadState('domcontentloaded', { timeout: remaining() }), signal);
    await raceAbort(page.waitForLoadState('load', { timeout: Math.min(remaining(), 10000) }).catch(() => {}), signal);
  } catch (e) {
    if (e instanceof AbortError) throw e;
    if (e?.name === 'TimeoutError') throw err.gatewayTimeout('navigation_timeout', 'The page did not finish loading in time.');
    rethrowIfClosed(e);
  }
  // DOM quiet period (re-armed if a navigation destroys the evaluation context).
  while (remaining() > 0) {
    throwIfAborted(signal);
    try {
      const settled = await raceAbort(
        page.evaluate(
          ({ quiet, max }) =>
            new Promise((resolve) => {
              let timer;
              const finish = (value) => {
                observer.disconnect();
                clearTimeout(timer);
                clearTimeout(cap);
                resolve(value);
              };
              const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => finish(true), quiet);
              });
              observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
              timer = setTimeout(() => finish(true), quiet);
              const cap = setTimeout(() => finish(false), max);
            }),
          { quiet: quietMs, max: Math.min(remaining(), 8000) },
        ),
        signal,
      );
      if (settled) return { settled: true };
      return { settled: false }; // busy page (animations, live data): proceed rather than fail
    } catch (e) {
      if (e instanceof AbortError) throw e;
      rethrowIfClosed(e);
      await sleep(Math.min(150, remaining()), signal);
    }
  }
  return { settled: false };
}

/** Poll until the page URL matches `pattern` (works for pushState navigations that fire no load event). */
async function waitForUrl(page, pattern, { timeout = 15000, signal } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    throwIfAborted(signal);
    const url = page.url();
    if (matchUrlPattern(pattern, url)) return url;
    if (Date.now() >= deadline) {
      throw err.unprocessable('url_mismatch', `The page URL did not match "${pattern}" in time.`, {
        details: { expected: pattern, actual: sanitizeUrl(url) },
      });
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }
}

/** Wait until the URL differs from `fromUrl` (full navigation, redirect or history change). */
async function waitForUrlChange(page, fromUrl, { timeout = 15000, signal } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    throwIfAborted(signal);
    const url = page.url();
    if (url !== fromUrl) return url;
    if (Date.now() >= deadline) {
      throw err.gatewayTimeout('navigation_timeout', 'No page navigation happened in time.', { details: { url: sanitizeUrl(fromUrl) } });
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }
}

const NOT_INTERACTABLE_RE = /intercepts pointer events|not enabled|not visible|not stable|element is outside of the viewport|detached from the dom/i;
const isNotInteractable = (e) => NOT_INTERACTABLE_RE.test(String(e?.message || ''));

/**
 * Resolve a stored locator (primary + fallbacks) to exactly one element, polling because dynamic pages
 * render late. States: 'visible' | 'attached' | 'hidden'.
 * Failure codes: element_not_found, element_ambiguous, element_not_visible.
 */
async function resolveTarget(page, spec, { state = 'visible', timeout = 15000, signal } = {}) {
  const chain = specChain(spec);
  if (!chain.length) throw err.badRequest('missing_target', 'This step needs a target element.');
  const deadline = Date.now() + timeout;
  let sawAmbiguous = null;
  let sawHidden = false;

  for (;;) {
    throwIfAborted(signal);
    let visibleCount = 0;
    for (let i = 0; i < chain.length; i += 1) {
      const candidate = chain[i];
      const locator = resolveLocator(page, candidate);
      let count = 0;
      try {
        count = await raceAbort(locator.count(), signal);
      } catch (e) {
        if (e instanceof AbortError) throw e;
        rethrowIfClosed(e);
        count = 0;
      }
      if (count === 0) {
        if (state === 'hidden') visibleCount += 0;
        continue;
      }
      if (count > 1) {
        sawAmbiguous = { spec: describeSpec(candidate), count };
        continue;
      }
      // exactly one element
      if (state === 'attached') return { locator, spec: candidate, usedFallback: i > 0, count: 1 };
      let visible = false;
      try {
        visible = await raceAbort(locator.isVisible(), signal);
      } catch (e) {
        if (e instanceof AbortError) throw e;
        rethrowIfClosed(e);
      }
      if (state === 'visible') {
        if (visible) return { locator, spec: candidate, usedFallback: i > 0, count: 1 };
        sawHidden = true;
      } else if (state === 'hidden') {
        if (!visible) return { locator, spec: candidate, usedFallback: i > 0, count: 1 };
        visibleCount += 1;
      }
    }
    if (state === 'hidden' && visibleCount === 0) {
      // nothing matches at all: the element is gone, which satisfies "hidden"
      return { locator: null, spec: null, usedFallback: false, count: 0 };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }

  const described = describeSpec(chain[0]);
  if (state === 'hidden') {
    throw err.unprocessable('element_still_visible', `The element (${described}) is still visible.`);
  }
  if (sawAmbiguous) {
    throw err.unprocessable('element_ambiguous', `The locator matches ${sawAmbiguous.count} elements (${sawAmbiguous.spec}); it must match exactly one.`, {
      details: sawAmbiguous,
      hint: 'Re-record the element or add a more specific locator (a data-testid, a parent in the CSS selector, or "index").',
    });
  }
  if (sawHidden) {
    throw err.unprocessable('element_not_visible', `The element exists but is not visible (${described}).`);
  }
  throw err.notFound('element_not_found', `The element was not found in time (${described}).`, {
    hint: 'The page may have changed, the session may have expired, or the element may be inside an inaccessible frame.',
  });
}

/** Evaluate every candidate against the page without waiting; used to validate locators when recording. */
async function countMatches(page, spec) {
  const locator = resolveLocator(page, spec);
  try {
    return { count: await locator.count(), locator };
  } catch (e) {
    rethrowIfClosed(e);
    return { count: -1, locator, error: firstLine(e) };
  }
}

module.exports = {
  waitForPageReady,
  waitForUrl,
  waitForUrlChange,
  resolveTarget,
  countMatches,
  isNotInteractable,
  throwIfAborted,
  POLL_MS,
};
