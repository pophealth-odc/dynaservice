'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { validateBody } = require('../middleware/validation.middleware');
const { bodies } = require('../schemas');
const { SETTING_BOUNDS, SETTING_ENUMS } = require('../config/settings');

module.exports = function settingsRoutes({ env, services }) {
  const router = express.Router();
  const { settings, browser } = services;

  const view = () => ({
    settings: settings.get(),
    defaults: { ...env.defaults },
    bounds: SETTING_BOUNDS,
    options: SETTING_ENUMS,
    note: 'Settings are held in memory and may be reset when the service restarts. The environment variables define the defaults.',
    browser: { headlessInUse: browser.headless },
  });

  router.get('/', (_req, res) => sendOk(res, view()));

  router.put('/', validateBody(bodies.settingsPatch), async (req, res) => {
    const result = await settings.update(req.body);
    sendOk(res, {
      ...view(),
      changed: result.changed,
      requiresRelaunch: result.requiresRelaunch && browser.isReady,
    });
  });

  router.post('/reset', validateBody(bodies.empty), async (_req, res) => {
    const result = await settings.reset();
    sendOk(res, { ...view(), changed: result.changed, requiresRelaunch: result.requiresRelaunch && browser.isReady });
  });

  return router;
};
