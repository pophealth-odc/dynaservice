'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LoginService } = require('../../src/services/login.service');

/** Browser double: just enough surface for the login state machine. */
function fakeBrowser() {
  const b = new EventEmitter();
  b.isReady = false;
  b.sessionId = null;
  b.opened = [];
  b.launch = async () => { b.isReady = true; b.sessionId = `s${b.opened.length + 1}`; };
  b.checkUrl = (u) => u;
  b.navigate = async (u) => { b.opened.push(u); };
  b.currentUrl = () => b.opened.at(-1) || null;
  b.lose = (reason = 'disconnected') => { b.isReady = false; b.sessionId = null; b.emit('session-lost', { reason }); };
  return b;
}
function setup() {
  const browser = fakeBrowser();
  const events = [];
  const emitter = { emitEvent: (type, description, extra) => events.push({ type, description, ...extra }) };
  const settings = { get: () => ({ defaultLoginUrl: 'https://login.example/' }) };
  return { browser, events, login: new LoginService({ browser, events: emitter, settings }) };
}

test('starts idle and cannot be confirmed before the login page is opened', async () => {
  const { login } = setup();
  assert.equal(login.status().state, 'idle');
  assert.equal(login.status().eligibleForAutomation, false);
  await assert.rejects(login.confirm(), (e) => e.code === 'login_not_started');
  assert.throws(() => login.assertEligible(), (e) => e.code === 'browser_not_running');
});

test('open launches the browser, navigates to the default URL and waits for the user', async () => {
  const { login, browser, events } = setup();
  const s = await login.open();
  assert.equal(s.state, 'waiting_for_login');
  assert.deepEqual(browser.opened, ['https://login.example/']);
  assert.equal(s.eligibleForAutomation, false, 'not eligible before the user confirms');
  assert.deepEqual(events.map((e) => e.type), ['login.page_opened', 'login.waiting']);
  assert.throws(() => login.assertEligible(), (e) => e.code === 'login_not_confirmed');
});

test('a custom login URL is used when supplied', async () => {
  const { login, browser } = setup();
  await login.open({ url: 'https://other.example/signin' });
  assert.equal(browser.opened[0], 'https://other.example/signin');
});

test('confirm records the user acknowledgement and makes automation eligible', async () => {
  const { login, events } = setup();
  await login.open();
  const s = await login.confirm();
  assert.equal(s.state, 'confirmed');
  assert.equal(s.confirmed, true);
  assert.equal(s.eligibleForAutomation, true);
  assert.ok(s.confirmedAt);
  assert.match(s.note, /acknowledgement/);
  assert.equal(events.at(-1).type, 'login.confirmed');
  assert.doesNotThrow(() => login.assertEligible());
});

test('the status object never contains credential-like fields', async () => {
  const { login } = setup();
  await login.open();
  await login.confirm();
  const keys = JSON.stringify(Object.keys(login.status())).toLowerCase();
  for (const word of ['password', 'cookie', 'token', 'secret', 'otp', 'mfa']) assert.ok(!keys.includes(word), word);
});

test('cancel returns to a state where confirming is refused', async () => {
  const { login, events } = setup();
  await login.open();
  login.cancel();
  assert.equal(login.status().state, 'cancelled');
  assert.equal(events.at(-1).type, 'login.cancelled');
  await assert.rejects(login.confirm(), (e) => e.code === 'login_cancelled');
  assert.equal(login.cancel().state, 'cancelled', 'cancel is idempotent');
});

test('losing the browser after confirmation invalidates it and emits session.expired', async () => {
  const { login, browser, events } = setup();
  await login.open();
  await login.confirm();
  browser.lose('disconnected');
  assert.equal(login.status().state, 'lost');
  assert.equal(login.status().eligibleForAutomation, false);
  assert.equal(events.at(-1).type, 'session.expired');
  assert.throws(() => login.assertEligible(), (e) => e.code === 'browser_not_running');
});

test('a relaunched browser does not inherit an old confirmation', async () => {
  const { login, browser } = setup();
  await login.open();
  await login.confirm();
  browser.lose();
  await browser.launch(); // the service restarted the browser on its own
  assert.equal(login.isConfirmed, false);
  assert.throws(() => login.assertEligible(), (e) => e.code === 'session_lost');
  await login.open();
  assert.equal(login.status().state, 'waiting_for_login', 'a fresh login is required');
});

test('markExpired pauses eligibility until the user confirms again', async () => {
  const { login, events } = setup();
  await login.open();
  await login.confirm();
  assert.equal(login.markExpired('login_page_detected'), true);
  assert.equal(login.status().state, 'expired');
  assert.throws(() => login.assertEligible(), (e) => e.code === 'session_expired');
  assert.equal(events.at(-1).type, 'session.expired');
  assert.equal(login.markExpired(), false, 'only a confirmed login can expire');
  const s = await login.confirm();
  assert.equal(s.eligibleForAutomation, true);
});

test('confirm after the browser vanished is refused with a clear error', async () => {
  const { login, browser } = setup();
  await login.open();
  browser.isReady = false; // service restarted: no browser at all
  await assert.rejects(login.confirm(), (e) => e.code === 'browser_not_running');
  assert.equal(login.status().state, 'lost');
});

test('the busy guard blocks opening the login page while automation drives the browser', async () => {
  const { login } = setup();
  login.guard = () => { const e = new Error('busy'); e.code = 'automation_running'; throw e; };
  await assert.rejects(login.open(), (e) => e.code === 'automation_running');
});
