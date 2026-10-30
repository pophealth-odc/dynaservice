'use strict';

const rateLimit = require('express-rate-limit');
const { err } = require('../errors');

/**
 * Bearer-token authentication. The token is accepted ONLY from the Authorization header: never from the
 * URL or the body, because those end up in logs, history and referrers. Error messages never echo it.
 */
function createAuth(security) {
  const challenge = (res) => res.set('WWW-Authenticate', 'Bearer realm="cloud-screenshot-service"');

  function authenticate(req, res, next) {
    const token = security.parseBearer(req.get('authorization'));
    if (!token) {
      challenge(res);
      return next(err.unauthorized('missing_token', 'An "Authorization: Bearer <token>" header is required.'));
    }
    if (!security.tokenMatches(token)) {
      challenge(res);
      return next(err.unauthorized('invalid_token', 'The API token is not valid.'));
    }
    req.authenticated = true;
    return next();
  }

  /** Marks req.authenticated without rejecting (used by GET /api/status). */
  function optional(req, _res, next) {
    const token = security.parseBearer(req.get('authorization'));
    req.authenticated = Boolean(token && security.tokenMatches(token));
    next();
  }

  return { authenticate, optional };
}

/**
 * Slows down token guessing: after too many failed authentications an address is blocked for a while.
 * Successful requests do not count toward the limit.
 */
function createAuthFailureLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(err.tooMany('too_many_auth_failures', 'Too many failed authentication attempts. Try again later.')),
  });
}

module.exports = { createAuth, createAuthFailureLimiter };
