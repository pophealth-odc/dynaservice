'use strict';

const path = require('node:path');
const express = require('express');
const { FIXTURE_PREFIX } = require('../services/fixture.service');

const TESTING_DIR = path.join(__dirname, '..', 'testing');
const FIXTURE_DIR = path.join(TESTING_DIR, 'fixture');

/**
 * The standalone test console (GET /api/test) and the demo "fixture" website it uses.
 *
 * Both are static files with no secrets in them. They are served without authentication because a browser
 * page load cannot carry a bearer token; every API call the console makes is authenticated as usual.
 */
module.exports = function testRoutes() {
  const router = express.Router();
  const staticOptions = { dotfiles: 'ignore', index: false, etag: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') };

  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(TESTING_DIR, 'test.html'), { dotfiles: 'ignore' });
  });

  router.get('/test.css', (_req, res) => res.set('Cache-Control', 'no-cache').type('text/css').sendFile(path.join(TESTING_DIR, 'test.css')));
  router.get('/test.js', (_req, res) => res.set('Cache-Control', 'no-cache').type('application/javascript').sendFile(path.join(TESTING_DIR, 'test.js')));

  // Demo website used by the console to exercise login, recording, workflows and screenshots.
  const fixtureMount = FIXTURE_PREFIX.replace('/api/test', '').replace(/\/$/, '');
  router.use(fixtureMount, express.static(FIXTURE_DIR, { ...staticOptions, index: 'index.html' }));
  // Client-side routes of the demo single-page app (history.pushState) resolve to its index page.
  router.get(`${fixtureMount}/*path`, (req, res, next) => {
    const last = req.path.split('/').pop();
    if (last.includes('.')) return next();
    return res.set('Cache-Control', 'no-cache').sendFile(path.join(FIXTURE_DIR, 'index.html'));
  });

  return router;
};
