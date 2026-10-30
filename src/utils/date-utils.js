'use strict';

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** UTC timestamp usable inside file names, e.g. 2026-10-30_130000. */
function timestampForFilename(date = new Date()) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

const nowIso = () => new Date().toISOString();

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

module.exports = { timestampForFilename, nowIso, formatDuration };
