'use strict';

const express = require('express');
const { sendOk, sendImage } = require('../utils/http');
const { validateBody, validateQuery } = require('../middleware/validation.middleware');
const { bodies, queries } = require('../schemas');

module.exports = function browserRoutes({ services }) {
  const router = express.Router();
  const { browser, remote, recorder } = services;

  router.post('/launch', validateBody(bodies.launch), async (req, res) => {
    sendOk(res, await browser.launch({ headless: req.body.headless }));
  });

  router.post('/close', validateBody(bodies.empty), async (_req, res) => {
    await recorder.stop();
    sendOk(res, await browser.close());
  });

  router.get('/status', async (_req, res) => {
    sendOk(res, await browser.status());
  });

  router.post('/open-url', validateBody(bodies.openUrl), async (req, res) => {
    sendOk(res, await remote.openUrl(req.body.url));
  });

  /**
   * Live view of the remote browser (not stored). Binary image by default; `?encoding=base64` returns JSON.
   * The viewport size is returned in X-Viewport-Width / X-Viewport-Height so a client can map clicks
   * on the displayed image back to browser coordinates.
   */
  router.get('/screenshot', validateQuery(queries.browserScreenshot), async (req, res) => {
    const { format = 'jpeg', quality = 70, encoding = 'binary' } = req.validatedQuery;
    const shot = await remote.screenshot({ format, quality });
    if (encoding === 'base64') {
      return sendOk(res, {
        image: shot.buffer.toString('base64'),
        mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg',
        viewport: shot.viewport,
        url: shot.url,
        title: shot.title,
        recording: recorder.isActive(),
      });
    }
    return sendImage(res, shot);
  });

  router.post('/click', validateBody(bodies.click), async (req, res) => sendOk(res, await remote.click(req.body)));
  router.post('/hover', validateBody(bodies.hover), async (req, res) => sendOk(res, await remote.hover(req.body)));
  router.post('/type', validateBody(bodies.type), async (req, res) => sendOk(res, await remote.type(req.body)));
  router.post('/keypress', validateBody(bodies.keypress), async (req, res) => sendOk(res, await remote.keypress(req.body)));
  router.post('/scroll', validateBody(bodies.scroll), async (req, res) => sendOk(res, await remote.scroll(req.body)));
  router.post('/refresh', validateBody(bodies.empty), async (_req, res) => sendOk(res, await remote.refresh()));

  return router;
};
