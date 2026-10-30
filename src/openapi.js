'use strict';

const { bodies, queries, locator, step } = require('./schemas');

const SCHEMA_REFS = new Map([
  [locator, '#/components/schemas/Locator'],
  [step, '#/components/schemas/Step'],
]);

/** Deep copy of a schema where shared sub-schemas (Locator, Step) become $refs. */
function withRefs(schema, isRoot = true) {
  if (!isRoot && SCHEMA_REFS.has(schema)) return { $ref: SCHEMA_REFS.get(schema) };
  if (Array.isArray(schema)) return schema.map((s) => withRefs(s, false));
  if (schema && typeof schema === 'object') {
    return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, withRefs(v, false)]));
  }
  return schema;
}

const json = (schema, example) => ({ 'application/json': { schema, ...(example !== undefined ? { example } : {}) } });
const envelope = (dataSchema = { type: 'object' }) => ({
  type: 'object',
  required: ['ok', 'data'],
  properties: { ok: { const: true }, data: dataSchema },
});
const ok = (description, example, dataSchema) => ({
  description,
  content: json(envelope(dataSchema), { ok: true, data: example }),
});
const errRef = (code) => ({ $ref: `#/components/responses/${code}` });

const ERROR_DEFS = {
  400: ['Bad request', { code: 'invalid_json', message: 'The request body is not valid JSON.', status: 400, requestId: 'a1b2c3d4e5f6' }],
  401: ['Missing or invalid API token', { code: 'invalid_token', message: 'The API token is not valid.', status: 401, requestId: 'a1b2c3d4e5f6' }],
  403: ['Forbidden (origin not allowed, or a destructive action was blocked)', { code: 'origin_not_allowed', message: 'This origin is not allowed to call the API.', status: 403, requestId: 'a1b2c3d4e5f6' }],
  404: ['Resource not found', { code: 'workflow_not_found', message: 'No workflow with that id exists.', status: 404, requestId: 'a1b2c3d4e5f6' }],
  409: ['Conflict with the current state (browser not running, automation running, login required ...)', { code: 'browser_not_running', message: 'The browser is not running.', status: 409, requestId: 'a1b2c3d4e5f6', hint: 'Call POST /api/browser/launch.' }],
  410: ['The resource existed but is gone (temporary file lost)', { code: 'screenshot_file_missing', message: 'The screenshot file is no longer in temporary storage.', status: 410, requestId: 'a1b2c3d4e5f6' }],
  413: ['Request body too large', { code: 'payload_too_large', message: 'The request body is too large.', status: 413, requestId: 'a1b2c3d4e5f6' }],
  422: ['Validation failed', { code: 'invalid_request', message: 'The request body is not valid.', status: 422, requestId: 'a1b2c3d4e5f6', details: { problems: [{ path: 'x', message: 'is required' }] } }],
  429: ['Rate limited', { code: 'rate_limited', message: 'Too many requests. Slow down and retry shortly.', status: 429, requestId: 'a1b2c3d4e5f6' }],
  500: ['Unexpected server error', { code: 'internal_error', message: 'An unexpected error occurred.', status: 500, requestId: 'a1b2c3d4e5f6' }],
  502: ['The target website could not be reached', { code: 'navigation_failed', message: 'The page could not be loaded (net::ERR_NAME_NOT_RESOLVED).', status: 502, requestId: 'a1b2c3d4e5f6' }],
  503: ['Browser unavailable (not installed or not enough memory)', { code: 'insufficient_memory', message: 'Not enough free memory to start Chromium (80 MB available).', status: 503, requestId: 'a1b2c3d4e5f6' }],
  504: ['The target website timed out', { code: 'navigation_timeout', message: 'Navigation timed out before the page finished loading.', status: 504, requestId: 'a1b2c3d4e5f6' }],
};

const ErrorEnvelope = {
  type: 'object',
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message', 'status'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable error code.' },
        message: { type: 'string' },
        status: { type: 'integer' },
        requestId: { type: 'string', description: 'Also returned in the X-Request-Id header.' },
        details: { description: 'Extra structured information, for example validation problems.' },
        hint: { type: 'string', description: 'A suggestion for how to recover.' },
      },
    },
  },
};

const pathId = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
const queryParams = (schema) =>
  Object.entries(schema.properties || {}).map(([name, s]) => ({ name, in: 'query', required: false, description: s.description, schema: withRefs({ ...s, description: undefined }) }));

const SAMPLE_ID = '3f8c2b1e-9d4a-4e6b-8c1d-2a7b5e9f0a11';
const SAMPLE_SHOT = {
  id: SAMPLE_ID,
  filename: 'Dynatrace_Problems_2026-10-30_130000.png',
  sourceUrl: 'https://aaj23525.apps.dynatrace.com/ui/problems',
  pageTitle: 'Problems',
  workflowId: SAMPLE_ID,
  workflowName: 'Dynatrace Dashboard Navigation',
  stepNumber: 1,
  stepName: 'Open Problems',
  capturedAt: '2026-10-30T13:00:00.000Z',
  format: 'png',
  sizeBytes: 184233,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  transferred: false,
};
const SAMPLE_STEP = {
  id: 'step_a1b2c3d4e5',
  number: 1,
  name: 'Open Problems',
  action: 'click',
  target: { strategy: 'role', role: 'link', name: 'Problems', exact: true },
  wait: { condition: 'page_ready' },
  screenshot: true,
  enabled: true,
  allowDestructive: false,
};
const SAMPLE_WORKFLOW = {
  id: SAMPLE_ID,
  schemaVersion: 1,
  name: 'Dynatrace Dashboard Navigation',
  description: 'Open Problems, then Services.',
  enabled: true,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:00.000Z',
  steps: [SAMPLE_STEP],
};
const SAMPLE_RUN = {
  id: SAMPLE_ID,
  workflowId: SAMPLE_ID,
  workflowName: 'Dynatrace Dashboard Navigation',
  status: 'running',
  pauseReason: null,
  startedAt: '2026-10-30T13:00:00.000Z',
  currentStepIndex: 1,
  totalSteps: 3,
  completedSteps: 1,
  failedSteps: 0,
  progress: 33,
};
const SAMPLE_AUTOMATION = {
  state: 'running',
  busy: true,
  run: SAMPLE_RUN,
  interruptedRun: null,
  controls: { start: false, pause: true, resume: false, stop: true, restart: true, executeStep: false, skipStep: true, testStep: false },
  note: 'Execution state lives in memory for the current service lifetime only.',
};
const SAMPLE_LOGIN = {
  state: 'waiting_for_login',
  confirmed: false,
  eligibleForAutomation: false,
  loginUrl: 'https://aaj23525.apps.dynatrace.com/',
  openedAt: '2026-10-30T12:59:00.000Z',
  confirmedAt: null,
  message: 'Waiting for you to log in (and complete MFA) in the remote browser, then confirm.',
};
const SAMPLE_BROWSER = {
  available: true,
  state: 'ready',
  connected: true,
  sessionId: '9f2a41c07be3',
  headless: true,
  pageState: 'ok',
  url: 'https://aaj23525.apps.dynatrace.com/',
  title: 'Dynatrace',
  viewport: { width: 1920, height: 1080 },
};
const SAMPLE_INTERACTION = { ok: true, url: 'https://aaj23525.apps.dynatrace.com/', viewport: { width: 1920, height: 1080 }, recording: false };
const SAMPLE_SELECTION = {
  id: SAMPLE_ID,
  selectedAt: '2026-10-30T13:00:00.000Z',
  element: { tag: 'a', id: 'nav-problems', classes: ['nav-link'], text: 'Problems', role: 'link', accessibleName: 'Problems', visible: true },
  cssSelector: '#nav-problems',
  xpath: '//*[@id="nav-problems"]',
  page: { url: 'https://aaj23525.apps.dynatrace.com/', title: 'Dynatrace' },
  frame: { isTopFrame: true, url: 'https://aaj23525.apps.dynatrace.com/', name: null, path: [] },
  locators: { unique: true, primary: { strategy: 'id', selector: '#nav-problems' }, fallbacks: [] },
  warnings: [],
};

/** Describe every operation. Keys are "METHOD /path" using OpenAPI path templates. */
function operations() {
  const ops = [];
  const add = (method, path, o) => ops.push({ method, path, ...o });

  // -- status -----------------------------------------------------------------------------------
  add('get', '/api/status', {
    tag: 'Service',
    summary: 'Service status and health check',
    description:
      'Liveness check for Render and uptime monitors. Without a token it returns only basic liveness facts. With "Authorization: Bearer <token>" it returns the full status: browser, current URL, current workflow, memory, session and restart identifiers.',
    security: 'optional',
    ok: ['Status', { status: 'ok', service: 'cloud-screenshot-service', version: '1.0.0', uptimeSeconds: 3600, restartId: 'a1b2c3d4', authenticated: true, browser: { available: true, running: true, connectionStatus: 'connected' }, currentUrl: 'https://example.com/', currentWorkflow: null, currentWorkflowStatus: 'idle', memory: { limitMB: 512, usedMB: 310, availableMB: 202 }, sessionId: '9f2a41c07be3' }],
    errors: [429],
  });

  // -- browser ----------------------------------------------------------------------------------
  add('post', '/api/browser/launch', { tag: 'Browser', summary: 'Launch headless Chromium', description: 'Starts Chromium with one browser context and one page. Does nothing if it is already running. Fails with 503 when there is not enough free memory.', body: bodies.launch, ok: ['Browser launched', { alreadyRunning: false, ...SAMPLE_BROWSER }], errors: [401, 422, 429, 500, 503] });
  add('post', '/api/browser/close', { tag: 'Browser', summary: 'Close the browser', description: 'Closes Chromium and discards the session (cookies included). Login must be repeated afterwards.', body: bodies.empty, ok: ['Browser closed', { closed: true, wasRunning: true }], errors: [401, 429] });
  add('get', '/api/browser/status', { tag: 'Browser', summary: 'Browser status', description: 'State of the browser, active page and viewport. URLs have credentials and sensitive query values redacted.', ok: ['Browser status', SAMPLE_BROWSER], errors: [401, 429] });
  add('post', '/api/browser/open-url', { tag: 'Browser', summary: 'Open a website', description: 'Navigates the active page. Only http(s) URLs are accepted; localhost and private networks are refused.', body: bodies.openUrl, ok: ['Navigation result', { ok: true, url: 'https://example.com/', status: 200, viewport: { width: 1920, height: 1080 } }], errors: [400, 401, 409, 422, 429, 502, 504] });
  add('get', '/api/browser/screenshot', {
    tag: 'Browser',
    summary: 'Live view of the remote browser',
    description: 'Returns the current viewport as an image (not stored). Headers X-Viewport-Width and X-Viewport-Height give the real viewport size for mapping clicks on the displayed image to browser coordinates. With encoding=base64 a JSON body is returned instead.',
    query: queries.browserScreenshot,
    image: true,
    ok: ['Viewport image (binary) or JSON when encoding=base64', { image: '<base64>', mimeType: 'image/jpeg', viewport: { width: 1920, height: 1080 }, url: 'https://example.com/', title: 'Example', recording: false }],
    errors: [401, 409, 422, 429, 504],
  });
  add('post', '/api/browser/click', { tag: 'Remote interaction', summary: 'Click at viewport coordinates', description: 'Clicks at (x, y) in browser viewport pixels. While the recorder is active a click selects the element instead of activating it. Rejected with 409 while automation is running.', body: bodies.click, ok: ['Interaction result', { ...SAMPLE_INTERACTION, clicked: { x: 640, y: 360, button: 'left' } }], errors: [401, 409, 422, 429] });
  add('post', '/api/browser/hover', { tag: 'Remote interaction', summary: 'Move the mouse / hover', description: 'Moves the pointer to (x, y). While recording, the hovered element is highlighted in the page with a border and tooltip.', body: bodies.hover, ok: ['Interaction result', { ...SAMPLE_INTERACTION, hovered: { x: 640, y: 360 }, element: null }], errors: [401, 409, 422, 429] });
  add('post', '/api/browser/type', { tag: 'Remote interaction', summary: 'Type text into the focused element', description: 'Types into whatever has keyboard focus, for example a login field you clicked. The text is never logged, stored or returned; only the character count is reported.', body: bodies.type, ok: ['Interaction result', { ...SAMPLE_INTERACTION, typedCharacters: 12, pressedEnter: false }], errors: [401, 409, 422, 429] });
  add('post', '/api/browser/keypress', { tag: 'Remote interaction', summary: 'Press a key', description: 'Presses Enter, Tab, Escape, arrow keys, F-keys, a single character or a combination such as Control+A.', body: bodies.keypress, ok: ['Interaction result', { ...SAMPLE_INTERACTION, pressed: 'Enter', times: 1 }], errors: [401, 409, 422, 429] });
  add('post', '/api/browser/scroll', { tag: 'Remote interaction', summary: 'Scroll the page', description: 'Scrolls with the mouse wheel at the given point (default: viewport centre).', body: bodies.scroll, ok: ['Interaction result', { ...SAMPLE_INTERACTION, scrolled: { deltaX: 0, deltaY: 600 }, scrollPosition: { x: 0, y: 600 } }], errors: [401, 409, 422, 429] });
  add('post', '/api/browser/refresh', { tag: 'Remote interaction', summary: 'Reload the page', description: 'Reloads the active page.', body: bodies.empty, ok: ['Interaction result', { ...SAMPLE_INTERACTION, reloaded: true }], errors: [401, 409, 429, 502, 504] });

  // -- login ------------------------------------------------------------------------------------
  add('post', '/api/login/open', { tag: 'Login', summary: 'Open the login page', description: 'Launches Chromium if needed, opens the configured (or supplied) login URL and moves to "waiting_for_login". Sign in and complete MFA yourself through the remote browser; credentials are never sent to this API.', body: bodies.loginOpen, ok: ['Login status', SAMPLE_LOGIN], errors: [400, 401, 409, 422, 429, 502, 503, 504] });
  add('post', '/api/login/confirm', { tag: 'Login', summary: "I'm Logged In — Continue Automation", description: 'Records that the user finished logging in. This is a user acknowledgement, not an independent verification of authentication.', body: bodies.empty, ok: ['Login status', { ...SAMPLE_LOGIN, state: 'confirmed', confirmed: true, eligibleForAutomation: true, confirmedAt: '2026-10-30T13:00:00.000Z' }], errors: [401, 409, 429] });
  add('post', '/api/login/cancel', { tag: 'Login', summary: 'Cancel login', description: 'Cancels the login handshake. The browser stays open.', body: bodies.empty, ok: ['Login status', { ...SAMPLE_LOGIN, state: 'cancelled', message: 'Login was cancelled.' }], errors: [401, 429] });
  add('get', '/api/login/status', { tag: 'Login', summary: 'Login status', description: 'States: idle, waiting_for_login, confirmed, cancelled, expired, lost.', ok: ['Login status', SAMPLE_LOGIN], errors: [401, 429] });

  // -- recorder ---------------------------------------------------------------------------------
  add('post', '/api/recorder/start', { tag: 'Recorder', summary: 'Start recording navigation steps', description: 'Arms the element picker in the page: hover highlights elements, clicking selects them, and the site\'s own click handlers are blocked. Cannot be combined with a running automation.', body: bodies.empty, ok: ['Recorder status', { active: true, startedAt: '2026-10-30T13:00:00.000Z', hasSelection: false }], errors: [401, 409, 429] });
  add('post', '/api/recorder/stop', { tag: 'Recorder', summary: 'Stop recording', description: 'Removes the picker and restores normal page interaction.', body: bodies.empty, ok: ['Recorder status', { active: false, hasSelection: true }], errors: [401, 429] });
  add('get', '/api/recorder/status', { tag: 'Recorder', summary: 'Recorder status', description: 'Includes the known recording limitations (closed shadow DOM, cross-origin frames, browser-native content).', ok: ['Recorder status', { active: true, hasSelection: false, selectionCount: 0, limitations: ['Elements inside closed shadow roots cannot be inspected; the host element is selected instead.'] }], errors: [401, 429] });
  add('get', '/api/recorder/selected-element', { tag: 'Recorder', summary: 'Get the selected element', description: 'Full metadata of the last selected element: tag, id, classes, text, role, accessible name, stable attributes, CSS selector, XPath, URL, page title, frame information, validated locators and warnings.', ok: ['Selection', { hasSelection: true, selection: SAMPLE_SELECTION }], errors: [401, 429] });
  add('post', '/api/recorder/select-element', { tag: 'Recorder', summary: 'Select the element at a coordinate', description: 'Same as clicking while recording. Candidate locators are validated against the live page in priority order (id, data attribute, role + name, CSS, text, XPath). If several elements match, the response reports ambiguity instead of a primary locator.', body: bodies.selectElement, ok: ['Selection', { selection: SAMPLE_SELECTION }], errors: [401, 404, 409, 422, 429] });
  add('post', '/api/recorder/clear-selection', { tag: 'Recorder', summary: 'Clear the selection', description: 'Forgets the selected element and removes its highlight.', body: bodies.empty, ok: ['Cleared', { cleared: true }], errors: [401, 429] });
  add('post', '/api/recorder/check-locator', { tag: 'Recorder', summary: 'Validate a locator against the page', description: 'Counts the elements the locator matches on the current page.', body: bodies.checkLocator, ok: ['Match count', { matches: 1, unique: true, ambiguous: false }], errors: [401, 409, 422, 429] });

  // -- workflows --------------------------------------------------------------------------------
  const wfParam = [pathId('id', 'Workflow id')];
  add('get', '/api/workflows', { tag: 'Workflows', summary: 'List workflows', description: 'Workflows live in temporary storage and are lost when the service restarts; export what you need.', ok: ['Workflow summaries', { workflows: [{ id: SAMPLE_ID, name: 'Dynatrace Dashboard Navigation', enabled: true, stepCount: 3, enabledStepCount: 3, createdAt: '2026-10-30T12:00:00.000Z', updatedAt: '2026-10-30T12:00:00.000Z' }] }], errors: [401, 429] });
  add('post', '/api/workflows', { tag: 'Workflows', summary: 'Create a workflow', description: 'Steps are validated: allowed actions are click, wait_for_element, capture_screenshot and wait_for_navigation. Returns lint warnings alongside the stored workflow.', body: bodies.workflow, status: 201, ok: ['Created workflow', { workflow: SAMPLE_WORKFLOW, warnings: [] }], errors: [401, 409, 413, 422, 429] });
  add('post', '/api/workflows/import', { tag: 'Workflows', summary: 'Import workflow JSON', description: 'Accepts an export document or a bare workflow object. It is fully validated, receives a new id, a clashing name is made unique, and destructive-action permission is stripped from imported steps.', body: { type: 'object', description: 'The JSON produced by GET /api/workflows/{id}/export (or a workflow object).' }, query: queries.workflowImport, status: 201, ok: ['Imported workflow', { workflow: SAMPLE_WORKFLOW, warnings: [], renamed: false }], errors: [400, 401, 409, 413, 422, 429] });
  add('get', '/api/workflows/{id}', { tag: 'Workflows', summary: 'Get a workflow', description: 'Returns the workflow with all steps.', params: wfParam, ok: ['Workflow', { workflow: SAMPLE_WORKFLOW }], errors: [400, 401, 404, 429] });
  add('put', '/api/workflows/{id}', { tag: 'Workflows', summary: 'Update, rename, edit, enable or disable a workflow', description: 'Fields that are omitted keep their stored value, so {"name":"New name"} only renames. Supplying "steps" replaces the whole step list (use it to edit steps, enable/disable them or reorder). Not allowed while the workflow is running.', params: wfParam, body: bodies.workflowUpdate, ok: ['Updated workflow', { workflow: SAMPLE_WORKFLOW, warnings: [] }], errors: [400, 401, 404, 409, 422, 429] });
  add('delete', '/api/workflows/{id}', { tag: 'Workflows', summary: 'Delete a workflow', description: 'Deletes the workflow unless it is currently running.', params: wfParam, ok: ['Deleted', { id: SAMPLE_ID, name: 'Dynatrace Dashboard Navigation', deleted: true }], errors: [400, 401, 404, 409, 429] });
  add('get', '/api/workflows/{id}/export', { tag: 'Workflows', summary: 'Export a workflow as JSON', description: 'Returns a portable document (not wrapped in the usual envelope) that can be saved to a file and imported again.', params: wfParam, raw: { description: 'Workflow export document', example: { format: 'cloud-screenshot-service/workflow', schemaVersion: 1, exportedAt: '2026-10-30T13:00:00.000Z', workflow: SAMPLE_WORKFLOW } }, errors: [400, 401, 404, 429] });
  add('post', '/api/workflows/{id}/duplicate', { tag: 'Workflows', summary: 'Duplicate a workflow', description: 'Creates a copy with new step ids and a unique name.', params: wfParam, body: bodies.workflowDuplicate, status: 201, ok: ['Duplicated workflow', { workflow: { ...SAMPLE_WORKFLOW, name: 'Dynatrace Dashboard Navigation (copy)' }, warnings: [] }], errors: [400, 401, 404, 409, 422, 429] });
  add('post', '/api/workflows/{id}/reorder', { tag: 'Workflows', summary: 'Reorder steps', description: 'Provide every step id exactly once in the new order; step numbers are reassigned.', params: wfParam, body: bodies.workflowReorder, ok: ['Reordered workflow', { workflow: SAMPLE_WORKFLOW, warnings: [] }], errors: [400, 401, 404, 409, 422, 429] });
  add('post', '/api/workflows/{id}/steps', { tag: 'Workflows', summary: 'Add a step (optionally from the recorded element)', description: 'Adds an explicit step, or with fromSelection=true builds a click step from the element currently selected by the recorder. Refused when the selection has no unique locator. Recorded steps never inherit allowDestructive.', params: wfParam, body: bodies.workflowAddStep, status: 201, ok: ['Workflow with the added step', { workflow: SAMPLE_WORKFLOW, warnings: [], addedStep: SAMPLE_STEP, index: 0 }], errors: [400, 401, 404, 409, 422, 429] });

  // -- automation -------------------------------------------------------------------------------
  add('post', '/api/automation/start', { tag: 'Automation', summary: 'Start a workflow', description: 'Requires a running browser and confirmed login. Only one run can be active. Returns 202 and runs in the background; follow progress with GET /api/events. A click that looks destructive is blocked unless the step has allowDestructive and confirmDestructive=true here.', body: bodies.automationStart, status: 202, ok: ['Automation status', SAMPLE_AUTOMATION], errors: [400, 401, 404, 409, 422, 429] });
  add('post', '/api/automation/pause', { tag: 'Automation', summary: 'Pause at the next safe checkpoint', description: 'The current step finishes first; the run then pauses between steps.', body: bodies.empty, ok: ['Automation status', { ...SAMPLE_AUTOMATION, state: 'pausing' }], errors: [401, 409, 429] });
  add('post', '/api/automation/resume', { tag: 'Automation', summary: 'Resume a paused run', description: 'Continues from the first step that has not completed. Also retries a failed step. Requires a confirmed login.', body: bodies.empty, ok: ['Automation status', SAMPLE_AUTOMATION], errors: [401, 409, 429] });
  add('post', '/api/automation/stop', { tag: 'Automation', summary: 'Stop the run', description: 'No new action is scheduled after the request; the step in flight is cancelled.', body: bodies.empty, ok: ['Automation status', { ...SAMPLE_AUTOMATION, state: 'stopping' }], errors: [401, 409, 429] });
  add('post', '/api/automation/restart', { tag: 'Automation', summary: 'Restart the workflow from step 1', description: 'Stops any active run, then starts the same workflow again.', body: bodies.automationRestart, status: 202, ok: ['Automation status', SAMPLE_AUTOMATION], errors: [401, 409, 422, 429] });
  add('post', '/api/automation/execute-step', { tag: 'Automation', summary: 'Execute the current step only', description: 'Runs exactly one step of a paused (or failed) run, then waits again. Start the run with paused=true to step through a workflow.', body: bodies.empty, status: 202, ok: ['Automation status', SAMPLE_AUTOMATION], errors: [401, 409, 429] });
  add('post', '/api/automation/skip-step', { tag: 'Automation', summary: 'Skip the current step', description: 'Marks the current step skipped and moves to the next one.', body: bodies.empty, ok: ['Automation status', SAMPLE_AUTOMATION], errors: [401, 409, 429] });
  add('post', '/api/automation/test-step', { tag: 'Automation', summary: 'Test one step against the current page', description: 'Runs a single step (a stored one by workflowId + stepId/stepNumber, or an inline definition) on whatever page the browser is showing, without starting a run. Waits for the result.', body: bodies.testStep, ok: ['Step result', { passed: true, step: { id: 'step_a1b2c3d4e5', number: 1, name: 'Open Problems', action: 'click' }, result: { status: 'completed', url: 'https://example.com/problems', durationMs: 840 } }], errors: [400, 401, 403, 404, 409, 422, 429, 504] });
  add('get', '/api/automation/status', { tag: 'Automation', summary: 'Automation status', description: 'Run state, per-step results, progress and which controls are currently valid. States: idle, running, pausing, paused, stopping, stopped, completed, failed, interrupted.', ok: ['Automation status', SAMPLE_AUTOMATION], errors: [401, 429] });

  // -- screenshots ------------------------------------------------------------------------------
  const shotParam = [pathId('id', 'Screenshot id')];
  add('get', '/api/screenshots', { tag: 'Screenshots', summary: 'List screenshots', description: 'Screenshots in temporary storage, newest first. They are not permanent: download what you need.', query: queries.screenshotList, ok: ['Screenshot list', { items: [SAMPLE_SHOT], total: 1, totalBytes: 184233, lost: [], storage: { temporary: true, maxScreenshots: 200 } }], errors: [401, 422, 429] });
  add('post', '/api/screenshots', { tag: 'Screenshots', summary: 'Capture a screenshot now', description: 'Captures the current page into temporary storage using the configured format.', body: bodies.screenshotCapture, status: 201, ok: ['Captured screenshot', { screenshot: SAMPLE_SHOT }], errors: [401, 409, 422, 429, 504] });
  add('get', '/api/screenshots/export', { tag: 'Screenshots', summary: 'Export screenshots as a ZIP', description: 'Streams a ZIP of all (or the listed) screenshots plus manifest.json.', query: queries.screenshotExport, zip: true, errors: [401, 404, 422, 429] });
  add('post', '/api/screenshots/export', { tag: 'Screenshots', summary: 'Export selected screenshots as a ZIP', description: 'Same as the GET form but with the ids in the request body (for long selections).', body: bodies.screenshotExport, zip: true, errors: [401, 404, 422, 429] });
  add('delete', '/api/screenshots', { tag: 'Screenshots', summary: 'Delete all screenshots', description: 'Deletes everything in temporary storage, or with transferredOnly=true only screenshots that were already downloaded.', query: queries.screenshotDeleteAll, ok: ['Deleted', { deleted: 4, remaining: 0 }], errors: [401, 422, 429] });
  add('get', '/api/screenshots/{id}', { tag: 'Screenshots', summary: 'Screenshot metadata or inline preview', description: 'Metadata by default; with view=image the image is returned inline for previews.', params: shotParam, query: queries.screenshotGet, ok: ['Screenshot metadata', { screenshot: SAMPLE_SHOT }], image: true, errors: [400, 401, 404, 410, 422, 429] });
  add('get', '/api/screenshots/{id}/download', { tag: 'Screenshots', summary: 'Download a screenshot', description: 'Sends the file as an attachment with ETag and X-Screenshot-Sha256 so the receiver can verify it. Range requests are supported, so an interrupted transfer can be resumed. The screenshot is marked "transferred" once a complete body was sent.', params: shotParam, binary: true, errors: [400, 401, 404, 410, 429] });
  add('delete', '/api/screenshots/{id}', { tag: 'Screenshots', summary: 'Delete a screenshot', description: 'Deletes one screenshot.', params: shotParam, ok: ['Deleted', { id: SAMPLE_ID, filename: SAMPLE_SHOT.filename, deleted: true }], errors: [400, 401, 404, 429] });

  // -- settings ---------------------------------------------------------------------------------
  add('get', '/api/settings', { tag: 'Settings', summary: 'Get settings', description: 'Current browser and screenshot settings with defaults and allowed ranges.', ok: ['Settings', { settings: { defaultLoginUrl: 'https://aaj23525.apps.dynatrace.com/', viewportWidth: 1920, viewportHeight: 1080, navigationTimeout: 30000, elementTimeout: 15000, additionalPageDelay: 5000, screenshotFormat: 'png', screenshotType: 'viewport', headless: true } }], errors: [401, 429] });
  add('put', '/api/settings', { tag: 'Settings', summary: 'Update settings', description: 'Partial update. Viewport and timeout changes apply to the running browser; "headless" applies the next time the browser is launched.', body: bodies.settingsPatch, ok: ['Settings', { changed: ['viewportWidth'], requiresRelaunch: false, settings: { viewportWidth: 1280 } }], errors: [401, 422, 429] });
  add('post', '/api/settings/reset', { tag: 'Settings', summary: 'Reset settings to the environment defaults', description: 'Restores the values defined by the environment variables.', body: bodies.empty, ok: ['Settings', { changed: [], requiresRelaunch: false, settings: {} }], errors: [401, 429] });

  // -- events -----------------------------------------------------------------------------------
  add('get', '/api/events', {
    tag: 'Events',
    summary: 'Real-time events (Server-Sent Events)',
    description:
      'A text/event-stream of real execution events. Because EventSource cannot send an Authorization header (and the token must not be put in the URL), read the stream with fetch() and a streaming body. The first frame, service.connected, carries a status snapshot. After a disconnect, reconnect with the Last-Event-ID header to replay missed events; if the service restarted, service.restarted is sent and the snapshot should be used to resynchronise. Every event includes timestamp, workflowId, workflowName, currentStep, totalSteps, completedSteps, failedSteps, progress, currentUrl and description.',
    sse: true,
    errors: [401, 429],
  });

  // -- test console (public) --------------------------------------------------------------------
  add('get', '/api/test', { tag: 'Test console', summary: 'Standalone test console (HTML)', description: 'A built-in page that exercises every API above from the same origin. It contains no secrets; paste the API token into the page (kept in memory only).', security: 'none', html: true, errors: [] });

  return ops;
}

function buildOpenApi(env) {
  const paths = {};
  for (const o of operations()) {
    const responses = {};
    const status = String(o.status || 200);
    if (o.ok) {
      const [description, example] = o.ok;
      if (o.image) {
        responses[status] = {
          description,
          headers: { 'X-Viewport-Width': { schema: { type: 'integer' } }, 'X-Viewport-Height': { schema: { type: 'integer' } } },
          content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } }, ...json(envelope(), { ok: true, data: example }) },
        };
      } else {
        responses[status] = ok(description, example);
      }
    } else if (o.raw) {
      responses[status] = { description: o.raw.description, content: json({ type: 'object' }, o.raw.example) };
    } else if (o.zip) {
      responses[status] = { description: 'ZIP archive of screenshots with manifest.json', headers: { 'X-Export-Count': { schema: { type: 'integer' } } }, content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } };
    } else if (o.binary) {
      responses[status] = { description: 'The screenshot file', headers: { ETag: { schema: { type: 'string' } }, 'X-Screenshot-Sha256': { schema: { type: 'string' } }, 'Accept-Ranges': { schema: { type: 'string', example: 'bytes' } } }, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } };
      responses['206'] = { description: 'Partial content (Range request)' };
    } else if (o.sse) {
      responses[status] = { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' }, example: 'event: step.completed\ndata: {"type":"step.completed","description":"Step 1 \\"Open Problems\\" completed.","progress":33}\n\n' } } };
    } else if (o.html) {
      responses[status] = { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } };
    }
    for (const code of o.errors || []) responses[String(code)] = errRef(code);

    const operation = {
      tags: [o.tag],
      summary: o.summary,
      description: o.description,
      operationId: `${o.method}_${o.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      responses,
    };
    const parameters = [...(o.params || []), ...(o.query ? queryParams(o.query) : [])];
    if (parameters.length) operation.parameters = parameters;
    if (o.body) {
      operation.requestBody = { required: Object.keys(o.body.properties || {}).length > 0 && (o.body.required || []).length > 0, content: json(withRefs(o.body)) };
    }
    if (o.security === 'none') operation.security = [];
    else if (o.security === 'optional') operation.security = [{}, { bearerAuth: [] }];
    (paths[o.path] ||= {})[o.method] = operation;
  }

  const responses = Object.fromEntries(
    Object.entries(ERROR_DEFS).map(([code, [description, error]]) => [
      code,
      { description, content: json({ $ref: '#/components/schemas/ErrorEnvelope' }, { ok: false, error }) },
    ]),
  );

  const servers = [{ url: '/', description: 'This service' }];
  if (env.render?.externalUrl) servers.unshift({ url: env.render.externalUrl, description: 'Render service URL' });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Cloud Screenshot Automation Service',
      version: env.version,
      description: [
        'Headless Chromium (Playwright) driven through a REST API, designed for Render Free Web Services.',
        '',
        '**Authentication:** every endpoint except `GET /api/status` (liveness only) and the test console requires `Authorization: Bearer <API_TOKEN>`. Click **Authorize** and paste the token to try requests from this page.',
        '',
        '**Free-tier reality:** the filesystem is ephemeral and the service sleeps after inactivity. Browser sessions, workflows, run state and screenshots can disappear after a sleep, restart or redeploy. Download and export what you need to keep.',
        '',
        '**Responses:** success is `{ "ok": true, "data": ... }`; errors are `{ "ok": false, "error": { code, message, status, requestId, details?, hint? } }`.',
      ].join('\n'),
    },
    servers,
    tags: [
      { name: 'Service' }, { name: 'Browser' }, { name: 'Remote interaction' }, { name: 'Login' }, { name: 'Recorder' },
      { name: 'Workflows' }, { name: 'Automation' }, { name: 'Screenshots' }, { name: 'Settings' }, { name: 'Events' }, { name: 'Test console' },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'The API_TOKEN configured on the service.' } },
      schemas: { ErrorEnvelope, Locator: withRefs(locator), Step: withRefs(step) },
      responses,
    },
  };
}

module.exports = { buildOpenApi, operations };
