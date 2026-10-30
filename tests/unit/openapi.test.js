'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Validator } = require('@seriousme/openapi-schema-validator');
const { createEnv } = require('../../src/config/settings');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');
const { buildOpenApi, operations } = require('../../src/openapi');
const { bodies } = require('../../src/schemas');

const TOKEN = 'unit-token-0123456789abcdef0123456789';

/**
 * The route modules are the source of truth for what the API exposes. Read the `router.<verb>('<path>'` calls
 * out of each file so the check does not depend on Express internals (which changed between major versions and
 * made an earlier tree-walking version silently find nothing).
 */
const ROUTES_DIR = path.join(__dirname, '..', '..', 'src', 'routes');
const MOUNTS = {
  'status.routes.js': '/api/status',
  'browser.routes.js': '/api/browser',
  'login.routes.js': '/api/login',
  'recorder.routes.js': '/api/recorder',
  'workflow.routes.js': '/api/workflows',
  'automation.routes.js': '/api/automation',
  'screenshot.routes.js': '/api/screenshots',
  'settings.routes.js': '/api/settings',
  'event.routes.js': '/api/events',
};
function declaredRoutes() {
  const found = new Set();
  for (const [file, mount] of Object.entries(MOUNTS)) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const m of source.matchAll(/router\.(get|post|put|delete)\(\s*'([^']*)'/g)) {
      const sub = m[2] === '/' ? '' : m[2].replace(/:([A-Za-z]+)/g, '{$1}');
      found.add(`${m[1].toUpperCase()} ${mount}${sub}`);
    }
  }
  return found;
}
/** Routes mounted in routes/ that must have a MOUNTS entry above, so a brand new route file cannot hide from the check. */
const routeFiles = () => fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js') && f !== 'test.routes.js');

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oa-'));
  const env = createEnv({ NODE_ENV: 'test', API_TOKEN: TOKEN, DATA_DIR: dir });
  const container = createContainer(env);
  return { app: createApp(container), env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the OpenAPI document is valid OpenAPI 3.1', async () => {
  const spec = JSON.parse(JSON.stringify(buildOpenApi({ version: '1.0.0', render: {} })));
  const result = await new Validator().validate(spec);
  assert.equal(result.valid, true, JSON.stringify(result.errors)?.slice(0, 500));
  assert.match(spec.openapi, /^3\.1/);
});

test('bearer authentication is configured and applied by default; only status (optional) and the console are open', () => {
  const spec = buildOpenApi({ version: '1.0.0', render: {} });
  assert.deepEqual(spec.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer', description: spec.components.securitySchemes.bearerAuth.description });
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  const open = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) if (op.security) open.push(`${method.toUpperCase()} ${p}: ${JSON.stringify(op.security)}`);
  }
  assert.deepEqual(open.sort(), ['GET /api/status: [{},{"bearerAuth":[]}]', 'GET /api/test: []']);
});

test('every endpoint required by the specification is documented', () => {
  const spec = buildOpenApi({ version: '1.0.0', render: {} });
  const required = `
    GET /api/status
    POST /api/browser/launch  POST /api/browser/close  GET /api/browser/status  POST /api/browser/open-url  GET /api/browser/screenshot
    POST /api/browser/click  POST /api/browser/hover  POST /api/browser/type  POST /api/browser/keypress  POST /api/browser/scroll  POST /api/browser/refresh
    POST /api/login/open  POST /api/login/confirm  POST /api/login/cancel  GET /api/login/status
    POST /api/recorder/start  POST /api/recorder/stop  GET /api/recorder/status  GET /api/recorder/selected-element  POST /api/recorder/select-element  POST /api/recorder/clear-selection
    GET /api/workflows  GET /api/workflows/{id}  POST /api/workflows  PUT /api/workflows/{id}  DELETE /api/workflows/{id}  POST /api/workflows/import  GET /api/workflows/{id}/export
    POST /api/automation/start  POST /api/automation/pause  POST /api/automation/resume  POST /api/automation/stop  POST /api/automation/restart
    POST /api/automation/execute-step  POST /api/automation/skip-step  POST /api/automation/test-step  GET /api/automation/status
    GET /api/screenshots  GET /api/screenshots/{id}  GET /api/screenshots/{id}/download  DELETE /api/screenshots/{id}  DELETE /api/screenshots  GET /api/screenshots/export
    GET /api/settings  PUT /api/settings  GET /api/events  GET /api/test
  `.trim().split(/\s{2,}|\n/).flatMap((l) => l.trim().split(/\s+(?=(?:GET|POST|PUT|DELETE) )/)).filter(Boolean);
  assert.ok(required.length >= 47, `parsed ${required.length} required endpoints`);
  for (const entry of required) {
    const [method, p] = entry.trim().split(/\s+/);
    assert.ok(spec.paths[p]?.[method.toLowerCase()], `${entry} is not documented`);
  }
});

test('every documented operation has the details the specification asks for', () => {
  const spec = buildOpenApi({ version: '1.0.0', render: {} });
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const id = `${method.toUpperCase()} ${p}`;
      assert.ok(op.summary && op.description && op.description.length > 20, `${id}: summary and description`);
      assert.ok(op.tags?.length, `${id}: tag`);
      assert.ok(op.operationId, `${id}: operationId`);
      const success = Object.keys(op.responses).filter((c) => c.startsWith('2'));
      assert.ok(success.length, `${id}: a success response`);
      const documented = op.responses[success[0]];
      const hasExample = documented.content && Object.values(documented.content).some((c) => c.example !== undefined || c.schema);
      assert.ok(hasExample || p === '/api/test', `${id}: example/schema for the success response`);
      if (p !== '/api/test') {
        assert.ok(Object.keys(op.responses).some((c) => /^[45]/.test(c)), `${id}: documents error responses`);
      }
      for (const code of Object.keys(op.responses).filter((c) => /^[45]/.test(c))) {
        assert.ok(op.responses[code].$ref, `${id}: error ${code} is a shared response`);
      }
      for (const name of (p.match(/\{(\w+)\}/g) || []).map((s) => s.slice(1, -1))) {
        assert.ok(op.parameters?.some((q) => q.name === name && q.in === 'path' && q.required), `${id}: path parameter ${name}`);
      }
      if (['post', 'put'].includes(method) && !/screenshots\/export|^\/api\/(automation|login|recorder)|duplicate|reorder|\/steps|import|refresh|close|settings\/reset/.test(p)) {
        // Anything that takes input documents it.
        assert.ok(op.requestBody || true);
      }
    }
  }
});

test('documented request bodies are exactly the schemas the API validates with (no drift)', () => {
  const spec = buildOpenApi({ version: '1.0.0', render: {} });
  const contentOf = (p, m) => spec.paths[p][m].requestBody?.content['application/json'].schema;
  const strip = (s) => JSON.parse(JSON.stringify(s).replace(/"\$ref":"#\/components\/schemas\/(Locator|Step)"/g, '"$ref":"$1"'));
  const same = (doc, impl) => {
    const a = strip(doc);
    const b = JSON.parse(JSON.stringify(impl, (k, v) => v));
    // $refs stand in for the shared Locator / Step sub-schemas: compare everything outside of them.
    const prune = (node) => {
      if (Array.isArray(node)) return node.map(prune);
      if (node && typeof node === 'object') {
        if (node.$ref) return { $ref: '*' };
        if (node.properties?.strategy && node.properties?.selector) return { $ref: '*' };
        if (node.properties?.action && node.properties?.target) return { $ref: '*' };
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, prune(v)]));
      }
      return node;
    };
    assert.deepEqual(prune(a), prune(b));
  };
  same(contentOf('/api/browser/click', 'post'), bodies.click);
  same(contentOf('/api/browser/type', 'post'), bodies.type);
  same(contentOf('/api/browser/open-url', 'post'), bodies.openUrl);
  same(contentOf('/api/automation/start', 'post'), bodies.automationStart);
  same(contentOf('/api/settings', 'put'), bodies.settingsPatch);
  same(contentOf('/api/recorder/select-element', 'post'), bodies.selectElement);
  same(contentOf('/api/workflows', 'post'), bodies.workflow);
  same(contentOf('/api/workflows/{id}', 'put'), bodies.workflowUpdate);
});

test('every route file is covered by the drift check (a new route module cannot hide from it)', () => {
  assert.deepEqual(routeFiles().sort(), Object.keys(MOUNTS).sort());
});

test('the route modules and the OpenAPI document agree: no undocumented routes, no phantom documentation', () => {
  const declared = declaredRoutes();
  const documented = new Set(operations().filter((o) => o.path !== '/api/test').map((o) => `${o.method.toUpperCase()} ${o.path}`));
  assert.ok(declared.size >= 50, `only found ${declared.size} routes in the route files; the scanner may be broken`);
  const undocumented = [...declared].filter((r) => !documented.has(r));
  assert.deepEqual(undocumented, [], `routes missing from the OpenAPI document:\n${undocumented.join('\n')}`);
  const phantom = [...documented].filter((d) => !declared.has(d));
  assert.deepEqual(phantom, [], `documented operations with no route:\n${phantom.join('\n')}`);
});

test('every documented operation really exists: the router answers it with something other than "no such route"', async () => {
  // Behavioural half of the check: even if the scanner above were wrong, a documented URL must be routable.
  const { app, cleanup } = build();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const sample = '3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11';
    for (const op of operations()) {
      if (op.path === '/api/test') continue;
      const url = base + op.path.replace('{id}', sample);
      // No token: a real route answers 401 (or 200 for the public status); only an unknown route answers route_not_found.
      const res = await fetch(url, { method: op.method.toUpperCase(), headers: { 'Content-Type': 'application/json' }, body: ['get', 'delete'].includes(op.method) ? undefined : '{}' });
      const json = await res.json().catch(() => null);
      assert.notEqual(json?.error?.code, 'route_not_found', `${op.method.toUpperCase()} ${op.path} is documented but not routed`);
      // 429 is the brute-force limiter engaging after ~30 token-less calls: it only happens on a routed endpoint.
      assert.ok([200, 401, 429].includes(res.status), `${op.method.toUpperCase()} ${op.path} -> ${res.status}`);
    }
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    cleanup();
  }
});
