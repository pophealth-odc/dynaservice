'use strict';

const Ajv = require('ajv');
const { err } = require('../errors');

const bodyAjv = new Ajv({ allErrors: true, strict: false, formats: { uuid: /^[0-9a-f-]{36}$/i } });
// Query strings are always strings, so numbers and booleans are coerced.
const queryAjv = new Ajv({ allErrors: true, strict: false, coerceTypes: true, formats: { uuid: /^[0-9a-f-]{36}$/i } });

function formatErrors(errors = []) {
  return errors.slice(0, 20).map((e) => {
    let path = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)';
    let message = e.message;
    if (e.keyword === 'additionalProperties') {
      path = path === '(root)' ? e.params.additionalProperty : `${path}.${e.params.additionalProperty}`;
      message = 'unknown property';
    } else if (e.keyword === 'required') {
      path = path === '(root)' ? e.params.missingProperty : `${path}.${e.params.missingProperty}`;
      message = 'is required';
    } else if (e.keyword === 'enum') {
      message = `must be one of: ${e.params.allowedValues.join(', ')}`;
    }
    return { path, message };
  });
}

const cache = new WeakMap();
function compile(ajv, schema) {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

/** Validate req.body against a JSON schema. A missing body counts as {}. */
function validateBody(schema) {
  const check = compile(bodyAjv, schema);
  return (req, _res, next) => {
    const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
    if (hasBody && req.body === undefined) {
      return next(err.badRequest('unsupported_media_type', 'Send the request body as JSON with "Content-Type: application/json".', { hint: 'Missing or unsupported Content-Type.' }));
    }
    const body = req.body === undefined ? {} : req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return next(err.unprocessable('invalid_body', 'The request body must be a JSON object.'));
    }
    if (!check(body)) {
      return next(err.unprocessable('invalid_request', 'The request body is not valid.', { details: { problems: formatErrors(check.errors) } }));
    }
    req.body = body;
    return next();
  };
}

/** Validate and coerce req.query. The coerced values are placed on req.validatedQuery. */
function validateQuery(schema) {
  const check = compile(queryAjv, schema);
  return (req, _res, next) => {
    const query = { ...req.query };
    if (!check(query)) {
      return next(err.unprocessable('invalid_query', 'The query parameters are not valid.', { details: { problems: formatErrors(check.errors) } }));
    }
    req.validatedQuery = query;
    return next();
  };
}

module.exports = { validateBody, validateQuery, formatErrors };
