'use strict';

const fs = require('node:fs');
const os = require('node:os');

const MB = 1024 * 1024;
const toMB = (bytes) => Math.round((bytes / MB) * 10) / 10;

function readNumber(file, read) {
  try {
    const text = String(read(file)).trim();
    if (!text || text === 'max') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Memory figures for this service. Inside a container the cgroup limit/usage (which includes the
 * Chromium child processes) is what matters; on a plain host the OS totals are used instead.
 * `read` and `osInfo` are injectable so the logic is unit-testable.
 */
function getMemoryInfo({ read = (f) => fs.readFileSync(f, 'utf8'), osInfo = os, proc = process } = {}) {
  const mu = proc.memoryUsage();

  let limit = readNumber('/sys/fs/cgroup/memory.max', read);
  let used = readNumber('/sys/fs/cgroup/memory.current', read);
  let source = 'cgroup-v2';
  if (limit == null || used == null) {
    limit = readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes', read);
    used = readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes', read);
    source = 'cgroup-v1';
  }
  // cgroup v1 reports "no limit" as a huge number rather than "max".
  if (limit == null || used == null || limit > osInfo.totalmem() * 4) {
    limit = osInfo.totalmem();
    used = osInfo.totalmem() - osInfo.freemem();
    source = 'os';
  }
  return {
    source,
    rssMB: toMB(mu.rss),
    heapUsedMB: toMB(mu.heapUsed),
    heapTotalMB: toMB(mu.heapTotal),
    externalMB: toMB(mu.external),
    limitMB: toMB(limit),
    usedMB: toMB(used),
    availableMB: toMB(Math.max(0, limit - used)),
  };
}

module.exports = { getMemoryInfo, toMB };
