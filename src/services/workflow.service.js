'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const { err } = require('../errors');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/date-utils');
const { atomicWriteJson, readJsonSafe, removeIfExists, UUID_RE } = require('../utils/file-utils');
const { validateUrlPattern } = require('../utils/url-utils');
const { validateLocatorSpec, normalizeLocatorSpec } = require('../automation/locator-builder');

const ACTIONS = ['click', 'wait_for_element', 'capture_screenshot', 'wait_for_navigation'];
const WAIT_CONDITIONS = ['page_ready', 'element_visible', 'element_hidden', 'url_matches', 'url_change', 'none'];
const SCHEMA_VERSION = 1;
const MAX_STEPS = 100;
const MAX_WORKFLOWS = 100;
const MAX_IMPORT_BYTES = 512 * 1024;

const locatorSchema = {
  type: 'object',
  additionalProperties: true, // structure is checked in depth by validateLocatorSpec; unknown keys are dropped later
};

const stepSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'action'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    number: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    action: { enum: ACTIONS },
    target: locatorSchema,
    expectedUrl: { type: 'string', maxLength: 500 },
    wait: {
      type: 'object',
      additionalProperties: false,
      properties: {
        condition: { enum: WAIT_CONDITIONS },
        target: locatorSchema,
        urlPattern: { type: 'string', maxLength: 500 },
      },
    },
    // null means "inherit the global setting" and is dropped during normalization.
    timeout: { type: ['integer', 'null'], minimum: 500, maximum: 120000 },
    delay: { type: ['integer', 'null'], minimum: 0, maximum: 60000 },
    screenshot: { type: 'boolean' },
    screenshotFullPage: { type: 'boolean' },
    enabled: { type: 'boolean' },
    allowDestructive: { type: 'boolean' },
    notes: { type: 'string', maxLength: 500 },
  },
};

const workflowSchema = {
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
    steps: { type: 'array', maxItems: MAX_STEPS, items: stepSchema },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false, removeAdditional: false });
const validateSchema = ajv.compile(workflowSchema);

function formatAjvErrors(errors = []) {
  return errors.slice(0, 25).map((e) => {
    const p = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)';
    let message = e.message;
    if (e.keyword === 'additionalProperties') message = `unknown property "${e.params.additionalProperty}"`;
    if (e.keyword === 'enum') message = `must be one of: ${e.params.allowedValues.join(', ')}`;
    return { path: p, message };
  });
}

const stripCtl = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

function newStepId() {
  return `step_${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Validate semantic rules the JSON schema cannot express, and return a normalized step.
 * Problems are collected, not thrown, so a caller can report every issue at once.
 */
function normalizeStep(raw, index, problems) {
  const at = (field) => `steps[${index}]${field ? `.${field}` : ''}`;
  const bad = (field, message) => problems.push({ path: at(field), message });
  const step = {
    id: raw.id && /^[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : newStepId(),
    number: index + 1,
    name: stripCtl(raw.name).trim(),
    action: raw.action,
    screenshot: raw.screenshot ?? raw.action === 'capture_screenshot',
    screenshotFullPage: raw.screenshotFullPage ?? false,
    enabled: raw.enabled ?? true,
    allowDestructive: raw.allowDestructive ?? false,
  };
  if (!step.name) bad('name', 'Step name must not be empty.');
  // Optional numbers are only present when set, so stored and exported JSON never carries nulls.
  if (raw.timeout != null) step.timeout = raw.timeout;
  if (raw.delay != null) step.delay = raw.delay;
  if (raw.notes) step.notes = stripCtl(raw.notes);

  if (raw.target !== undefined) {
    for (const p of validateLocatorSpec(raw.target, at('target'))) problems.push(p);
    step.target = normalizeLocatorSpec(raw.target);
  }
  if (raw.expectedUrl !== undefined && raw.expectedUrl !== '') {
    const msg = validateUrlPattern(raw.expectedUrl);
    if (msg) bad('expectedUrl', msg);
    step.expectedUrl = raw.expectedUrl;
  }
  if (raw.wait !== undefined) {
    const wait = { condition: raw.wait.condition ?? 'page_ready' };
    if (raw.wait.target !== undefined) {
      for (const p of validateLocatorSpec(raw.wait.target, at('wait.target'))) problems.push(p);
      wait.target = normalizeLocatorSpec(raw.wait.target);
    }
    if (raw.wait.urlPattern !== undefined) {
      const msg = validateUrlPattern(raw.wait.urlPattern);
      if (msg) bad('wait.urlPattern', msg);
      wait.urlPattern = raw.wait.urlPattern;
    }
    if ((wait.condition === 'element_visible' || wait.condition === 'element_hidden') && !wait.target && !step.target) {
      bad('wait.target', `Wait condition "${wait.condition}" needs a wait target (or a step target).`);
    }
    if (wait.condition === 'url_matches' && !wait.urlPattern && !step.expectedUrl) {
      bad('wait.urlPattern', 'Wait condition "url_matches" needs a urlPattern (or an expectedUrl).');
    }
    step.wait = wait;
  } else {
    step.wait = { condition: step.action === 'wait_for_navigation' ? 'url_change' : 'page_ready' };
  }

  // Action-specific requirements.
  if ((raw.action === 'click' || raw.action === 'wait_for_element') && !step.target) {
    bad('target', `Action "${raw.action}" needs a target locator.`);
  }
  if (raw.action === 'capture_screenshot') step.screenshot = true;
  return step;
}

/** Validate and normalize a workflow document. Throws a 422 AppError listing all problems. */
function validateWorkflowInput(input, { forImport = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw err.unprocessable('invalid_workflow', 'A workflow must be a JSON object.');
  }
  const problems = [];
  if (!validateSchema(input)) {
    problems.push(...formatAjvErrors(validateSchema.errors));
    // Structure is wrong, so the semantic checks below cannot run safely on arbitrary input. They still run on
    // steps that are well-formed objects, so the user sees every problem at once instead of one round at a time.
    const steps = Array.isArray(input.steps) ? input.steps : [];
    steps.forEach((s, i) => {
      if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.name === 'string' && ACTIONS.includes(s.action)) {
        const found = [];
        try {
          normalizeStep(s, i, found);
        } catch {
          /* malformed nested values were already reported by the schema pass */
        }
        for (const p of found) if (!problems.some((q) => q.path === p.path.replace(/\[(\d+)\]/g, '.$1'))) problems.push(p);
      }
    });
    throw err.unprocessable('invalid_workflow', 'The workflow is not valid.', { details: { problems: problems.slice(0, 40) } });
  }
  const steps = (input.steps || []).map((s, i) => normalizeStep(s, i, problems));
  const ids = new Set();
  for (const s of steps) {
    if (ids.has(s.id)) s.id = newStepId();
    ids.add(s.id);
  }
  const name = stripCtl(input.name).trim();
  if (!name) problems.push({ path: 'name', message: 'Workflow name must not be empty.' });
  if (forImport && input.schemaVersion !== undefined && input.schemaVersion > SCHEMA_VERSION) {
    problems.push({ path: 'schemaVersion', message: `Unsupported schemaVersion ${input.schemaVersion}; this service supports up to ${SCHEMA_VERSION}.` });
  }
  if (problems.length) {
    throw err.unprocessable('invalid_workflow', 'The workflow is not valid.', { details: { problems: problems.slice(0, 40) } });
  }
  return {
    name,
    description: input.description ? stripCtl(input.description).trim() : '',
    enabled: input.enabled ?? true,
    steps,
  };
}

/** Non-fatal observations about a workflow, shown to the user before running it. */
function lintWorkflow(workflow) {
  const warnings = [];
  const enabled = workflow.steps.filter((s) => s.enabled);
  if (!enabled.length) warnings.push('The workflow has no enabled steps.');
  for (const s of workflow.steps) {
    if (s.allowDestructive) warnings.push(`Step ${s.number} "${s.name}" is allowed to perform a potentially destructive click.`);
    if (s.target && s.target.strategy === 'xpath') warnings.push(`Step ${s.number} "${s.name}" relies on an XPath locator, which is fragile.`);
    if (s.action === 'click' && !s.target?.fallbacks?.length && s.target?.stability === 'low') {
      warnings.push(`Step ${s.number} "${s.name}" uses a position-based locator that may break if the page changes.`);
    }
  }
  return warnings;
}

class WorkflowService {
  constructor({ env }) {
    this.env = env;
    this.dir = env.workflowDir;
    this.items = new Map();
    this.inUseProvider = null; // set by AutomationService: () => id of the workflow currently running
  }

  async init() {
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const doc = await readJsonSafe(path.join(this.dir, name));
      if (doc && UUID_RE.test(doc.id || '') && Array.isArray(doc.steps)) this.items.set(doc.id, doc);
    }
    if (this.items.size) logger.info('Loaded workflows from temporary storage', { count: this.items.size });
  }

  summary(wf) {
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      stepCount: wf.steps.length,
      enabledStepCount: wf.steps.filter((s) => s.enabled).length,
    };
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((w) => this.summary(w));
  }

  _require(id) {
    if (!UUID_RE.test(String(id))) throw err.badRequest('invalid_id', 'Workflow id must be a UUID.');
    const wf = this.items.get(id);
    if (!wf) throw err.notFound('workflow_not_found', 'No workflow with that id exists. Workflows are temporary and are lost when the service restarts; import them again from an exported file.');
    return wf;
  }

  get(id) {
    return structuredClone(this._require(id));
  }

  has(id) {
    return this.items.has(id);
  }

  _assertUniqueName(name, exceptId) {
    const lower = name.toLowerCase();
    for (const w of this.items.values()) {
      if (w.id !== exceptId && w.name.toLowerCase() === lower) {
        throw err.conflict('workflow_name_taken', `A workflow named "${name}" already exists.`);
      }
    }
  }

  async _save(wf) {
    await atomicWriteJson(path.join(this.dir, `${wf.id}.json`), wf);
    this.items.set(wf.id, wf);
  }

  async create(input, { source = 'api' } = {}) {
    if (this.items.size >= MAX_WORKFLOWS) throw err.conflict('workflow_limit', `At most ${MAX_WORKFLOWS} workflows can be stored.`);
    const valid = validateWorkflowInput(input);
    this._assertUniqueName(valid.name);
    const now = nowIso();
    const wf = { id: crypto.randomUUID(), schemaVersion: SCHEMA_VERSION, ...valid, createdAt: now, updatedAt: now };
    await this._save(wf);
    logger.info('Workflow created', { id: wf.id, steps: wf.steps.length, source });
    return { workflow: structuredClone(wf), warnings: lintWorkflow(wf) };
  }

  async update(id, input) {
    const existing = this._require(id);
    if (this.inUseProvider && this.inUseProvider() === id) {
      throw err.conflict('workflow_in_use', 'This workflow is running. Stop the automation before editing it.');
    }
    // Fields that are not supplied keep their stored value, so a rename-only PUT cannot wipe the steps.
    const valid = validateWorkflowInput({
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      enabled: input.enabled ?? existing.enabled,
      steps: input.steps ?? existing.steps,
    });
    this._assertUniqueName(valid.name, id);
    const wf = { ...existing, ...valid, id, schemaVersion: SCHEMA_VERSION, createdAt: existing.createdAt, updatedAt: nowIso() };
    await this._save(wf);
    return { workflow: structuredClone(wf), warnings: lintWorkflow(wf) };
  }

  /** Insert one step (for example one built from a recorded element) at `index`, or at the end. */
  async addStep(id, step, index) {
    const existing = this._require(id);
    if (existing.steps.length >= MAX_STEPS) throw err.conflict('step_limit', `A workflow can have at most ${MAX_STEPS} steps.`);
    const steps = structuredClone(existing.steps);
    const at = index === undefined ? steps.length : Math.min(index, steps.length);
    steps.splice(at, 0, step);
    const result = await this.update(id, { steps });
    return { ...result, addedStep: result.workflow.steps[at], index: at };
  }

  /** Reorder steps. `order` must list every existing step id exactly once. */
  async reorder(id, order) {
    const existing = this._require(id);
    const known = new Set(existing.steps.map((s) => s.id));
    const valid = order.length === known.size && new Set(order).size === order.length && order.every((sid) => known.has(sid));
    if (!valid) {
      throw err.unprocessable('invalid_order', 'order must list every step id of the workflow exactly once.', {
        details: { expected: [...known] },
      });
    }
    const byId = new Map(existing.steps.map((s) => [s.id, s]));
    return this.update(id, { steps: order.map((sid) => byId.get(sid)) });
  }

  async remove(id) {
    const wf = this._require(id);
    if (this.inUseProvider && this.inUseProvider() === id) {
      throw err.conflict('workflow_in_use', 'This workflow is running. Stop the automation before deleting it.');
    }
    this.items.delete(id);
    await removeIfExists(path.join(this.dir, `${id}.json`));
    return { id, name: wf.name, deleted: true };
  }

  async duplicate(id, name) {
    const source = this._require(id);
    let copyName = name?.trim() || `${source.name} (copy)`;
    for (let n = 2; [...this.items.values()].some((w) => w.name.toLowerCase() === copyName.toLowerCase()); n += 1) {
      copyName = `${name?.trim() || `${source.name} (copy)`} ${n}`;
    }
    const steps = structuredClone(source.steps).map((s) => ({ ...s, id: newStepId() }));
    return this.create({ name: copyName.slice(0, 120), description: source.description, enabled: source.enabled, steps }, { source: 'duplicate' });
  }

  /** Portable JSON: ids and timestamps of the source are included but regenerated on import. */
  export(id) {
    const wf = this._require(id);
    return {
      format: 'cloud-screenshot-service/workflow',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      workflow: structuredClone(wf),
    };
  }

  /**
   * Import an exported document (or a bare workflow object). Imported workflows always get a fresh id
   * and cannot carry destructive permission: `allowDestructive` is reset and must be re-granted by an editor.
   */
  async importDocument(doc, { onConflict = 'rename' } = {}) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw err.unprocessable('invalid_workflow', 'The import must be a JSON object.');
    }
    if (JSON.stringify(doc).length > MAX_IMPORT_BYTES) {
      throw err.badRequest('import_too_large', `The workflow JSON is larger than ${MAX_IMPORT_BYTES / 1024} KB.`);
    }
    const candidate = doc.workflow && typeof doc.workflow === 'object' ? doc.workflow : doc;
    if (doc.format !== undefined && doc.format !== 'cloud-screenshot-service/workflow') {
      throw err.unprocessable('invalid_workflow', `Unrecognised export format "${String(doc.format).slice(0, 60)}".`);
    }
    const { id: _ignoredId, createdAt: _c, updatedAt: _u, ...rest } = candidate;
    const stripped = {
      ...rest,
      steps: (rest.steps || []).map(({ id: _sid, number: _n, ...s }) => ({ ...s })),
    };
    const reset = [];
    for (const [i, s] of (stripped.steps || []).entries()) {
      if (s && s.allowDestructive === true) {
        s.allowDestructive = false;
        reset.push(i + 1);
      }
    }
    const valid = validateWorkflowInput({ ...stripped, schemaVersion: doc.schemaVersion ?? stripped.schemaVersion }, { forImport: true });
    let name = valid.name;
    if ([...this.items.values()].some((w) => w.name.toLowerCase() === name.toLowerCase())) {
      if (onConflict === 'reject') throw err.conflict('workflow_name_taken', `A workflow named "${name}" already exists.`);
      for (let n = 2; [...this.items.values()].some((w) => w.name.toLowerCase() === name.toLowerCase()); n += 1) {
        name = `${valid.name} (${n})`.slice(0, 120);
      }
    }
    const result = await this.create({ ...valid, name }, { source: 'import' });
    if (reset.length) {
      result.warnings.unshift(`Destructive-action permission was removed from imported step(s) ${reset.join(', ')}; re-enable it deliberately if needed.`);
    }
    return { ...result, renamed: name !== valid.name };
  }

  /** Re-validate a stored workflow right before execution. */
  validateForRun(id) {
    const wf = this._require(id);
    const valid = validateWorkflowInput(wf);
    const steps = valid.steps.filter((s) => s.enabled);
    if (!wf.enabled) throw err.conflict('workflow_disabled', 'This workflow is disabled.');
    if (!steps.length) throw err.unprocessable('no_enabled_steps', 'The workflow has no enabled steps to run.');
    return structuredClone(wf);
  }
}

module.exports = {
  WorkflowService,
  validateWorkflowInput,
  lintWorkflow,
  ACTIONS,
  WAIT_CONDITIONS,
  SCHEMA_VERSION,
  MAX_STEPS,
  MAX_IMPORT_BYTES,
};
