'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNavigableUrl, sanitizeUrl, isPrivateHost, matchUrlPattern, validateUrlPattern, normalizeOrigin } = require('../../src/utils/url-utils');

test('assertNavigableUrl accepts normal http(s) URLs and normalizes them', () => {
  assert.equal(assertNavigableUrl('https://aaj23525.apps.dynatrace.com/'), 'https://aaj23525.apps.dynatrace.com/');
  assert.equal(assertNavigableUrl('  http://example.com  '), 'http://example.com/');
});

test('assertNavigableUrl rejects non-http schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'chrome://settings', 'ftp://example.com/', 'about:blank']) {
    assert.throws(() => assertNavigableUrl(url), (e) => e.code === 'invalid_url_scheme' || e.code === 'invalid_url', url);
  }
});

test('assertNavigableUrl rejects empty, malformed, oversized and credential-bearing URLs', () => {
  for (const url of ['', '   ', 'not a url', '/relative/path', undefined, null, 42]) {
    assert.throws(() => assertNavigableUrl(url), (e) => e.code === 'invalid_url', String(url));
  }
  assert.throws(() => assertNavigableUrl(`https://example.com/${'a'.repeat(3000)}`), (e) => e.code === 'invalid_url');
  assert.throws(() => assertNavigableUrl('https://user:pass@example.com/'), (e) => e.code === 'invalid_url');
});

test('private, loopback, link-local and metadata hosts are refused (SSRF)', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', 'localhost', 'foo.localhost', 'db.internal', 'printer.local', 'metadata.google.internal', '[::1]', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateHost(host), true, host);
    assert.throws(() => assertNavigableUrl(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`), (e) => e.code === 'url_not_allowed', host);
  }
});

test('public hosts are not treated as private', () => {
  for (const host of ['aaj23525.apps.dynatrace.com', 'example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('allowPrivate and isException relax the private-host rule only as asked', () => {
  assert.equal(assertNavigableUrl('http://localhost:3000/', { allowPrivate: true }), 'http://localhost:3000/');
  assert.throws(() => assertNavigableUrl('http://localhost:3000/x'));
  assert.equal(assertNavigableUrl('http://127.0.0.1:3000/ok', { isException: (h) => h.endsWith('/ok') }), 'http://127.0.0.1:3000/ok');
  assert.throws(() => assertNavigableUrl('http://127.0.0.1:3000/no', { isException: (h) => h.endsWith('/ok') }));
});

test('sanitizeUrl removes credentials and redacts sensitive query and fragment values', () => {
  const out = sanitizeUrl('https://user:pw@x.com/a?token=abc&q=1&code=zzz#access_token=secret&x=1');
  assert.ok(!out.includes('pw@'));
  assert.ok(!out.includes('abc') && !out.includes('zzz') && !out.includes('secret'));
  assert.match(out, /q=1/);
  assert.match(out, /x=1/);
  assert.equal(sanitizeUrl(null), null);
  assert.equal(sanitizeUrl('not a url'), 'not a url');
});

test('matchUrlPattern supports substring, glob and /regex/ patterns', () => {
  assert.equal(matchUrlPattern('/problems', 'https://a.com/ui/problems?x=1'), true);
  assert.equal(matchUrlPattern('PROBLEMS', 'https://a.com/ui/problems'), true);
  assert.equal(matchUrlPattern('/services', 'https://a.com/ui/problems'), false);
  assert.equal(matchUrlPattern('https://a.com/*/problems*', 'https://a.com/ui/problems?x=1'), true);
  assert.equal(matchUrlPattern('https://a.com/*/problems', 'https://a.com/a/b/problems'), false, '* does not cross slashes');
  assert.equal(matchUrlPattern('https://a.com/**/problems', 'https://a.com/a/b/problems'), true, '** does');
  assert.equal(matchUrlPattern('/^https:\\/\\/a\\.com\\/ui\\/(problems|services)$/', 'https://a.com/ui/services'), true);
  assert.equal(matchUrlPattern('/^https:\\/\\/a\\.com\\/ui\\/problems$/', 'https://a.com/ui/services'), false);
  assert.equal(matchUrlPattern('/(/', 'x'), false, 'a broken regex never matches instead of throwing');
});

test('validateUrlPattern flags unusable patterns', () => {
  assert.equal(validateUrlPattern('/problems'), null);
  assert.equal(validateUrlPattern('/^https:\\/\\/a\\.com/i'), null);
  assert.match(validateUrlPattern('/(/'), /regular expression/i);
  assert.match(validateUrlPattern(''), /non-empty/);
  assert.match(validateUrlPattern('x'.repeat(600)), /500/);
});

test('normalizeOrigin strips paths so GitHub Pages project URLs compare by origin', () => {
  assert.equal(normalizeOrigin('https://me.github.io/some/project/'), 'https://me.github.io');
  assert.equal(normalizeOrigin('https://me.github.io'), 'https://me.github.io');
  assert.equal(normalizeOrigin('http://localhost:5173/app'), 'http://localhost:5173');
  assert.equal(normalizeOrigin('ftp://me.github.io'), null);
  assert.equal(normalizeOrigin('nonsense'), null);
  assert.equal(normalizeOrigin(''), null);
});
