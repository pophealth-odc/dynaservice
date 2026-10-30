'use strict';

const express = require('express');
const { validateQuery } = require('../middleware/validation.middleware');

const querySchema = { type: 'object', additionalProperties: false, properties: {} };

module.exports = function eventRoutes({ services }) {
  const router = express.Router();
  const { events } = services;

  /**
   * Server-Sent Events. Browsers' built-in EventSource cannot send an Authorization header, and the token
   * must never travel in the URL, so clients read this stream with fetch() and a streaming body.
   * Reconnect with the "Last-Event-ID" header set to the last seen event id to replay missed events;
   * the first frame ("service.connected") always carries a status snapshot to resynchronise from.
   */
  router.get('/', validateQuery(querySchema), (req, res) => {
    events.addClient(req, res, { lastEventId: req.get('last-event-id') || undefined });
  });

  return router;
};
