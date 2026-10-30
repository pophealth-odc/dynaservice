'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WorkflowService, validateWorkflowInput, lintWorkflow } = require('../../src/services/workflow.service');

const click = (name, selector = '#a', extra = {}) => ({ name, action: 'click', target: { strategy: 'css', selector }, ...extra });

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-wf-'));
  const service = new WorkflowService({ env: { workflowDir: dir } });
  return { service, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const problems = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.details?.problems || [{ message: e.message }];
  }
  return null;
};

test('validateWorkflowInput normalizes a minimal workflow', () => {
  const wf = validateWorkflowInput({ name: '  My flow  ', steps: [click('Open')] });
  assert.equal(wf.name, 'My flow');
  assert.equal(wf.enabled, true);
  assert.equal(wf.steps[0].number, 1);
  assert.match(wf.steps[0].id, /^step_/);
  assert.equal(wf.steps[0].enabled, true);
  assert.equal(wf.steps[0].screenshot, false);
  assert.equal(wf.steps[0].allowDestructive, false);
  assert.deepEqual(wf.steps[0].wait, { condition: 'page_ready' });
  assert.ok(!('timeout' in wf.steps[0]) && !('delay' in wf.steps[0]), 'no null/undefined optional numbers are stored');
});

test('step numbers follow position and capture_screenshot always takes a screenshot', () => {
  const wf = validateWorkflowInput({ name: 'x', steps: [click('a'), { name: 'shot', action: 'capture_screenshot', screenshot: false }, click('c')] });
  assert.deepEqual(wf.steps.map((s) => s.number), [1, 2, 3]);
  assert.equal(wf.steps[1].screenshot, true);
});

test('wait_for_navigation defaults to url_change; others default to page_ready', () => {
  const wf = validateWorkflowInput({ name: 'x', steps: [{ name: 'n', action: 'wait_for_navigation' }, click('c')] });
  assert.equal(wf.steps[0].wait.condition, 'url_change');
  assert.equal(wf.steps[1].wait.condition, 'page_ready');
});

test('null timeout/delay mean "inherit" and are dropped', () => {
  const wf = validateWorkflowInput({ name: 'x', steps: [click('a', '#a', { timeout: null, delay: null }), click('b', '#b', { timeout: 2000, delay: 0 })] });
  assert.ok(!('timeout' in wf.steps[0]) && !('delay' in wf.steps[0]));
  assert.equal(wf.steps[1].timeout, 2000);
  assert.equal(wf.steps[1].delay, 0);
});

test('invalid workflows are rejected with every problem listed', () => {
  const bad = problems(() => validateWorkflowInput({ name: 'x', bogus: 1, steps: [{ name: 'a', action: 'teleport' }, { name: 'b', action: 'click' }, { name: '', action: 'click', target: { strategy: 'css', selector: '#a' } }] }));
  assert.ok(bad && bad.length >= 3);
  const text = JSON.stringify(bad);
  assert.match(text, /unknown property/);
  assert.match(text, /must be one of: click, wait_for_element, capture_screenshot, wait_for_navigation/);
  assert.match(text, /needs a target/);
});

test('rejects non-objects, missing names, oversize step lists and bad numbers', () => {
  for (const input of [null, 'x', 5, [], {}, { name: '' }, { name: 'x', steps: 'no' }, { name: 'x', steps: new Array(101).fill(click('a')) }, { name: 'x', steps: [click('a', '#a', { timeout: 5 })] }, { name: 'x', steps: [click('a', '#a', { delay: -1 })] }]) {
    assert.throws(() => validateWorkflowInput(input), (e) => e.code === 'invalid_workflow', JSON.stringify(input)?.slice(0, 60));
  }
});

test('dangerous locators inside steps are rejected', () => {
  for (const target of [{ strategy: 'css', selector: 'a >> text=x' }, { strategy: 'css', selector: 'js=alert(1)' }, { strategy: 'xpath' }, { strategy: 'role' }]) {
    assert.throws(() => validateWorkflowInput({ name: 'x', steps: [{ name: 'a', action: 'click', target }] }), (e) => e.code === 'invalid_workflow', JSON.stringify(target));
  }
});

test('wait conditions are checked for the inputs they need', () => {
  assert.ok(problems(() => validateWorkflowInput({ name: 'x', steps: [{ name: 'a', action: 'capture_screenshot', wait: { condition: 'element_visible' } }] })));
  assert.ok(problems(() => validateWorkflowInput({ name: 'x', steps: [{ name: 'a', action: 'capture_screenshot', wait: { condition: 'url_matches' } }] })));
  assert.equal(problems(() => validateWorkflowInput({ name: 'x', steps: [click('a', '#a', { wait: { condition: 'element_visible' } })] })), null, 'falls back to the step target');
  assert.ok(problems(() => validateWorkflowInput({ name: 'x', steps: [click('a', '#a', { expectedUrl: '/(/' })] })), 'broken regex pattern');
});

test('control characters are stripped from names', () => {
  const wf = validateWorkflowInput({ name: 'Flow\u0000\u0007 one', steps: [click('Step\u001b one')] });
  assert.equal(wf.name, 'Flow one');
  assert.equal(wf.steps[0].name, 'Step one');
});

test('create / get / list / update / delete lifecycle', async () => {
  const { service, cleanup } = makeService();
  try {
    const { workflow, warnings } = await service.create({ name: 'A', steps: [click('one'), click('two', '#b')] });
    assert.match(workflow.id, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(warnings));
    assert.equal(service.list().length, 1);
    assert.equal(service.get(workflow.id).steps.length, 2);

    const copy = service.get(workflow.id);
    copy.name = 'mutated';
    assert.equal(service.get(workflow.id).name, 'A', 'get returns a copy');

    const renamed = await service.update(workflow.id, { name: 'B' });
    assert.equal(renamed.workflow.name, 'B');
    assert.equal(renamed.workflow.steps.length, 2, 'rename-only keeps the steps');
    assert.ok(renamed.workflow.updatedAt >= workflow.updatedAt);
    assert.equal(renamed.workflow.createdAt, workflow.createdAt);

    await assert.rejects(service.create({ name: 'b', steps: [] }), (e) => e.code === 'workflow_name_taken', 'names are unique, case-insensitively');
    await service.remove(workflow.id);
    assert.equal(service.list().length, 0);
    await assert.rejects(async () => service.get(workflow.id), (e) => e.code === 'workflow_not_found');
    await assert.rejects(async () => service.get('not-a-uuid'), (e) => e.code === 'invalid_id');
  } finally {
    cleanup();
  }
});

test('workflows persist to disk and reload', async () => {
  const { service, dir, cleanup } = makeService();
  try {
    const { workflow } = await service.create({ name: 'Persist', steps: [click('one')] });
    const again = new WorkflowService({ env: { workflowDir: dir } });
    await again.init();
    assert.equal(again.get(workflow.id).name, 'Persist');
  } finally {
    cleanup();
  }
});

test('reorder requires every step id exactly once and renumbers', async () => {
  const { service, cleanup } = makeService();
  try {
    const { workflow } = await service.create({ name: 'R', steps: [click('a'), click('b', '#b'), click('c', '#c')] });
    const [a, b, c] = workflow.steps.map((s) => s.id);
    const out = await service.reorder(workflow.id, [c, a, b]);
    assert.deepEqual(out.workflow.steps.map((s) => s.name), ['c', 'a', 'b']);
    assert.deepEqual(out.workflow.steps.map((s) => s.number), [1, 2, 3]);
    for (const order of [[a, b], [a, a, b], [a, b, c, 'x'], [a, b, 'x']]) {
      await assert.rejects(service.reorder(workflow.id, order), (e) => e.code === 'invalid_order');
    }
  } finally {
    cleanup();
  }
});

test('addStep inserts at an index and duplicate makes an independent copy', async () => {
  const { service, cleanup } = makeService();
  try {
    const { workflow } = await service.create({ name: 'S', steps: [click('a'), click('c', '#c')] });
    const added = await service.addStep(workflow.id, click('b', '#b'), 1);
    assert.deepEqual(added.workflow.steps.map((s) => s.name), ['a', 'b', 'c']);
    assert.equal(added.index, 1);
    const dup = await service.duplicate(workflow.id);
    assert.equal(dup.workflow.name, 'S (copy)');
    assert.notEqual(dup.workflow.id, workflow.id);
    const ids = new Set([...workflow.steps, ...dup.workflow.steps].map((s) => s.id));
    assert.equal(ids.size, workflow.steps.length + dup.workflow.steps.length, 'step ids are not shared');
    assert.equal((await service.duplicate(workflow.id)).workflow.name, 'S (copy) 2');
  } finally {
    cleanup();
  }
});

test('a running workflow cannot be edited or deleted', async () => {
  const { service, cleanup } = makeService();
  try {
    const { workflow } = await service.create({ name: 'Busy', steps: [click('a')] });
    service.inUseProvider = () => workflow.id;
    await assert.rejects(service.update(workflow.id, { name: 'x' }), (e) => e.code === 'workflow_in_use');
    await assert.rejects(service.remove(workflow.id), (e) => e.code === 'workflow_in_use');
    service.inUseProvider = () => null;
    await service.remove(workflow.id);
  } finally {
    cleanup();
  }
});

test('export then import round-trips and never overwrites an existing workflow', async () => {
  const { service, cleanup } = makeService();
  try {
    const { workflow } = await service.create({ name: 'Round', steps: [click('a'), click('b', '#b', { screenshot: true })] });
    const doc = service.export(workflow.id);
    assert.equal(doc.format, 'cloud-screenshot-service/workflow');
    assert.equal(doc.schemaVersion, 1);
    const imported = await service.importDocument(JSON.parse(JSON.stringify(doc)));
    assert.notEqual(imported.workflow.id, workflow.id, 'imports always get a fresh id');
    assert.equal(imported.workflow.name, 'Round (2)');
    assert.equal(imported.renamed, true);
    assert.equal(imported.workflow.steps.length, 2);
    assert.equal(imported.workflow.steps[1].screenshot, true);
    assert.notEqual(imported.workflow.steps[0].id, workflow.steps[0].id, 'step ids are regenerated');
    assert.equal(service.list().length, 2);
    await assert.rejects(service.importDocument(doc, { onConflict: 'reject' }), (e) => e.code === 'workflow_name_taken');
    const bare = await service.importDocument({ name: 'Bare', steps: [click('x')] });
    assert.equal(bare.workflow.name, 'Bare', 'a bare workflow object is also accepted');
  } finally {
    cleanup();
  }
});

test('import validates everything and refuses hostile or malformed documents', async () => {
  const { service, cleanup } = makeService();
  try {
    const bad = [
      null, 'text', 42, [], {},
      { format: 'something-else', workflow: { name: 'x' } },
      { workflow: { name: 'x', steps: [{ name: 'a', action: 'eval', script: 'process.exit()' }] } },
      { name: 'x', __proto__: { polluted: true }, steps: [{ name: 'a', action: 'click', target: { strategy: 'css', selector: 'a >> js=1' } }] },
      { name: 'x', schemaVersion: 99, steps: [] },
    ];
    for (const doc of bad) {
      await assert.rejects(service.importDocument(doc), (e) => ['invalid_workflow', 'import_too_large'].includes(e.code), JSON.stringify(doc)?.slice(0, 80));
    }
    await assert.rejects(service.importDocument({ name: 'big', description: 'x'.repeat(600 * 1024), steps: [] }), (e) => ['import_too_large', 'invalid_workflow'].includes(e.code));
    assert.equal(Object.prototype.polluted, undefined, 'no prototype pollution');
    assert.equal(service.list().length, 0, 'nothing was stored by the failed imports');
  } finally {
    cleanup();
  }
});

test('import strips destructive permission so it must be granted again deliberately', async () => {
  const { service, cleanup } = makeService();
  try {
    const out = await service.importDocument({ name: 'Danger', steps: [click('Delete', '#del', { allowDestructive: true }), click('Safe', '#ok')] });
    assert.equal(out.workflow.steps[0].allowDestructive, false);
    assert.ok(out.warnings.some((w) => /Destructive-action permission was removed/.test(w)));
  } finally {
    cleanup();
  }
});

test('validateForRun rejects disabled workflows and workflows without enabled steps', async () => {
  const { service, cleanup } = makeService();
  try {
    const off = await service.create({ name: 'Off', enabled: false, steps: [click('a')] });
    await assert.rejects(async () => service.validateForRun(off.workflow.id), (e) => e.code === 'workflow_disabled');
    const none = await service.create({ name: 'None', steps: [click('a', '#a', { enabled: false })] });
    await assert.rejects(async () => service.validateForRun(none.workflow.id), (e) => e.code === 'no_enabled_steps');
    const ok = await service.create({ name: 'Ok', steps: [click('a')] });
    assert.equal(service.validateForRun(ok.workflow.id).steps.length, 1);
  } finally {
    cleanup();
  }
});

test('lintWorkflow warns about fragile locators and destructive permission', () => {
  const wf = validateWorkflowInput({ name: 'L', steps: [{ name: 'x', action: 'click', target: { strategy: 'xpath', selector: '//a' } }, click('d', '#d', { allowDestructive: true })] });
  const warnings = lintWorkflow(wf);
  assert.ok(warnings.some((w) => /XPath/.test(w)));
  assert.ok(warnings.some((w) => /destructive/.test(w)));
  assert.ok(lintWorkflow({ steps: [] }).some((w) => /no enabled steps/.test(w)));
});
