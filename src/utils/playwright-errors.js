'use strict';

const { AppError, err } = require('../errors');
const { AbortError } = require('./async-utils');

const CLOSED_RE =
  /target page, context or browser has been closed|target closed|browser has been closed|browser has disconnected|page has been closed|context has been closed|connection closed|page crashed|session closed/i;

/** First line of a Playwright error message, trimmed of the call-log noise. */
function firstLine(e) {
  const message = String(e?.message || e || '');
  return message.split('\n').find((l) => l.trim())?.trim().slice(0, 300) || 'Unknown error';
}

const isTimeout = (e) => e?.name === 'TimeoutError' || /timeout \d+ms exceeded/i.test(String(e?.message));
const isClosed = (e) => CLOSED_RE.test(String(e?.message || ''));

/**
 * Convert an arbitrary error thrown by Playwright (or our own code) into an AppError with a
 * stable code. `context` tunes the code for timeouts: 'navigation' | 'element' | 'screenshot' | 'action'.
 */
function toAppError(e, context = 'action') {
  if (e instanceof AppError) return e;
  if (e instanceof AbortError) return err.conflict('aborted', 'The operation was cancelled.');
  const message = String(e?.message || '');

  if (isClosed(e)) {
    return err.conflict('browser_session_lost', 'The browser session is no longer available.', {
      hint: 'Launch the browser again and log in again; the previous session was lost.',
    });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(message);
  if (net) {
    const code = net[1];
    const hints = {
      ERR_NAME_NOT_RESOLVED: 'The host name could not be resolved.',
      ERR_CONNECTION_REFUSED: 'The server refused the connection.',
      ERR_CONNECTION_TIMED_OUT: 'The connection timed out.',
      ERR_CERT_AUTHORITY_INVALID: 'The site presented an untrusted TLS certificate.',
      ERR_CERT_DATE_INVALID: 'The site presented an expired TLS certificate.',
      ERR_ABORTED: 'The navigation was aborted (for example by a redirect or a download).',
    };
    return err.badGateway('navigation_failed', `The page could not be loaded (${code}).`, {
      details: { networkError: code },
      hint: hints[code],
    });
  }
  if (/download is starting/i.test(message)) {
    return err.badRequest('navigation_failed', 'The URL starts a file download, which is disabled.');
  }
  if (isTimeout(e)) {
    const map = {
      navigation: ['navigation_timeout', 'Navigation timed out before the page finished loading.'],
      element: ['element_timeout', 'The element did not become available in time.'],
      screenshot: ['screenshot_timeout', 'Taking the screenshot timed out.'],
      action: ['action_timeout', 'The browser action timed out.'],
    };
    const [code, text] = map[context] || map.action;
    const details = { details: { reason: firstLine(e) } };
    // A missing/blocked element is a request the service cannot satisfy (422); only real waits on the
    // target website are reported as gateway timeouts.
    return context === 'element' ? err.unprocessable(code, text, details) : err.gatewayTimeout(code, text, details);
  }
  return err.internal('browser_error', 'The browser reported an error.', { details: { reason: firstLine(e) } });
}

module.exports = { toAppError, isTimeout, isClosed, firstLine };
