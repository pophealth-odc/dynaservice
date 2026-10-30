'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Keys whose values must never reach the logs, whatever the call site passes in.
const SENSITIVE_KEY = /token|authorization|password|passwd|secret|cookie|credential|otp|mfa|text|value/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, code: value.code, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

let configuredLevel = null;

/** Set the log level explicitly (from validated configuration). Falls back to LOG_LEVEL, then "info". */
function setLevel(level) {
  configuredLevel = LEVELS[String(level || '').toLowerCase()] ?? null;
}

function currentLevel() {
  if (configuredLevel !== null) return configuredLevel;
  return LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}

function write(level, message, meta) {
  if (LEVELS[level] < currentLevel()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${
    meta === undefined ? '' : ` ${JSON.stringify(redact(meta))}`
  }`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const logger = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  setLevel,
  redact,
};

module.exports = logger;
