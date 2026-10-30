'use strict';

const net = require('node:net');
const { err } = require('../errors');

const MAX_URL_LENGTH = 2048;

// Query / fragment parameters whose values are credentials or session material.
const SENSITIVE_PARAM =
  /^(token|access_token|id_token|refresh_token|code|state|session|sessionid|session_id|sid|password|pwd|passwd|secret|client_secret|key|api_key|apikey|auth|authorization|samlresponse|samlrequest|relaystate|ticket|otp|nonce|assertion)$/i;

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inRange(ipInt, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => inRange(n, base, bits));
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:abcd:efgh) — judge by the embedded IPv4 address.
  const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

/** True for loopback, link-local, RFC1918/CGNAT and internal-looking host names. */
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const family = net.isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) return isPrivateIPv6(host);
  return false;
}

/**
 * Validate a URL that the cloud browser is about to open and return its normalized href.
 * Only http(s) is allowed (no file:, data:, javascript:, chrome: ...), credentials in the URL are
 * refused, and private/loopback hosts are refused unless `allowPrivate` is set (local development).
 */
function assertNavigableUrl(input, { allowPrivate = false, allowBlank = false, isException = null } = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    throw err.badRequest('invalid_url', 'A URL is required.');
  }
  const raw = input.trim();
  if (allowBlank && raw === 'about:blank') return raw;
  if (raw.length > MAX_URL_LENGTH) {
    throw err.badRequest('invalid_url', `URL is longer than ${MAX_URL_LENGTH} characters.`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw err.badRequest('invalid_url', 'The value is not a valid absolute URL (example: https://example.com/).');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw err.badRequest('invalid_url_scheme', `Only http and https URLs can be opened (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw err.badRequest('invalid_url', 'URLs must not contain embedded credentials.');
  }
  if (isException && isException(url.href)) return url.href;
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw err.badRequest('url_not_allowed', 'URLs that point at localhost or private networks are not allowed.', {
      hint: 'Set ALLOW_PRIVATE_URLS=true only for local development.',
    });
  }
  return url.href;
}

/** Strip credentials and redact sensitive query/fragment values so a URL can be shown or logged. */
function sanitizeUrl(input) {
  if (typeof input !== 'string' || !input) return input ?? null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return input.length > 200 ? `${input.slice(0, 200)}…` : input;
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '[redacted]');
  }
  if (url.hash.includes('=')) {
    const params = new URLSearchParams(url.hash.slice(1));
    let changed = false;
    for (const key of [...params.keys()]) {
      if (SENSITIVE_PARAM.test(key)) {
        params.set(key, '[redacted]');
        changed = true;
      }
    }
    if (changed) url.hash = params.toString();
  }
  const out = url.href;
  return out.length > 1000 ? `${out.slice(0, 1000)}…` : out;
}

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Parse "/regex/flags" notation; returns null when the text is not in that form. */
function parseRegexLiteral(pattern) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (!m) return null;
  return new RegExp(m[1], m[2].replace(/[^gimsuy]/g, ''));
}

/**
 * Check a URL pattern is usable. Patterns are one of:
 *  - "/regex/flags"        regular expression tested against the full URL
 *  - text containing * ?   glob (* = anything except "/", ** = anything, case-insensitive, full match)
 *  - any other text        substring match
 */
function validateUrlPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'URL pattern must be a non-empty string.';
  if (pattern.length > 500) return 'URL pattern is longer than 500 characters.';
  if (pattern.startsWith('/') && pattern.length > 2 && pattern.lastIndexOf('/') > 0) {
    try {
      if (parseRegexLiteral(pattern)) return null;
    } catch (e) {
      return `Invalid regular expression: ${e.message}`;
    }
  }
  return null;
}

function matchUrlPattern(pattern, url) {
  if (typeof pattern !== 'string' || typeof url !== 'string') return false;
  let regex = null;
  try {
    regex = parseRegexLiteral(pattern);
  } catch {
    return false;
  }
  if (regex) return regex.test(url);
  if (/[*?]/.test(pattern)) return globToRegex(pattern).test(url);
  return url.toLowerCase().includes(pattern.toLowerCase());
}

/** Reduce a configured dashboard origin (which may include a GitHub Pages path) to a bare origin. */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

module.exports = {
  assertNavigableUrl,
  sanitizeUrl,
  isPrivateHost,
  matchUrlPattern,
  validateUrlPattern,
  normalizeOrigin,
  globToRegex,
};
