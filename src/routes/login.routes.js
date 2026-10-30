'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { validateBody } = require('../middleware/validation.middleware');
const { bodies } = require('../schemas');

module.exports = function loginRoutes({ services }) {
  const router = express.Router();
  const { login } = services;

  // Launches Chromium if needed and opens the configured (or supplied) login URL. No credentials are accepted here.
  router.post('/open', validateBody(bodies.loginOpen), async (req, res) => sendOk(res, await login.open({ url: req.body.url })));

  // "I'm Logged In — Continue Automation": records the user's acknowledgement.
  router.post('/confirm', validateBody(bodies.empty), async (_req, res) => sendOk(res, await login.confirm()));

  router.post('/cancel', validateBody(bodies.empty), async (_req, res) => sendOk(res, login.cancel()));

  router.get('/status', async (_req, res) => sendOk(res, login.status()));

  return router;
};
