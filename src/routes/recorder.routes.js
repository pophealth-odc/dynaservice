'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { validateBody } = require('../middleware/validation.middleware');
const { bodies } = require('../schemas');

module.exports = function recorderRoutes({ services }) {
  const router = express.Router();
  const { recorder, remote } = services;

  router.post('/start', validateBody(bodies.empty), async (_req, res) => sendOk(res, await recorder.start()));
  router.post('/stop', validateBody(bodies.empty), async (_req, res) => sendOk(res, await recorder.stop()));
  router.get('/status', async (_req, res) => sendOk(res, recorder.status()));

  router.get('/selected-element', async (_req, res) => {
    const selection = recorder.getSelection();
    sendOk(res, { hasSelection: Boolean(selection), selection });
  });

  // Select the element at a viewport coordinate (same effect as clicking while recording).
  router.post('/select-element', validateBody(bodies.selectElement), async (req, res) => {
    sendOk(res, { selection: await remote.selectElement(req.body) });
  });

  router.post('/clear-selection', validateBody(bodies.empty), async (_req, res) => sendOk(res, await recorder.clearSelection()));

  // Validate a locator against the live page (how many elements match).
  router.post('/check-locator', validateBody(bodies.checkLocator), async (req, res) => {
    sendOk(res, await recorder.checkLocator(req.body.locator));
  });

  return router;
};
