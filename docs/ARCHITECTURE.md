# Architecture

## Process model

One Node.js process (Express 5). It owns **at most one** Chromium process, one browser context and one page. State is held in
memory; the temporary directory holds screenshots, workflow files and two small marker files so a *later* process can tell
what its predecessor was doing.

```
server.js            config check → createContainer → init → listen → graceful shutdown (SIGTERM)
src/container.js     builds and wires every service; init() restores what is on disk
src/app.js           Express: headers, CSP per area, CORS, rate limits, auth, routers, error handler
src/routes/*         thin HTTP layer: validate → call a service → { ok, data } envelope
src/services/*       business logic (below)
src/automation/*     browser-side picker, locator builder, waits, safety rules, step runner
src/schemas.js       request JSON Schemas, shared by validation AND the OpenAPI document
src/openapi.js       OpenAPI 3.1 document (tests fail if it drifts from the routes)
src/testing/*        the /api/test console and the demo "fixture" site
```

## Services

| Service | Responsibility |
|---|---|
| `EventService` | Publishes real events to SSE clients; bounded replay buffer; `restartId`; connect snapshot. |
| `StorageService` | Directory layout, detects the previous process, marks an interrupted run, cleans stale temp files. |
| `SettingsStore` | Runtime-adjustable settings with validation. |
| `BrowserService` | Chromium lifecycle, single context/page, crash/disconnect detection, request guard (SSRF), dialogs dismissed, downloads off. |
| `RemoteBrowserService` | Coordinate click/hover, type, keys, scroll, refresh, live view. Serialised by a lock. |
| `LoginService` | State machine `idle → waiting_for_login → confirmed` (+ `cancelled`, `expired`, `lost`). |
| `RecorderService` | Arms the in-page picker, hit-tests through frames/shadow roots, builds and validates locators. |
| `WorkflowService` | CRUD, strict validation, import/export, reorder, duplicate. |
| `AutomationService` | The run state machine: start/pause/resume/stop/restart/execute/skip/test. |
| `NavigationRunner` | Executes one step: resolve target, safety check, act, wait, delay, screenshot. |
| `ScreenshotService` | Capture, metadata, eviction, download with Range, ZIP, reconcile. |

## Run state machine

```
            start                    pause (at a checkpoint)
   idle ───────────▶ running ◀───────────────────────────────┐
                      │  │                                    │
        step fails    │  │ session lost / login expired       │ resume
                      ▼  ▼                                    │
                    failed   paused ──────────────────────────┘
                      │         │
              resume (retry)  skip / execute-step (one step, then paused again)
                      │
   running ──all steps done──▶ completed        any open state ──stop──▶ stopping ──▶ stopped
```

- A **session loss or expired login pauses** the run (the interrupted step stays `pending`, so resuming retries it) instead of
  failing it. Resuming requires a *fresh* login confirmation.
- A **step failure** stops on that step as `failed`; `resume` retries it.
- `pause` is honoured *between* steps, so a step is never torn in half. `stop` aborts the step in flight (an `AbortSignal`
  threaded through every wait) and the loop checks the stop flag before scheduling anything.
- Screenshots are keyed by `(runId, stepId)`; a retried or resumed step reuses its existing image, so nothing is captured twice.

## What survives what

| | Same process | Restart / redeploy (fresh disk) | Restart (disk survived) |
|---|---|---|---|
| Browser session, login | yes | **no** | **no** |
| Run state | yes | **no** | **no** — reported as `interrupted` |
| Workflows | yes | **no** | yes (reloaded) |
| Screenshots | yes | **no** | yes, marked `recoveredFromPreviousProcess` |
| Settings changed at runtime | yes | **no** (env defaults) | yes |

On Render Free the disk does **not** survive, so the right-hand column mostly matters for local development. The service
never claims more than the left column. A new process writes `runtime/instance.json`; if `runtime/active-run.json` shows a
running run, the new process exposes it as `interruptedRun`, emits `workflow.interrupted`, and includes it in the snapshot of every new
event stream until acknowledged (`POST /api/automation/stop`).

## Security model

- **Auth:** bearer token, constant-time comparison, header only. Brute-force limiter on failures.
- **Origin:** exact allowlist (`DASHBOARD_ORIGIN`) + same-origin for the console. Everything else → 403, including preflights.
- **Browser egress:** only `http(s)`; hosts that are loopback, private, link-local or internal-looking are refused for navigations,
  and a context-level route aborts the same hosts for requests made by pages. One narrow exception: this service's own
  `127.0.0.1:<port>/api/test/fixture/` demo site.
- **No credential handling:** typed text is passed to Playwright and dropped; logger redacts sensitive keys; URLs are sanitised
  (credentials, `token`/`code`/`state`/`session` values removed) before they are logged or returned; cookies are never read.
- **Input:** JSON Schema validation with `additionalProperties: false` everywhere, 600 KB body limit, locator specs reject engine
  chaining (`>>`, `internal:`, `js=`). No endpoint evaluates caller-supplied script. File names come from sanitised parts and ids
  are UUID-checked; `safeJoin` refuses anything that escapes the directory.
- **Automation safety:** only configured clicks; destructive-looking clicks need `allowDestructive` on the step **and**
  `confirmDestructive` on the run; imports strip `allowDestructive`; JS dialogs are dismissed, downloads are disabled.
- **Headers/CSP:** `default-src 'none'` for the API; the console allows only its own scripts/styles; Swagger gets the minimum it needs.

## Why these choices

- *Screenshot + coordinates instead of a remote desktop:* a VNC/WebRTC viewer would need a display server and much more
  memory than a 512 MB instance has. A JPEG per interaction is cheap and works through any proxy.
- *SSE over `fetch`, not `EventSource`:* `EventSource` cannot send an `Authorization` header, and the token must not be in a URL.
- *Polling waits:* single-page apps change the URL and the DOM without a load event; polling the URL/element/DOM-quiet state
  is the only approach that covers both.
- *One browser session:* it is what fits the memory budget, and it removes a class of concurrency problems.
