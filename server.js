'use strict';

const { loadDotEnv, createEnv, ConfigError } = require('./src/config/settings');
const logger = require('./src/utils/logger');

loadDotEnv();

let env;
try {
  env = createEnv(process.env);
} catch (e) {
  // Configuration problems are fatal and must be obvious in the Render log. The message never contains the token.
  console.error(`Configuration error: ${e instanceof ConfigError ? e.message : e.message}`);
  process.exit(1);
}
const { createContainer } = require('./src/container');
const { createApp } = require('./src/app');

async function main() {
  const container = createContainer(env);
  await container.init();
  const app = createApp(container);

  const server = app.listen(env.port, env.host, () => {
    const { port } = server.address();
    container.services.fixture.setPort(port);
    logger.info(`Cloud Screenshot Service ${env.version} listening on ${env.host}:${port}`, {
      environment: env.nodeEnv,
      render: env.render.isRender,
      dashboardOrigins: env.dashboardOrigins.length,
    });
    for (const warning of env.warnings) logger.warn(warning);
    container.services.automation.announceInterrupted();
  });

  // Outlive the 60 s idle timeout of Render's proxy so it never reuses a connection we are closing.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;
  server.requestTimeout = 0; // SSE and ZIP downloads are long-lived

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close();
    server.closeIdleConnections?.();
    await container.shutdown();
    server.closeAllConnections?.();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    container.services.events.emitEvent('service.error', 'The service hit an unexpected error.', { data: { code: 'uncaught_exception' } });
    shutdown('uncaughtException');
  });
}

main().catch((e) => {
  logger.error('Failed to start', { error: e });
  process.exit(1);
});
