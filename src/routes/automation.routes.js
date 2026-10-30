'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { validateBody } = require('../middleware/validation.middleware');
const { bodies } = require('../schemas');

module.exports = function automationRoutes({ services }) {
  const router = express.Router();
  const { automation } = services;

  router.post('/start', validateBody(bodies.automationStart), async (req, res) => sendOk(res, await automation.start(req.body), 202));
  router.post('/pause', validateBody(bodies.empty), async (_req, res) => sendOk(res, automation.pause()));
  router.post('/resume', validateBody(bodies.empty), async (_req, res) => sendOk(res, automation.resume()));
  router.post('/stop', validateBody(bodies.empty), async (_req, res) => sendOk(res, await automation.stop()));
  router.post('/restart', validateBody(bodies.automationRestart), async (req, res) => sendOk(res, await automation.restart(req.body), 202));
  router.post('/execute-step', validateBody(bodies.empty), async (_req, res) => sendOk(res, await automation.executeStep(), 202));
  router.post('/skip-step', validateBody(bodies.empty), async (_req, res) => sendOk(res, automation.skipStep()));
  router.post('/test-step', validateBody(bodies.testStep), async (req, res) => sendOk(res, await automation.testStep(req.body)));
  router.get('/status', (_req, res) => sendOk(res, automation.status()));

  return router;
};
