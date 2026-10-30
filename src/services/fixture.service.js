'use strict';

const FIXTURE_PREFIX = '/api/test/fixture/';

/**
 * The built-in fixture site (see src/testing/fixture) lets the standalone test page exercise login,
 * the recorder, workflows and screenshots end to end without any external website.
 *
 * The cloud browser refuses loopback addresses (SSRF protection), so this policy carves out exactly one
 * exception: this service's own 127.0.0.1:<port> under /api/test/fixture/. Nothing else on loopback
 * is reachable, and the fixture contains no secrets and no way to call the authenticated API.
 */
function createFixturePolicy(env) {
  let port = env.port || null;
  return {
    prefix: FIXTURE_PREFIX,
    setPort(value) {
      port = value;
    },
    baseUrl() {
      return port ? `http://127.0.0.1:${port}${FIXTURE_PREFIX}` : null;
    },
    isFixtureUrl(href) {
      if (!port) return false;
      try {
        const url = new URL(href);
        return (
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          Number(url.port) === port &&
          url.pathname.startsWith(FIXTURE_PREFIX) &&
          !url.pathname.includes('..')
        );
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createFixturePolicy, FIXTURE_PREFIX };
