'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { getMemoryInfo } = require('../utils/memory');

module.exports = function statusRoutes({ env, services, auth }) {
  const router = express.Router();
  const { events, browser, automation, login, recorder, screenshots, storage } = services;

  /**
   * Health / status. Unauthenticated callers (Render's health check, uptime pings, a dashboard that has not
   * been given a token yet) get only liveness facts. The full picture needs the bearer token.
   */
  router.get('/', auth.optional, async (req, res) => {
    const base = {
      status: 'ok',
      service: env.name,
      version: env.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: events.startedAt,
      restartId: events.restartId,
    };
    if (!req.authenticated) {
      return sendOk(res, { ...base, authenticated: false, detail: 'Send "Authorization: Bearer <token>" for the full status.' });
    }

    const browserStatus = await browser.status();
    const run = automation.run;
    return sendOk(res, {
      ...base,
      authenticated: true,
      nodeVersion: process.version,
      environment: env.nodeEnv,
      render: env.render,
      browser: {
        available: browserStatus.available,
        running: browserStatus.connected,
        state: browserStatus.state,
        connectionStatus: browserStatus.connected ? 'connected' : browserStatus.closedReason ? `disconnected (${browserStatus.closedReason})` : 'not started',
        pageState: browserStatus.pageState,
        headless: browserStatus.headless,
      },
      fixtureUrl: services.fixture.baseUrl(),
      currentUrl: browserStatus.url,
      currentWorkflow: run ? { id: run.workflowId, name: run.workflowName, runId: run.id } : null,
      currentWorkflowStatus: automation.status().state,
      memory: getMemoryInfo(),
      sessionId: browserStatus.sessionId,
      login: { state: login.state, eligibleForAutomation: login.isConfirmed },
      recorder: { active: recorder.isActive() },
      screenshots: screenshots.stats(),
      storage: await storage.describe(),
      events: events.stats(),
      previousRun: automation.interruptedRun,
      warnings: env.warnings,
    });
  });

  return router;
};
