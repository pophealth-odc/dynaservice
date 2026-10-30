'use strict';

const { err } = require('../errors');
const { nowIso } = require('../utils/date-utils');
const { sanitizeUrl } = require('../utils/url-utils');

/**
 * Tracks the manual-login handshake.
 *
 *   idle -> waiting_for_login -> confirmed
 *                  \-> cancelled
 *   confirmed -> expired (authentication lapsed)  |  lost (browser session lost)
 *
 * "confirmed" is only the USER's statement that they finished logging in. The service cannot verify the
 * authentication, and it never sees, stores or logs credentials, MFA codes, tokens or cookies: the user
 * types them into the remote browser and the service only records the acknowledgement and a timestamp.
 */
class LoginService {
  constructor({ browser, events, settings }) {
    this.browser = browser;
    this.events = events;
    this.settings = settings;
    this.guard = null; // set by AutomationService: () => throws while a workflow step is running
    this.reset();
    browser.on('session-lost', ({ reason }) => this.onSessionLost(reason));
  }

  reset() {
    this.state = 'idle';
    this.loginUrl = null;
    this.openedAt = null;
    this.confirmedAt = null;
    this.confirmedUrl = null;
    this.confirmedSessionId = null;
    this.expiredReason = null;
    this.message = 'No login has been started.';
  }

  onSessionLost(reason) {
    if (this.state === 'idle') return;
    const wasConfirmed = this.state === 'confirmed';
    this.state = 'lost';
    this.expiredReason = reason === 'closed' ? 'browser_closed' : 'browser_lost';
    this.message = wasConfirmed
      ? 'The browser session was lost. Log in again before running automation.'
      : 'The browser session was lost while waiting for login. Open the login page again.';
    if (wasConfirmed) this.events.emitEvent('session.expired', 'The browser session was lost; log in again.', { data: { reason: this.expiredReason } });
  }

  /** Called by the automation engine when a step finds the session has expired (login page, 401, ...). */
  markExpired(reason = 'authentication_expired') {
    if (this.state !== 'confirmed') return false;
    this.state = 'expired';
    this.expiredReason = reason;
    this.message = 'Authentication appears to have expired. Complete login again in the remote browser, then confirm.';
    this.events.emitEvent('session.expired', 'Authentication appears to have expired; manual re-login is required.', { data: { reason } });
    return true;
  }

  async open({ url } = {}) {
    if (this.guard) this.guard();
    const target = url || this.settings.get().defaultLoginUrl;
    await this.browser.launch();
    const checked = this.browser.checkUrl(target);
    await this.browser.navigate(checked, { waitUntil: 'domcontentloaded' });
    this.state = 'waiting_for_login';
    this.loginUrl = sanitizeUrl(checked);
    this.openedAt = nowIso();
    this.confirmedAt = null;
    this.confirmedUrl = null;
    this.confirmedSessionId = null;
    this.expiredReason = null;
    this.message = 'Waiting for you to log in (and complete MFA) in the remote browser, then confirm.';
    this.events.emitEvent('login.page_opened', 'Login page opened.', { data: { url: this.loginUrl } });
    this.events.emitEvent('login.waiting', 'Waiting for login. Sign in and complete MFA in the remote browser, then confirm.');
    return this.status();
  }

  /** Record the user's acknowledgement. Requires a live browser session that was opened for login. */
  async confirm() {
    if (this.state === 'idle') {
      throw err.conflict('login_not_started', 'Open the login page before confirming login.');
    }
    if (this.state === 'cancelled') {
      throw err.conflict('login_cancelled', 'Login was cancelled. Open the login page again.');
    }
    if (!this.browser.isReady) {
      this.onSessionLost('closed');
      throw err.conflict('browser_not_running', 'The browser session is gone (the service may have restarted). Open the login page and log in again.');
    }
    if (this.state === 'lost') {
      throw err.conflict('session_lost', 'The browser session was lost. Open the login page again.');
    }
    this.state = 'confirmed';
    this.confirmedAt = nowIso();
    this.confirmedUrl = this.browser.currentUrl();
    this.confirmedSessionId = this.browser.sessionId;
    this.expiredReason = null;
    this.message = 'You confirmed that you are logged in. This is your acknowledgement; it is not verified by the service.';
    this.events.emitEvent('login.confirmed', 'Login confirmed by the user. Automation is eligible to start.', { data: { url: this.confirmedUrl } });
    return this.status();
  }

  cancel() {
    if (this.state === 'idle') return this.status();
    this.state = 'cancelled';
    this.message = 'Login was cancelled.';
    this.events.emitEvent('login.cancelled', 'Login was cancelled.');
    return this.status();
  }

  /** True when automation may run: confirmed AND still the same live browser session. */
  get isConfirmed() {
    return this.state === 'confirmed' && this.browser.isReady && this.browser.sessionId === this.confirmedSessionId;
  }

  /** Throws a descriptive error when automation is not eligible to start. */
  assertEligible() {
    if (!this.browser.isReady) {
      throw err.conflict('browser_not_running', 'The browser is not running. Open the login page, log in, then confirm.');
    }
    switch (this.state) {
      case 'confirmed':
        if (this.browser.sessionId !== this.confirmedSessionId) {
          throw err.conflict('login_required', 'The browser was restarted since you confirmed login. Log in again and confirm.');
        }
        return;
      case 'expired':
        throw err.conflict('session_expired', 'Authentication expired. Complete login again in the remote browser and confirm.');
      case 'lost':
        throw err.conflict('session_lost', 'The browser session was lost. Open the login page and log in again.');
      case 'waiting_for_login':
        throw err.conflict('login_not_confirmed', 'Login has not been confirmed. Log in in the remote browser, then use "I\'m Logged In — Continue Automation".');
      default:
        throw err.conflict('login_required', 'Login has not been performed. Open the login page, log in, then confirm.');
    }
  }

  status() {
    return {
      state: this.state,
      confirmed: this.isConfirmed,
      eligibleForAutomation: this.isConfirmed,
      loginUrl: this.loginUrl,
      openedAt: this.openedAt,
      confirmedAt: this.confirmedAt,
      confirmedUrl: this.confirmedUrl,
      expiredReason: this.expiredReason,
      message: this.message,
      note: 'Confirmation is a user acknowledgement, not an independent verification of authentication. Credentials, MFA codes and cookies are never collected, stored or logged.',
    };
  }
}

module.exports = { LoginService };
