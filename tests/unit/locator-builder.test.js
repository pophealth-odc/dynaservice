'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lb = require('../../src/automation/locator-builder');
const { assessElement } = require('../../src/automation/safety');

const node = (o) => ({ tag: 'div', id: null, classes: [], data: {}, name: null, role: null, index: 1, sameTag: 1, childIndex: 1, crossesShadow: false, ...o });
const info = (o) => ({ tag: 'a', id: null, classes: [], text: '', role: null, name: '', attributes: {}, dataAttributes: {}, hrefPath: null, sensitive: false, isFormControl: false, ...o });
const strategies = (cands) => cands.map((c) => c.strategy);

test('priority: a unique stable id comes first, then data, role, css, text, xpath', () => {
  const cands = lb.buildCandidates(
    info({ id: 'nav-problems', text: 'Problems', role: 'link', name: 'Problems', dataAttributes: { 'data-testid': 'problems' } }),
    [node({ tag: 'a', id: 'nav-problems' }), node({ tag: 'nav', data: { 'data-testid': 'main-nav' } }), node({ tag: 'body' }), node({ tag: 'html' })],
  );
  const order = strategies(cands);
  assert.equal(order[0], 'id');
  assert.ok(order.indexOf('data') < order.indexOf('role'));
  assert.ok(order.indexOf('role') < order.indexOf('css'));
  assert.ok(order.indexOf('css') < order.indexOf('text'));
  assert.ok(order.indexOf('text') < order.indexOf('xpath'));
  assert.deepEqual(cands.map((c) => c.priority), [...cands.map((c) => c.priority)].sort((a, b) => a - b));
});

test('dynamic-looking ids and classes are never used as locators', () => {
  for (const id of [':r1a2b:', 'ember1234', 'react-select-3-input', 'radix-:r5:', 'a1b2c3d4e5f6a7b8c9d0e1f2', '3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11', 'mui-12345']) {
    assert.equal(lb.looksDynamic(id), true, id);
  }
  for (const id of ['nav-problems', 'submit', 'main-nav', 'login_button']) assert.equal(lb.looksDynamic(id), false, id);
  const cands = lb.buildCandidates(info({ id: ':r1a2b:', classes: ['css-9f3k2j1', 'is-active', 'btn'] }), [node({ tag: 'a', id: ':r1a2b:', classes: ['css-9f3k2j1', 'is-active', 'btn'] })]);
  const all = JSON.stringify(cands);
  assert.ok(!all.includes(':r1a2b:'), 'dynamic id leaked');
  assert.ok(!all.includes('css-9f3k2j1'), 'css-in-js class leaked');
  assert.ok(!all.includes('is-active'), 'state class leaked');
  assert.ok(all.includes('btn'), 'a stable class is still usable');
});

test('sensitive fields never produce name, placeholder or text based locators', () => {
  const cands = lb.buildCandidates(
    info({ tag: 'input', isFormControl: true, sensitive: true, text: '', name: 'Password', role: 'textbox', attributes: { type: 'password', name: 'pw', placeholder: 'Password' } }),
    [node({ tag: 'input' }), node({ tag: 'form' })],
  );
  const json = JSON.stringify(cands);
  assert.ok(!strategies(cands).includes('role'));
  assert.ok(!strategies(cands).includes('text'));
  assert.ok(!/placeholder/i.test(json));
  assert.ok(!json.includes('"pw"') && !json.includes('Password'));
});

test('css attribute values are escaped so a quote cannot break out of the selector', () => {
  const cands = lb.buildCandidates(info({ attributes: { 'aria-label': 'Say "hi"\\there' } }), [node({ tag: 'a' })]);
  const css = cands.find((c) => c.strategy === 'css' && c.selector.includes('aria-label'));
  assert.ok(css);
  assert.equal(css.selector, 'a[aria-label="Say \\"hi\\"\\\\there"]');
  assert.equal(lb.cssEscape('a b'), 'a\\ b');
  assert.equal(lb.cssEscape('1abc'), '\\31 abc');
  assert.equal(lb.cssEscape('-'), '\\-');
});

test('positional CSS crosses shadow roots with a descendant combinator', () => {
  // Shape produced by the real picker: the node directly under a shadow root has crossesShadow=true, because
  // its link to the next entry (the shadow host) is the shadow boundary.
  const css = lb.positionalCss([
    node({ tag: 'button', index: 1, sameTag: 1 }),
    node({ tag: 'div', index: 1, sameTag: 2, crossesShadow: true }),
    node({ tag: 'x-card', id: 'host' }),
    node({ tag: 'body' }),
  ]);
  assert.equal(css, '#host div:nth-of-type(1) > button');
});

test('positional CSS and XPath anchor on the element itself when it has a stable id', () => {
  const chain = [node({ tag: 'a', id: 'x1' }), node({ tag: 'body' })];
  assert.equal(lb.positionalCss(chain), '#x1');
  assert.equal(lb.xpathFor(chain), '//*[@id="x1"]');
  // Without any anchor the path is absolute from the root.
  assert.equal(lb.xpathFor([node({ tag: 'a' }), node({ tag: 'body' }), node({ tag: 'html' })]), '/html/body/a');
});

test('xpath is omitted when the element lives in a shadow root (XPath cannot pierce it)', () => {
  const xp = lb.xpathFor([node({ tag: 'button', crossesShadow: true }), node({ tag: 'x-card' }), node({ tag: 'body' })]);
  assert.equal(xp, null);
});

test('pickBest only accepts locators that matched exactly one element and reports ambiguity', () => {
  const ev = (o) => ({ label: 'x', stability: 'high', relation: 'same', ...o });
  const best = lb.pickBest([
    ev({ strategy: 'role', role: 'button', name: 'Open', matches: 2, priority: 3 }),
    ev({ strategy: 'css', selector: 'button.row', matches: 2, priority: 4 }),
    ev({ strategy: 'css', selector: 'table > tr:nth-of-type(2) button', matches: 1, stability: 'low', priority: 4 }),
    ev({ strategy: 'xpath', selector: '//tr[2]/td/button', matches: 1, stability: 'low', priority: 6 }),
  ]);
  assert.equal(best.unique, true);
  assert.equal(best.primary.strategy, 'css');
  assert.match(best.primary.selector, /nth-of-type/);
  assert.ok(best.primary.fallbacks.some((f) => f.strategy === 'xpath'));
  assert.ok(best.warnings.some((w) => /position-based/.test(w)));
  assert.ok(best.warnings.some((w) => /matched several/.test(w)));

  const none = lb.pickBest([ev({ strategy: 'css', selector: 'a', matches: 3, priority: 4 })]);
  assert.equal(none.primary, null);
  assert.equal(none.ambiguous, true);
  assert.match(none.message, /more specific/);

  const wrongElement = lb.pickBest([ev({ strategy: 'css', selector: 'div', matches: 1, relation: 'other', priority: 4 })]);
  assert.equal(wrongElement.primary, null, 'a unique match of a different element is not usable');
});

test('stored specs are stripped of evaluation-only fields', () => {
  const spec = lb.toStoredSpec({ strategy: 'css', selector: 'a', label: 'x', priority: 4, matches: 1, unique: true, relation: 'same', frames: ['#f'], tag: 'a' }, { description: 'd' });
  assert.deepEqual(spec, { strategy: 'css', selector: 'a', frames: ['#f'], tag: 'a', description: 'd' });
});

test('validateLocatorSpec accepts good specs and rejects dangerous or malformed ones', () => {
  assert.deepEqual(lb.validateLocatorSpec({ strategy: 'id', selector: '#a' }), []);
  assert.deepEqual(lb.validateLocatorSpec({ strategy: 'role', role: 'link', name: 'Problems', fallbacks: [{ strategy: 'css', selector: 'a' }] }), []);
  const bad = [
    null, 'a', [], {}, { strategy: 'nope' },
    { strategy: 'css' }, { strategy: 'css', selector: '' },
    { strategy: 'css', selector: 'a >> internal:text="x"' },
    { strategy: 'css', selector: 'js=alert(1)' },
    { strategy: 'role', role: 'Link!' }, { strategy: 'role' },
    { strategy: 'text', text: '' }, { strategy: 'text', text: 'x'.repeat(300) },
    { strategy: 'css', selector: 'a', index: -1 }, { strategy: 'css', selector: 'a', index: 1.5 },
    { strategy: 'css', selector: 'a', frames: 'x' }, { strategy: 'css', selector: 'a', frames: ['internal:frame'] },
    { strategy: 'css', selector: 'x'.repeat(1200) },
    { strategy: 'css', selector: 'a', fallbacks: [{ strategy: 'css', selector: 'b', fallbacks: [] }] },
  ];
  for (const spec of bad) assert.ok(lb.validateLocatorSpec(spec).length > 0, JSON.stringify(spec));
});

test('normalizeLocatorSpec drops unknown keys; specChain lists primary then fallbacks', () => {
  const norm = lb.normalizeLocatorSpec({ strategy: 'css', selector: 'a', evil: 'x', fallbacks: [{ strategy: 'id', selector: '#a', junk: 1 }] });
  assert.deepEqual(norm, { strategy: 'css', selector: 'a', fallbacks: [{ strategy: 'id', selector: '#a' }] });
  assert.deepEqual(lb.specChain(norm).map((s) => s.strategy), ['css', 'id']);
  assert.deepEqual(lb.specChain(null), []);
});

test('describeSpec produces readable text', () => {
  assert.equal(lb.describeSpec({ strategy: 'role', role: 'link', name: 'Problems' }), 'role link named "Problems"');
  assert.equal(lb.describeSpec({ strategy: 'css', selector: '#a', frames: ['#f'], index: 2 }), 'css #a [#2] in frame #f');
  assert.equal(lb.describeSpec(null), '(no target)');
});

test('safety: destructive controls are flagged, ordinary navigation is not', () => {
  const flagged = [
    info({ tag: 'button', name: 'Delete all reports', text: 'Delete all reports' }),
    info({ tag: 'button', text: 'Remove user' }),
    info({ tag: 'button', text: 'Pay now' }),
    info({ tag: 'button', attributes: { 'aria-label': 'Log out' } }),
    info({ tag: 'a', text: 'Sign out' }),
    info({ tag: 'a', text: 'Click here', hrefPath: '/account/logout' }),
    info({ tag: 'a', text: 'x', hrefPath: '/items/42/delete' }),
    info({ tag: 'button', text: 'OK', id: 'btn-delete-user' }),
    info({ tag: 'button', text: 'Close account' }),
    info({ tag: 'button', attributes: { type: 'submit' }, inForm: true, text: 'Go' }),
    info({ tag: 'input', inputType: 'submit', inForm: true }),
  ];
  for (const el of flagged) assert.equal(assessElement(el).destructive, true, JSON.stringify(el));

  const safe = [
    info({ tag: 'a', text: 'Problems', role: 'link', hrefPath: '/ui/problems' }),
    info({ tag: 'a', text: 'checkout-service', role: 'link', hrefPath: '/services/checkout' }),
    info({ tag: 'a', text: 'payments-service', role: 'link', hrefPath: '/services/payments' }),
    info({ tag: 'a', text: 'Submit feedback', role: 'link', hrefPath: '/feedback' }),
    info({ tag: 'button', text: 'Open' }),
    info({ tag: 'button', text: 'Refresh', attributes: { type: 'button' }, inForm: false }),
    info({ tag: 'div', text: 'A long paragraph '.repeat(20) + 'mentions delete somewhere' }),
    info({ tag: 'button', text: 'Cancel' }),
  ];
  for (const el of safe) assert.equal(assessElement(el).destructive, false, JSON.stringify(el));
  assert.equal(assessElement(null).destructive, false);
});
