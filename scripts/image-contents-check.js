'use strict';

/*
 * Checks, without Docker, that the files the Dockerfile COPYs are not removed by .dockerignore and that every relative
 * require() in them resolves inside that set. It catches "works on my machine, MODULE_NOT_FOUND in the image".
 *
 *   node scripts/image-contents-check.js
 *
 * .dockerignore matching here is simplified (plain names, *, directory prefixes, ! re-includes), which covers this repo's file.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const lines = fs.readFileSync('.dockerignore', 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const toRegex = (pattern) => {
  const body = pattern.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}(/.*)?$`);
};
const include = lines.filter((p) => p.startsWith('!')).map((p) => toRegex(p.slice(1)));
const exclude = lines.filter((p) => !p.startsWith('!')).map(toRegex);
const ignored = (file) => {
  const matches = (rx) => rx.test(file) || rx.test(path.posix.basename(file));
  return exclude.some(matches) && !include.some(matches);
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(dir, e.name)) : [path.posix.join(dir, e.name)]));
// Exactly what the Dockerfile copies (see the COPY lines).
const copied = ['package.json', 'package-lock.json', 'server.js', ...walk('src')];

let failed = false;
const removed = copied.filter(ignored);
console.log(`Dockerfile COPYs ${copied.length} files; excluded by .dockerignore: ${removed.length ? removed.join(', ') : 'none'}`);
if (removed.length) failed = true;

const inImage = new Set(copied);
const unresolved = [];
for (const file of copied.filter((f) => f.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/require\('(\.[^']+)'\)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    if (![target, `${target}.js`, `${target}.json`, `${target}/index.js`].some((c) => inImage.has(c))) unresolved.push(`${file} -> ${m[1]}`);
  }
}
console.log(`relative require() calls that would not resolve inside the image: ${unresolved.length ? unresolved.join(', ') : 'none'}`);
if (unresolved.length) failed = true;

// Static files served by the app must also be present.
const served = ['src/testing/test.html', 'src/testing/test.css', 'src/testing/test.js', 'src/testing/fixture/index.html', 'src/testing/fixture/app.js', 'src/testing/fixture/app.css', 'src/testing/fixture/frame.html', 'src/testing/fixture/frame.js'];
const missing = served.filter((f) => !inImage.has(f));
console.log(`static assets served by /api/test missing from the image: ${missing.length ? missing.join(', ') : 'none'}`);
if (missing.length) failed = true;

const needsPackageJson = copied.filter((f) => f.endsWith('.js') && /require\('(\.\.\/)+package\.json'\)/.test(fs.readFileSync(f, 'utf8')));
console.log(`files that read package.json at runtime (copied, so fine): ${needsPackageJson.join(', ') || 'none'}`);

process.exit(failed ? 1 : 0);
