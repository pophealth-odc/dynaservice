'use strict';

const logger = require('./utils/logger');
const { SettingsStore } = require('./config/settings');
const { createSecurity } = require('./config/security');
const { EventService } = require('./services/event.service');
const { StorageService } = require('./services/storage.service');
const { BrowserService } = require('./services/browser.service');
const { ScreenshotService } = require('./services/screenshot.service');
const { WorkflowService } = require('./services/workflow.service');
const { LoginService } = require('./services/login.service');
const { RecorderService } = require('./services/recorder.service');
const { RemoteBrowserService } = require('./services/remote-browser.service');
const { AutomationService } = require('./services/automation.service');
const { createFixturePolicy } = require('./services/fixture.service');
const { NavigationRunner } = require('./automation/navigation-runner');

/**
 * Builds every service and wires them together. Nothing here touches the disk or starts a browser:
 * call `init()` for that. `overrides` lets tests inject a fake browser launcher or memory probe.
 */
function createContainer(env, overrides = {}) {
  logger.setLevel(env.logLevel);
  const events = new EventService(env, overrides.events);
  const storage = new StorageService(env, { restartId: events.restartId });
  const settings = new SettingsStore(env);
  const fixture = createFixturePolicy(env);
  settings.urlException = (href) => fixture.isFixtureUrl(href);
  const browser = new BrowserService({ env, settings, events, fixture, ...overrides.browser });
  const screenshots = new ScreenshotService({ env, browser, events, settings });
  const workflows = new WorkflowService({ env });
  const login = new LoginService({ browser, events, settings });
  const recorder = new RecorderService({ browser, events });
  const remote = new RemoteBrowserService({ browser, events, settings, recorder });
  const runner = new NavigationRunner({ browser, screenshots, settings, events, loginService: login });
  const automation = new AutomationService({ browser, login, recorder, remote, workflows, runner, storage, events, screenshots });
  const security = createSecurity(env);

  // A client that (re)connects gets everything it needs to redraw its UI without any other request.
  events.setSnapshotProvider(() => ({
    browser: { state: browser.state, running: browser.isReady, sessionId: browser.sessionId, url: browser.currentUrl() },
    login: login.status(),
    recorder: recorder.status(),
    automation: automation.status(),
    screenshots: screenshots.stats(),
    restart: {
      restartId: events.restartId,
      previousInstanceDetected: storage.previous.detected,
      interruptedRun: automation.interruptedRun,
    },
  }));

  const services = { events, storage, settings, fixture, browser, screenshots, workflows, login, recorder, remote, runner, automation };

  return {
    env,
    security,
    services,
    /** Create directories, restore settings / workflows / screenshots left by an earlier process. */
    async init() {
      await storage.init();
      await settings.load();
      await workflows.init();
      await screenshots.init();
      automation.init(); // needs storage.init() to have run: it reads what the previous process left behind
      return services;
    },
    /** Stop automation, close SSE streams and the browser. Safe to call more than once. */
    async shutdown() {
      await automation.shutdown().catch(() => {});
      events.closeAll();
      await recorder.stop().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

module.exports = { createContainer };
