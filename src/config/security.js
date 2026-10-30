'use strict';

const crypto = require('node:crypto');
const { normalizeOrigin } = require('../utils/url-utils');

/**
 * Authentication and origin policy, built once from the validated environment.
 * The token is only ever held as a SHA-256 digest after construction, and compared in constant time.
 */
function createSecurity(env) {
  const expectedDigest = crypto.createHash('sha256').update(env.apiToken).digest();
  const allowedOrigins = new Set(env.dashboardOrigins);

  /** Extract the token from an `Authorization: Bearer <token>` header value. */
  function parseBearer(header) {
    if (typeof header !== 'string') return null;
    const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
  }

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) return false;
    const digest = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(digest, expectedDigest);
  }

  /**
   * Same-origin check by host (and port). The scheme is deliberately not compared: behind Render's
   * TLS-terminating proxy the scheme Express sees can differ from the one the browser used, which
   * would wrongly reject the built-in test page and Swagger UI.
   */
  function isSelfOrigin(req, origin) {
    const host = req.get('host');
    if (!host) return false;
    try {
      return new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * An Origin header is acceptable when it is the configured dashboard or the service itself
   * (the built-in test page and Swagger UI call the API from the same origin).
   * Requests without an Origin header (curl, server-to-server) are not browser cross-origin requests.
   */
  function classifyOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return { present: false, allowed: true, crossOrigin: false, origin: null };
    const normalized = normalizeOrigin(origin);
    if (!normalized) return { present: true, allowed: false, crossOrigin: true, origin };
    if (isSelfOrigin(req, normalized)) return { present: true, allowed: true, crossOrigin: false, origin: normalized };
    return { present: true, allowed: allowedOrigins.has(normalized), crossOrigin: true, origin: normalized };
  }

  return { parseBearer, tokenMatches, classifyOrigin, allowedOrigins: [...allowedOrigins] };
}

module.exports = { createSecurity };
