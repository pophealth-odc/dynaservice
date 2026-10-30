'use strict';

const express = require('express');
const { err } = require('../errors');
const { sendOk } = require('../utils/http');
const { validateBody, validateQuery } = require('../middleware/validation.middleware');
const { bodies, queries } = require('../schemas');

module.exports = function workflowRoutes({ services }) {
  const router = express.Router();
  const { workflows, recorder } = services;

  router.get('/', (_req, res) => sendOk(res, { workflows: workflows.list() }));

  // Import must be declared before "/:id" so that "import" is not treated as an id.
  router.post('/import', validateQuery(queries.workflowImport), async (req, res) => {
    const result = await workflows.importDocument(req.body, { onConflict: req.validatedQuery.onConflict });
    sendOk(res, result, 201);
  });

  router.get('/:id', (req, res) => sendOk(res, { workflow: workflows.get(req.params.id) }));

  router.get('/:id/export', (req, res) => {
    const doc = workflows.export(req.params.id);
    const safeName = doc.workflow.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'workflow';
    res.set('Content-Disposition', `attachment; filename="${safeName}.workflow.json"`);
    res.set('Cache-Control', 'private, no-store');
    // The export document is returned as-is (not wrapped in the {ok,data} envelope) so it can be saved
    // to a file and imported again without modification.
    res.status(200).json(doc);
  });

  router.post('/', validateBody(bodies.workflow), async (req, res) => {
    sendOk(res, await workflows.create(req.body), 201);
  });

  router.put('/:id', validateBody(bodies.workflowUpdate), async (req, res) => {
    sendOk(res, await workflows.update(req.params.id, req.body));
  });

  router.delete('/:id', async (req, res) => sendOk(res, await workflows.remove(req.params.id)));

  router.post('/:id/duplicate', validateBody(bodies.workflowDuplicate), async (req, res) => {
    sendOk(res, await workflows.duplicate(req.params.id, req.body.name), 201);
  });

  router.post('/:id/reorder', validateBody(bodies.workflowReorder), async (req, res) => {
    sendOk(res, await workflows.reorder(req.params.id, req.body.order));
  });

  // Add one step, either given explicitly or built from the element the recorder currently has selected.
  router.post('/:id/steps', validateBody(bodies.workflowAddStep), async (req, res) => {
    const { step, fromSelection, name, index, screenshot, clearSelection } = req.body;
    if (!step && !fromSelection) {
      throw err.unprocessable('invalid_request', 'Provide either "step" or fromSelection=true.');
    }
    if (step && fromSelection) {
      throw err.unprocessable('invalid_request', 'Provide either "step" or fromSelection, not both.');
    }
    let newStep = step;
    if (fromSelection) {
      const selection = recorder.requireSelection();
      if (!selection.suggestedStep) {
        throw err.unprocessable('selection_not_unique', 'The selected element has no unique locator and cannot be saved as a step.', {
          details: { message: selection.locators.message },
          hint: 'Select a more specific element, or build the step manually with a locator that includes a parent or an index.',
        });
      }
      newStep = { ...selection.suggestedStep };
      if (name) newStep.name = name;
      if (screenshot !== undefined) newStep.screenshot = screenshot;
      // A recorded step never inherits permission for destructive clicks; an editor must grant it deliberately.
      newStep.allowDestructive = false;
    }
    const result = await workflows.addStep(req.params.id, newStep, index);
    if (fromSelection && clearSelection) await recorder.clearSelection();
    sendOk(res, { ...result, selectionId: fromSelection ? recorder.getSelection()?.id ?? null : null }, 201);
  });

  return router;
};
