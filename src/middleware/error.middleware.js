'use strict';

const crypto = require('node:crypto');
const { AppError, err } = require('../errors');
const logger = require('../utils/logger');

/** Assign a request id (also returned as X-Request-Id so users can quote it in bug reports). */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[A-Za-z0-9_.-]{6,64}$/.test(incoming) ? incoming : crypto.randomBytes(6).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
}

/** One access-log line per request. Paths only: query strings, headers and bodies are never logged. */
function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  // Express rewrites req.url while a request travels through mounted routers, so capture the path now.
  const path = req.path;
  res.on('finish', () => {
    if (path === '/api/status' && res.statusCode === 200) return; // health checks are noisy
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`, { id: req.id });
  });
  next();
}

function notFound(req, _res, next) {
  next(err.notFound('route_not_found', `No endpoint matches ${req.method} ${req.path}.`, { hint: 'See /api/docs for the list of endpoints.' }));
}

/** Convert anything thrown into the standard JSON error envelope without leaking internals. */
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, _next) {
  let appError = error;
  if (!(error instanceof AppError)) {
    if (error?.type === 'entity.parse.failed') {
      appError = err.badRequest('invalid_json', 'The request body is not valid JSON.');
    } else if (error?.type === 'entity.too.large') {
      appError = new AppError(413, 'payload_too_large', 'The request body is too large.');
    } else if (error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') {
      appError = err.badRequest('unsupported_encoding', 'Unsupported request encoding.');
    } else {
      logger.error('Unhandled error', { id: req.id, path: req.path, error });
      appError = err.internal('internal_error', 'An unexpected error occurred.');
    }
  } else if (appError.status >= 500) {
    logger.warn('Request failed', { id: req.id, path: req.path, code: appError.code });
  }

  if (res.headersSent) {
    // Streaming responses (ZIP, SSE) cannot carry a JSON error any more; abort the connection instead.
    res.destroy();
    return;
  }
  const payload = { code: appError.code, message: appError.message, status: appError.status, requestId: req.id };
  if (appError.details !== undefined) payload.details = appError.details;
  if (appError.hint) payload.hint = appError.hint;
  res.status(appError.status).json({ ok: false, error: payload });
}

module.exports = { requestId, requestLogger, notFound, errorHandler };
