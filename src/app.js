'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const { err } = require('./errors');
const { createAuth, createAuthFailureLimiter } = require('./middleware/auth.middleware');
const { createCors } = require('./middleware/cors.middleware');
const { requestId, requestLogger, notFound, errorHandler } = require('./middleware/error.middleware');
const { buildOpenApi } = require('./openapi');

const statusRoutes = require('./routes/status.routes');
const browserRoutes = require('./routes/browser.routes');
const loginRoutes = require('./routes/login.routes');
const recorderRoutes = require('./routes/recorder.routes');
const workflowRoutes = require('./routes/workflow.routes');
const automationRoutes = require('./routes/automation.routes');
const screenshotRoutes = require('./routes/screenshot.routes');
const settingsRoutes = require('./routes/settings.routes');
const eventRoutes = require('./routes/event.routes');
const testRoutes = require('./routes/test.routes');

const API_CSP = {
  'default-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};
const TEST_CSP = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'blob:', 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};
// The demo site is rendered inside the cloud browser. It embeds one same-origin iframe and its custom element
// injects a <style> into a shadow root, which needs inline styles.
const FIXTURE_CSP = {
  ...TEST_CSP,
  'style-src': ["'self'", "'unsafe-inline'"],
  'frame-ancestors': ["'self'"],
  'frame-src': ["'self'"],
};
const DOCS_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
};

const cspHeader = (directives) =>
  Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');

const withCsp = (directives) => {
  const value = cspHeader(directives);
  return (_req, res, next) => {
    res.set('Content-Security-Policy', value);
    next();
  };
};

/** Build the Express application from a container created by createContainer(). */
function createApp(container) {
  const { env, services, security } = container;
  const app = express();
  const auth = createAuth(security);

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy); // Render terminates TLS in front of the container
  app.set('etag', 'strong');

  app.use(requestId);
  app.use(requestLogger);
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: API_CSP },
      strictTransportSecurity: env.isProduction ? { maxAge: 15552000 } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // -- public, static, credential-free ----------------------------------------------------------
  const openapi = buildOpenApi(env);
  const docsMiddleware = [withCsp(DOCS_CSP)];
  app.get('/api/docs/openapi.json', ...docsMiddleware, (_req, res) => res.set('Cache-Control', 'no-cache').json(openapi));
  app.use(
    '/api/docs',
    ...docsMiddleware,
    swaggerUi.serve,
    swaggerUi.setup(null, {
      customSiteTitle: 'Cloud Screenshot Service API',
      swaggerOptions: { url: '/api/docs/openapi.json', persistAuthorization: false, displayRequestDuration: true, tryItOutEnabled: true },
    }),
  );
  // One middleware picks the policy by path; two stacked ones would let the later header overwrite the earlier.
  const fixtureCsp = withCsp(FIXTURE_CSP);
  const consoleCsp = withCsp(TEST_CSP);
  app.use('/api/test', (req, res, next) => (req.path.startsWith('/fixture') ? fixtureCsp : consoleCsp)(req, res, next), testRoutes());

  // -- API --------------------------------------------------------------------------------------
  const api = express.Router();
  // API responses can contain screenshots, URLs and workflow data: never let a proxy or browser cache them.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(createCors(security));
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: env.rateLimitPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path === '/status' && !req.get('authorization'),
      handler: (_req, _res, next) => next(err.tooMany('rate_limited', 'Too many requests. Slow down and retry shortly.')),
    }),
  );
  api.use(express.json({ limit: '600kb', strict: true, type: ['application/json', 'application/*+json'] }));

  // /status answers without a token (liveness only); everything else requires one.
  api.use('/status', statusRoutes({ env, services, auth }));

  const protectedRouter = express.Router();
  protectedRouter.use(createAuthFailureLimiter());
  protectedRouter.use(auth.authenticate);
  protectedRouter.use('/browser', browserRoutes({ env, services }));
  protectedRouter.use('/login', loginRoutes({ env, services }));
  protectedRouter.use('/recorder', recorderRoutes({ env, services }));
  protectedRouter.use('/workflows', workflowRoutes({ env, services }));
  protectedRouter.use('/automation', automationRoutes({ env, services }));
  protectedRouter.use('/screenshots', screenshotRoutes({ env, services }));
  protectedRouter.use('/settings', settingsRoutes({ env, services }));
  protectedRouter.use('/events', eventRoutes({ env, services }));
  api.use(protectedRouter);

  app.use('/api', api);

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      data: {
        service: env.name,
        version: env.version,
        endpoints: { status: '/api/status', docs: '/api/docs', testConsole: '/api/test' },
      },
    });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
