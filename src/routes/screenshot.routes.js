'use strict';

const express = require('express');
const { sendOk } = require('../utils/http');
const { validateBody, validateQuery } = require('../middleware/validation.middleware');
const { bodies, queries } = require('../schemas');
const { UUID_RE } = require('../utils/file-utils');
const { err } = require('../errors');

module.exports = function screenshotRoutes({ services }) {
  const router = express.Router();
  const { screenshots } = services;

  router.get('/', validateQuery(queries.screenshotList), async (req, res) => {
    sendOk(res, await screenshots.list(req.validatedQuery));
  });

  // Capture the current page into temporary storage (the standalone tester and the dashboard use this).
  router.post('/', validateBody(bodies.screenshotCapture), async (req, res) => {
    const { label, format, fullPage } = req.body;
    sendOk(res, { screenshot: await screenshots.capture({ label, format, fullPage }) }, 201);
  });

  // "/export" must be registered before "/:id".
  router.get('/export', validateQuery(queries.screenshotExport), async (req, res) => {
    const raw = req.validatedQuery.ids;
    const ids = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    await screenshots.exportZip(ids, res);
  });

  router.post('/export', validateBody(bodies.screenshotExport), async (req, res) => {
    await screenshots.exportZip(req.body.ids, res);
  });

  router.delete('/', validateQuery(queries.screenshotDeleteAll), async (req, res) => {
    sendOk(res, await screenshots.deleteAll(req.validatedQuery));
  });

  router.get('/:id/download', async (req, res) => {
    await screenshots.sendFile(req.params.id, req, res, { inline: false });
  });

  // Metadata by default; `?view=image` returns the image inline (for previews).
  router.get('/:id', validateQuery(queries.screenshotGet), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw err.badRequest('invalid_id', 'Screenshot id must be a UUID.');
    if (req.validatedQuery.view === 'image') return screenshots.sendFile(req.params.id, req, res, { inline: true });
    const { meta } = await screenshots.get(req.params.id);
    return sendOk(res, { screenshot: meta });
  });

  router.delete('/:id', async (req, res) => sendOk(res, await screenshots.delete(req.params.id)));

  return router;
};
