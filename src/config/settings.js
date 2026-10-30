'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const pkg = require('../../package.json');
const { err } = require('../errors');
const { normalizeOrigin, assertNavigableUrl } = require('../utils/url-utils');
const { atomicWriteJson, readJsonSafe } = require('../utils/file-utils');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER_TOKENS = new Set(['generate_a_secure_random_token', 'changeme', 'change-me', 'your-token-here', 'secret']);
const PLACEHOLDER_ORIGIN = 'https://your-username.github.io';

function intVar(source, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

function boolVar(source, name, fallback) {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}").`);
}

/** Load a local .env file when present (Node >= 20.12). Real environment variables always win. */
function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (typeof process.loadEnvFile !== 'function' || !fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/**
 * Parse and validate configuration from environment variables. Throws ConfigError with a
 * message that never contains the API token value.
 */
function createEnv(source = process.env) {
  const nodeEnv = source.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isRender = String(source.RENDER).toLowerCase() === 'true';

  const apiToken = source.API_TOKEN || '';
  if (!apiToken) {
    throw new ConfigError('API_TOKEN is not set. Generate one with "npm run token" and set it in the environment.');
  }
  if (PLACEHOLDER_TOKENS.has(apiToken.toLowerCase())) {
    throw new ConfigError('API_TOKEN is still a placeholder value. Generate a real one with "npm run token".');
  }
  const minTokenLength = isProduction ? 24 : 16;
  if (apiToken.length < minTokenLength) {
    throw new ConfigError(`API_TOKEN must be at least ${minTokenLength} characters long.`);
  }

  const dashboardOrigins = String(source.DASHBOARD_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      if (value === '*' || value.includes('*')) throw new ConfigError('DASHBOARD_ORIGIN must not contain wildcards.');
      const origin = normalizeOrigin(value);
      if (!origin) throw new ConfigError(`DASHBOARD_ORIGIN contains an invalid origin: "${value}".`);
      return origin;
    });

  const baseDir = source.DATA_DIR
    ? path.resolve(source.DATA_DIR)
    : path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'screenshot-automation');
  const screenshotDir = path.resolve(source.SCREENSHOT_DIR || path.join(baseDir, 'screenshots'));

  const allowPrivateUrls = boolVar(source, 'ALLOW_PRIVATE_URLS', false);
  const defaultLoginUrl = source.DEFAULT_LOGIN_URL || 'https://aaj23525.apps.dynatrace.com/';
  try {
    assertNavigableUrl(defaultLoginUrl, { allowPrivate: allowPrivateUrls });
  } catch (e) {
    throw new ConfigError(`DEFAULT_LOGIN_URL is not usable: ${e.message}`);
  }

  const screenshotFormat = source.SCREENSHOT_FORMAT || 'png';
  if (!['png', 'jpeg'].includes(screenshotFormat)) throw new ConfigError('SCREENSHOT_FORMAT must be png or jpeg.');
  const screenshotType = source.SCREENSHOT_TYPE || 'viewport';
  if (!['viewport', 'fullPage'].includes(screenshotType)) throw new ConfigError('SCREENSHOT_TYPE must be viewport or fullPage.');

  const warnings = [];
  if (dashboardOrigins.includes(PLACEHOLDER_ORIGIN)) {
    warnings.push('DASHBOARD_ORIGIN still contains the placeholder value; no real dashboard origin is allowed.');
  }
  if (isProduction && dashboardOrigins.length === 0) {
    warnings.push('DASHBOARD_ORIGIN is empty; cross-origin dashboard requests will be rejected.');
  }

  return Object.freeze({
    name: pkg.name,
    version: pkg.version,
    nodeEnv,
    isProduction,
    isTest: nodeEnv === 'test',
    port: intVar(source, 'PORT', 3000, { min: 0, max: 65535 }),
    host: '0.0.0.0',
    apiToken,
    dashboardOrigins,
    dataDir: baseDir,
    screenshotDir,
    workflowDir: path.join(baseDir, 'workflows'),
    runtimeDir: path.join(baseDir, 'runtime'),
    trustProxy: intVar(source, 'TRUST_PROXY', isRender || isProduction ? 1 : 0, { min: 0, max: 5 }),
    allowPrivateUrls,
    browserLowMemory: boolVar(source, 'BROWSER_LOW_MEMORY', isRender),
    maxScreenshots: intVar(source, 'MAX_SCREENSHOTS', 200, { min: 1, max: 5000 }),
    maxScreenshotBytes: intVar(source, 'MAX_SCREENSHOT_MB', 200, { min: 1, max: 4096 }) * 1024 * 1024,
    sseMaxClients: intVar(source, 'SSE_MAX_CLIENTS', 10, { min: 1, max: 100 }),
    minFreeMemoryMB: intVar(source, 'MIN_FREE_MEMORY_MB', 150, { min: 0, max: 4096 }),
    rateLimitPerMinute: intVar(source, 'RATE_LIMIT_PER_MINUTE', 600, { min: 10, max: 100000 }),
    logLevel: source.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    defaults: Object.freeze({
      defaultLoginUrl,
      viewportWidth: intVar(source, 'DEFAULT_VIEWPORT_WIDTH', 1920, { min: 320, max: 3840 }),
      viewportHeight: intVar(source, 'DEFAULT_VIEWPORT_HEIGHT', 1080, { min: 240, max: 2160 }),
      navigationTimeout: intVar(source, 'NAVIGATION_TIMEOUT', 30000, { min: 1000, max: 120000 }),
      elementTimeout: intVar(source, 'ELEMENT_TIMEOUT', 15000, { min: 500, max: 120000 }),
      additionalPageDelay: intVar(source, 'ADDITIONAL_PAGE_DELAY', 5000, { min: 0, max: 60000 }),
      screenshotFormat,
      screenshotType,
      screenshotQuality: intVar(source, 'SCREENSHOT_QUALITY', 80, { min: 1, max: 100 }),
      headless: boolVar(source, 'BROWSER_HEADLESS', true),
    }),
    render: Object.freeze({
      isRender,
      serviceName: source.RENDER_SERVICE_NAME || null,
      externalUrl: source.RENDER_EXTERNAL_URL || null,
      instanceId: source.RENDER_INSTANCE_ID || null,
      gitCommit: source.RENDER_GIT_COMMIT ? String(source.RENDER_GIT_COMMIT).slice(0, 12) : null,
    }),
    warnings,
  });
}

// ---------------------------------------------------------------------------------------------
// Runtime-adjustable settings (GET/PUT /api/settings)
// ---------------------------------------------------------------------------------------------

const SETTING_BOUNDS = {
  viewportWidth: [320, 3840],
  viewportHeight: [240, 2160],
  navigationTimeout: [1000, 120000],
  elementTimeout: [500, 120000],
  additionalPageDelay: [0, 60000],
  screenshotQuality: [1, 100],
};
const SETTING_ENUMS = {
  screenshotFormat: ['png', 'jpeg'],
  screenshotType: ['viewport', 'fullPage'],
};
const SETTING_KEYS = [
  'defaultLoginUrl',
  'viewportWidth',
  'viewportHeight',
  'navigationTimeout',
  'elementTimeout',
  'additionalPageDelay',
  'screenshotFormat',
  'screenshotType',
  'screenshotQuality',
  'headless',
];
const RELAUNCH_KEYS = new Set(['headless']);

class SettingsStore extends EventEmitter {
  constructor(env) {
    super();
    this.env = env;
    this.file = path.join(env.runtimeDir, 'settings.json');
    this.values = { ...env.defaults };
    // Same exception the browser applies when navigating (the built-in demo site), so a URL the browser may open can also
    // be configured as the login URL. Supplied by the container; absent when the store is used on its own.
    this.urlException = null;
  }

  /** Restore overrides saved by an earlier process that shared this filesystem. */
  async load() {
    const saved = await readJsonSafe(this.file);
    if (!saved || typeof saved !== 'object') return;
    const candidate = {};
    for (const key of SETTING_KEYS) if (key in saved) candidate[key] = saved[key];
    try {
      this.values = { ...this.values, ...this._validate(candidate) };
    } catch {
      // A corrupt or outdated settings file is ignored; defaults stay in effect.
    }
  }

  get() {
    return { ...this.values };
  }

  _validate(patch) {
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTING_KEYS.includes(key)) {
        throw err.unprocessable('invalid_settings', `Unknown setting "${key}".`);
      }
      if (key in SETTING_BOUNDS) {
        const [min, max] = SETTING_BOUNDS[key];
        if (!Number.isInteger(value) || value < min || value > max) {
          throw err.unprocessable('invalid_settings', `${key} must be an integer between ${min} and ${max}.`);
        }
      } else if (key in SETTING_ENUMS) {
        if (!SETTING_ENUMS[key].includes(value)) {
          throw err.unprocessable('invalid_settings', `${key} must be one of: ${SETTING_ENUMS[key].join(', ')}.`);
        }
      } else if (key === 'headless') {
        if (typeof value !== 'boolean') throw err.unprocessable('invalid_settings', 'headless must be a boolean.');
      } else if (key === 'defaultLoginUrl') {
        out[key] = assertNavigableUrl(value, { allowPrivate: this.env.allowPrivateUrls, isException: this.urlException });
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  async update(patch) {
    const valid = this._validate(patch);
    const changed = Object.keys(valid).filter((k) => this.values[k] !== valid[k]);
    this.values = { ...this.values, ...valid };
    if (changed.length) {
      try {
        await atomicWriteJson(this.file, this.values);
      } catch {
        // Persistence is best-effort; the in-memory values are authoritative.
      }
      this.emit('change', { changed, values: this.get() });
    }
    return { settings: this.get(), changed, requiresRelaunch: changed.some((k) => RELAUNCH_KEYS.has(k)) };
  }

  async reset() {
    const before = this.values;
    this.values = { ...this.env.defaults };
    const changed = SETTING_KEYS.filter((k) => before[k] !== this.values[k]);
    try {
      await fs.promises.unlink(this.file);
    } catch {
      /* nothing to remove */
    }
    if (changed.length) this.emit('change', { changed, values: this.get() });
    return { settings: this.get(), changed, requiresRelaunch: changed.some((k) => RELAUNCH_KEYS.has(k)) };
  }
}

module.exports = { createEnv, loadDotEnv, ConfigError, SettingsStore, SETTING_KEYS, SETTING_BOUNDS, SETTING_ENUMS };
