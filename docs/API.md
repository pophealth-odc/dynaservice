# API reference

Interactive documentation with request/response examples for every operation: **`/api/docs`** (Swagger UI) and
**`/api/docs/openapi.json`**. This page covers the conventions that apply everywhere.

Base URL: `https://YOUR-SERVICE.onrender.com` (all paths below start with `/api`).

## Conventions

**Authentication** — `Authorization: Bearer <API_TOKEN>` on everything except `GET /api/status`, `/api/docs` and `/api/test`.
The token is never read from a URL or body.

**Success** — `{ "ok": true, "data": { ... } }`. Exceptions that return a raw payload: image/ZIP/file downloads, the SSE stream, and
`GET /api/workflows/{id}/export` (a bare document that can be saved and re-imported).

**Errors** — always `{ "ok": false, "error": { "code", "message", "status", "requestId", "details?", "hint?" } }`.
Switch on `error.code` (stable); show `message` and `hint` to people. `requestId` is also in the `X-Request-Id` header.

| Status | Meaning | Typical codes |
|---|---|---|
| 400 | Malformed input | `invalid_json`, `invalid_id`, `invalid_url`, `invalid_url_scheme`, `url_not_allowed`, `unsupported_media_type` |
| 401 | Missing/invalid token | `missing_token`, `invalid_token` |
| 403 | Forbidden | `origin_not_allowed`, `destructive_action_blocked` |
| 404 | Not found | `workflow_not_found`, `screenshot_not_found`, `element_not_found`, `no_selection`, `route_not_found` |
| 409 | Wrong state | `browser_not_running`, `login_required`, `login_not_confirmed`, `session_expired`, `session_lost`, `automation_running`, `automation_active`, `recorder_active`, `workflow_in_use`, `workflow_name_taken` |
| 410 | Gone | `screenshot_file_missing` |
| 413 | Body too large | `payload_too_large` |
| 422 | Validation failed | `invalid_request` (+ `details.problems[{path,message}]`), `invalid_workflow`, `element_ambiguous`, `element_not_visible`, `element_not_interactable`, `invalid_key`, `coordinates_out_of_range` |
| 429 | Rate limited | `rate_limited`, `too_many_auth_failures`, `too_many_event_streams` |
| 500 | Server error | `internal_error`, `browser_launch_failed`, `browser_error` |
| 502/504 | The target website | `navigation_failed`, `navigation_timeout` |
| 503 | Browser unavailable | `insufficient_memory`, `browser_not_installed` |

**Content type** — send `Content-Type: application/json` for bodies. Unknown properties are rejected (`422`).

**Limits** — body ≤ 600 KB; 600 requests/min per address (`RATE_LIMIT_PER_MINUTE`); 30 failed authentications per 15 min per address;
10 concurrent event streams (`SSE_MAX_CLIENTS`).

## Endpoint overview

| Area | Endpoints |
|---|---|
| Service | `GET /status` |
| Browser | `POST /browser/launch` · `POST /browser/close` · `GET /browser/status` · `POST /browser/open-url` · `GET /browser/screenshot` |
| Remote interaction | `POST /browser/click` · `/hover` · `/type` · `/keypress` · `/scroll` · `/refresh` |
| Login | `POST /login/open` · `POST /login/confirm` · `POST /login/cancel` · `GET /login/status` |
| Recorder | `POST /recorder/start` · `/stop` · `GET /recorder/status` · `GET /recorder/selected-element` · `POST /recorder/select-element` · `/clear-selection` · `/check-locator` |
| Workflows | `GET/POST /workflows` · `GET/PUT/DELETE /workflows/{id}` · `POST /workflows/import` · `GET /workflows/{id}/export` · `POST /workflows/{id}/duplicate` · `/reorder` · `/steps` |
| Automation | `POST /automation/start` · `/pause` · `/resume` · `/stop` · `/restart` · `/execute-step` · `/skip-step` · `/test-step` · `GET /automation/status` |
| Screenshots | `GET/POST /screenshots` · `GET/DELETE /screenshots/{id}` · `GET /screenshots/{id}/download` · `DELETE /screenshots` · `GET/POST /screenshots/export` |
| Settings | `GET/PUT /settings` · `POST /settings/reset` |
| Events | `GET /events` (SSE) |

## Remote view and coordinates

`GET /api/browser/screenshot` returns the live viewport (JPEG by default, `?format=png`, `?quality=`, or `?encoding=base64` for JSON).
Response headers `X-Viewport-Width` / `X-Viewport-Height` are the **real** browser viewport. If the image is displayed at a different
size, convert a click like this before calling `/browser/click`:

```js
const r = img.getBoundingClientRect();
const x = Math.round((event.clientX - r.left) * (viewportWidth  / r.width));
const y = Math.round((event.clientY - r.top)  * (viewportHeight / r.height));
```

Interaction endpoints reject requests with `409 automation_running` while a workflow is executing (pause or stop it first). They
return the new URL, never the typed text.

## Locators

A target is a JSON object; Playwright's locator API resolves it (nothing is evaluated as script):

```json
{ "strategy": "role", "role": "link", "name": "Problems",
  "fallbacks": [ { "strategy": "css", "selector": "[data-testid=\"nav-problems\"]" } ] }
```

`strategy` is `id | data | role | css | text | xpath`. Optional: `frames` (iframe selectors, outermost first), `index` (0-based, to pick
deliberately among several matches), `exact`. A locator must resolve to **exactly one** visible element, otherwise the step fails with
`element_ambiguous` / `element_not_visible` / `element_not_found`; fallbacks are tried in order.

URL patterns (`expectedUrl`, `wait.urlPattern`): `/regex/flags`, a glob (`*` within a path segment, `**` across), or plain text (substring).

## Workflow document

```json
{
  "name": "Dynatrace Dashboard Navigation",
  "description": "Open Problems, then Services.",
  "enabled": true,
  "steps": [
    { "name": "Open Problems", "action": "click",
      "target": { "strategy": "role", "role": "link", "name": "Problems" },
      "wait": { "condition": "page_ready" }, "screenshot": true },
    { "name": "Open Services", "action": "click",
      "target": { "strategy": "role", "role": "link", "name": "Services" },
      "wait": { "condition": "element_visible", "target": { "strategy": "css", "selector": "[data-testid=\"services-list\"]" } },
      "timeout": 20000, "delay": 2000, "screenshot": true }
  ]
}
```

`id`, `number`, timestamps are assigned by the service. `timeout` / `delay` fall back to `ELEMENT_TIMEOUT` / `ADDITIONAL_PAGE_DELAY` when omitted.

## Automation status

`GET /automation/status` → `state` (`idle | running | pausing | paused | stopping | stopped | completed | failed | interrupted`),
`run` (per-step statuses, counts, progress, `pauseReason`, `loginRequired`), `interruptedRun` (a run lost to a restart) and `controls`
(which of start/pause/resume/stop/restart/executeStep/skipStep/testStep are valid right now — use it to enable/disable buttons).

`pauseReason` values: `user`, `step_mode`, `session_expired`, `session_lost`, `browser_session_lost`, `browser_not_running`,
`login_required`, `login_not_confirmed`, `page_crashed`. When `loginRequired` is true, the user must log in through the remote browser
and confirm before `resume` will work.

## Events

See [DASHBOARD_INTEGRATION.md](DASHBOARD_INTEGRATION.md#receiving-live-events). Event types:

`service.connected` `service.restarted` `service.error` · `browser.starting` `browser.ready` `browser.disconnected` `browser.page_crashed`
`browser.page_recovered` · `login.page_opened` `login.waiting` `login.confirmed` `login.cancelled` `session.expired` · `recording.started`
`element.selected` `recording.stopped` · `workflow.started` `workflow.paused` `workflow.resumed` `workflow.stopped` `workflow.completed`
`workflow.interrupted` · `step.started` `step.waiting_for_element` `step.waiting_for_navigation` `step.completed` `step.failed` `step.skipped` ·
`screenshot.capturing` `screenshot.saved` `screenshot.transferred` `screenshot.evicted`.

Every event carries `id`, `type`, `timestamp`, `description`, `workflowId`, `workflowName`, `runId`, `currentStep`, `totalSteps`,
`completedSteps`, `failedSteps`, `progress` (0–100) and `currentUrl`; some add a `data` object. Progress is computed from real step
results.
