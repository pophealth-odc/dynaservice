'use strict';

/**
 * Application error carrying an HTTP status and a stable machine-readable code.
 * The error middleware turns these into the consistent JSON error envelope.
 */
class AppError extends Error {
  constructor(status, code, message, { details, hint, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

const err = {
  badRequest: (code, message, opts) => new AppError(400, code, message, opts),
  unauthorized: (code, message, opts) => new AppError(401, code, message, opts),
  forbidden: (code, message, opts) => new AppError(403, code, message, opts),
  notFound: (code, message, opts) => new AppError(404, code, message, opts),
  conflict: (code, message, opts) => new AppError(409, code, message, opts),
  gone: (code, message, opts) => new AppError(410, code, message, opts),
  unprocessable: (code, message, opts) => new AppError(422, code, message, opts),
  tooMany: (code, message, opts) => new AppError(429, code, message, opts),
  internal: (code, message, opts) => new AppError(500, code, message, opts),
  badGateway: (code, message, opts) => new AppError(502, code, message, opts),
  unavailable: (code, message, opts) => new AppError(503, code, message, opts),
  gatewayTimeout: (code, message, opts) => new AppError(504, code, message, opts),
};

module.exports = { AppError, err };
