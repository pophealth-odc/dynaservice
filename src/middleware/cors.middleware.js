'use strict';

const { err } = require('../errors');

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Last-Event-ID, Range, If-None-Match';
const EXPOSED_HEADERS = [
  'Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag',
  'X-Screenshot-Id', 'X-Screenshot-Sha256', 'X-Viewport-Width', 'X-Viewport-Height', 'X-Page-Url',
  'X-Export-Count', 'X-Request-Id', 'Retry-After', 'RateLimit',
].join(', ');

/**
 * Exact-origin CORS allowlist (no wildcards, no credentials/cookies: authentication is a bearer token).
 *
 * - No Origin header (curl, server-to-server): allowed, no CORS headers needed.
 * - Same origin (the built-in test page and Swagger UI): allowed without CORS headers.
 * - Configured dashboard origin: allowed, with CORS headers.
 * - Anything else: refused with 403. Preflights from unknown origins get no CORS headers.
 */
function createCors(security) {
  return function cors(req, res, next) {
    const origin = security.classifyOrigin(req);
    res.vary('Origin');
    if (!origin.present) {
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }
    if (!origin.allowed) {
      return next(err.forbidden('origin_not_allowed', 'This origin is not allowed to call the API.', {
        hint: 'Set DASHBOARD_ORIGIN on the service to the exact origin of your dashboard.',
      }));
    }
    if (origin.crossOrigin) {
      res.set({
        'Access-Control-Allow-Origin': origin.origin,
        'Access-Control-Expose-Headers': EXPOSED_HEADERS,
      });
    }
    if (req.method === 'OPTIONS') {
      if (origin.crossOrigin) {
        res.set({
          'Access-Control-Allow-Methods': ALLOWED_METHODS,
          'Access-Control-Allow-Headers': ALLOWED_HEADERS,
          'Access-Control-Max-Age': '600',
        });
      }
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { createCors, ALLOWED_METHODS, ALLOWED_HEADERS };
