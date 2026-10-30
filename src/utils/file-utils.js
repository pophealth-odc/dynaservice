'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reduce arbitrary text to a short, filesystem-safe fragment (letters, digits, underscore, dash). */
function sanitizeFilePart(text, fallback = 'item', maxLength = 40) {
  const cleaned = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)
    .replace(/_+$/g, '');
  return cleaned || fallback;
}

/**
 * Resolve `name` inside `baseDir`, refusing anything that would escape it
 * (path separators, `..`, absolute paths, NUL bytes).
 */
function safeJoin(baseDir, name) {
  const base = path.resolve(baseDir);
  if (typeof name !== 'string' || !name || name.includes('\0') || /[\\/]/.test(name) || name === '..' || name === '.') {
    throw new Error('Unsafe file name');
  }
  const full = path.resolve(base, name);
  if (path.dirname(full) !== base) throw new Error('Unsafe file name');
  return full;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Write a file atomically (temp file + rename) so a crash never leaves a half-written JSON file. */
async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

const atomicWriteJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2));

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function removeIfExists(file) {
  try {
    await fsp.unlink(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

const fileExists = (file) => fs.promises.access(file).then(() => true, () => false);

async function isWritable(dir) {
  try {
    await fsp.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  UUID_RE,
  sanitizeFilePart,
  safeJoin,
  ensureDir,
  atomicWrite,
  atomicWriteJson,
  readJsonSafe,
  removeIfExists,
  fileExists,
  isWritable,
};
