'use strict';

/**
 * Request schemas shared by the validation middleware AND the OpenAPI document, so the documented
 * contract cannot drift from what the API actually enforces.
 */

const UUID = { type: 'string', format: 'uuid', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const coordinate = { type: 'number', minimum: 0, maximum: 10000 };

const locatorBase = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy'],
  properties: {
    strategy: { enum: ['id', 'data', 'role', 'css', 'text', 'xpath'], description: 'How the element is found. Priority when recording: id, data, role, css, text, xpath.' },
    selector: { type: 'string', maxLength: 1000, description: 'CSS or XPath expression (strategies id, data, css, xpath).' },
    role: { type: 'string', maxLength: 40, description: 'ARIA role (strategy role).' },
    name: { type: 'string', maxLength: 200, description: 'Accessible name (strategy role).' },
    text: { type: 'string', maxLength: 200, description: 'Visible text (strategy text).' },
    exact: { type: 'boolean', description: 'Exact match for role name / text. Default true.' },
    frames: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 }, description: 'Selectors of the <iframe> elements leading to the element, outermost first.' },
    index: { type: 'integer', minimum: 0, maximum: 1000, description: 'Pick the n-th match deliberately when several elements match.' },
    description: { type: 'string', maxLength: 300 },
    tag: { type: 'string', maxLength: 40 },
    stability: { enum: ['high', 'medium', 'low'] },
  },
};

const locator = {
  ...locatorBase,
  properties: {
    ...locatorBase.properties,
    fallbacks: { type: 'array', maxItems: 6, items: locatorBase, description: 'Alternative locators tried, in order, when the primary one does not resolve to exactly one element.' },
  },
};

const step = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'action'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    number: { type: 'integer', minimum: 1, description: 'Assigned from the position in the workflow; supplied values are ignored.' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    action: { enum: ['click', 'wait_for_element', 'capture_screenshot', 'wait_for_navigation'] },
    target: locator,
    expectedUrl: { type: 'string', maxLength: 500, description: 'URL pattern the page must match after the step: "/regex/flags", a glob with * or **, or plain text (substring).' },
    wait: {
      type: 'object',
      additionalProperties: false,
      properties: {
        condition: { enum: ['page_ready', 'element_visible', 'element_hidden', 'url_matches', 'url_change', 'none'] },
        target: locator,
        urlPattern: { type: 'string', maxLength: 500 },
      },
    },
    timeout: { type: ['integer', 'null'], minimum: 500, maximum: 120000, description: 'Per-step timeout in ms. Omit or null to use the global element timeout.' },
    delay: { type: ['integer', 'null'], minimum: 0, maximum: 60000, description: 'Additional delay in ms after the step. Omit or null to use the global additional page delay.' },
    screenshot: { type: 'boolean' },
    screenshotFullPage: { type: 'boolean' },
    enabled: { type: 'boolean' },
    allowDestructive: { type: 'boolean', description: 'Permit a click that looks destructive. The run must also be started with confirmDestructive=true.' },
    notes: { type: 'string', maxLength: 500 },
  },
};

const workflow = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    schemaVersion: { type: 'integer' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', maxLength: 40 },
    updatedAt: { type: 'string', maxLength: 40 },
    steps: { type: 'array', maxItems: 100, items: step },
  },
};

// PUT /workflows/:id: every field is optional; fields that are omitted keep their stored value.
const workflowUpdate = { ...workflow, required: [] };

const settingsPatch = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    defaultLoginUrl: { type: 'string', maxLength: 2048 },
    viewportWidth: { type: 'integer', minimum: 320, maximum: 3840 },
    viewportHeight: { type: 'integer', minimum: 240, maximum: 2160 },
    navigationTimeout: { type: 'integer', minimum: 1000, maximum: 120000 },
    elementTimeout: { type: 'integer', minimum: 500, maximum: 120000 },
    additionalPageDelay: { type: 'integer', minimum: 0, maximum: 60000 },
    screenshotFormat: { enum: ['png', 'jpeg'] },
    screenshotType: { enum: ['viewport', 'fullPage'] },
    screenshotQuality: { type: 'integer', minimum: 1, maximum: 100 },
    headless: { type: 'boolean', description: 'Takes effect the next time the browser is launched.' },
  },
};

const empty = { type: 'object', additionalProperties: false, properties: {} };

const bodies = {
  empty,
  launch: { type: 'object', additionalProperties: false, properties: { headless: { type: 'boolean' } } },
  openUrl: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } } },
  click: {
    type: 'object',
    additionalProperties: false,
    required: ['x', 'y'],
    properties: { x: coordinate, y: coordinate, button: { enum: ['left', 'right', 'middle'] }, clickCount: { enum: [1, 2] } },
  },
  hover: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: coordinate, y: coordinate } },
  type: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 2000, description: 'Typed into the focused element. Never logged, stored or echoed back.' },
      delay: { type: 'integer', minimum: 0, maximum: 500 },
      pressEnter: { type: 'boolean' },
    },
  },
  keypress: {
    type: 'object',
    additionalProperties: false,
    required: ['key'],
    properties: {
      key: { type: 'string', minLength: 1, maxLength: 40, description: 'Key name such as Enter, Tab, Escape, ArrowDown, F5 or a combination like Control+A.' },
      times: { type: 'integer', minimum: 1, maximum: 20 },
    },
  },
  scroll: {
    type: 'object',
    additionalProperties: false,
    properties: {
      deltaX: { type: 'number', minimum: -20000, maximum: 20000 },
      deltaY: { type: 'number', minimum: -20000, maximum: 20000 },
      x: coordinate,
      y: coordinate,
    },
  },
  loginOpen: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', maxLength: 2048 } } },
  selectElement: {
    type: 'object',
    additionalProperties: false,
    required: ['x', 'y'],
    properties: {
      x: coordinate,
      y: coordinate,
      activate: { type: 'boolean', description: 'After selecting, also perform the real click so you can reach the next page. Refused for destructive-looking or sensitive elements.' },
    },
  },
  checkLocator: { type: 'object', additionalProperties: false, required: ['locator'], properties: { locator } },
  workflow,
  workflowUpdate,
  workflowDuplicate: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } },
  workflowReorder: {
    type: 'object',
    additionalProperties: false,
    required: ['order'],
    properties: { order: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Every step id of the workflow, in the new order.' } },
  },
  workflowAddStep: {
    type: 'object',
    additionalProperties: false,
    properties: {
      step: step,
      fromSelection: { type: 'boolean', description: 'Build the step from the element currently selected by the recorder.' },
      name: { type: 'string', minLength: 1, maxLength: 120, description: 'Overrides the suggested name when fromSelection is true.' },
      index: { type: 'integer', minimum: 0, maximum: 100, description: 'Insert position (0-based). Defaults to the end.' },
      screenshot: { type: 'boolean' },
      clearSelection: { type: 'boolean' },
    },
  },
  automationStart: {
    type: 'object',
    additionalProperties: false,
    required: ['workflowId'],
    properties: {
      workflowId: UUID,
      confirmDestructive: { type: 'boolean', description: 'Allow steps flagged allowDestructive to perform clicks that look destructive.' },
      paused: { type: 'boolean', description: 'Create the run but wait for execute-step / resume instead of running immediately.' },
      startAtStep: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  automationRestart: { type: 'object', additionalProperties: false, properties: { confirmDestructive: { type: 'boolean' } } },
  testStep: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflowId: UUID,
      stepId: { type: 'string', maxLength: 64 },
      stepNumber: { type: 'integer', minimum: 1, maximum: 100 },
      step: step,
      confirmDestructive: { type: 'boolean' },
      screenshot: { type: 'boolean', description: 'Also capture a screenshot after the step. Default false.' },
    },
  },
  screenshotCapture: {
    type: 'object',
    additionalProperties: false,
    properties: {
      label: { type: 'string', maxLength: 60 },
      format: { enum: ['png', 'jpeg'] },
      fullPage: { type: 'boolean' },
    },
  },
  screenshotExport: {
    type: 'object',
    additionalProperties: false,
    properties: { ids: { type: 'array', minItems: 1, maxItems: 200, items: UUID } },
  },
  settingsPatch,
};

const queries = {
  browserScreenshot: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { enum: ['png', 'jpeg'] },
      quality: { type: 'integer', minimum: 1, maximum: 100 },
      encoding: { enum: ['binary', 'base64'] },
    },
  },
  screenshotList: {
    type: 'object',
    additionalProperties: false,
    properties: { workflowId: { type: 'string', maxLength: 64 }, runId: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } },
  },
  screenshotGet: { type: 'object', additionalProperties: false, properties: { view: { enum: ['meta', 'image'] } } },
  screenshotDeleteAll: { type: 'object', additionalProperties: false, properties: { transferredOnly: { type: 'boolean' } } },
  screenshotExport: { type: 'object', additionalProperties: false, properties: { ids: { type: 'string', maxLength: 8000, description: 'Comma-separated screenshot ids. Omit to export everything.' } } },
  workflowImport: { type: 'object', additionalProperties: false, properties: { onConflict: { enum: ['rename', 'reject'] } } },
  empty,
};

module.exports = { bodies, queries, UUID, locator, step, workflow };
