# Cloud Screenshot Automation Service

A Node.js + Express service that drives **headless Chromium (Playwright)** in the cloud so you can log in to a website
yourself (including MFA), record a navigation path by pointing at elements, replay it, and collect screenshots. It is
built for **Render Free Web Services** and is deployed from GitHub with Docker.

The service is independent of any frontend. It ships with its own **test console** (`/api/test`) and **Swagger UI**
(`/api/docs`), so you can exercise everything before a dashboard exists. A separate GitHub Pages dashboard can use the
same REST API later without any change to this repository.

> **Free-tier reality, in one paragraph.** Render Free spins the service down after inactivity, gives it 512 MB of RAM, and
> its filesystem is temporary. The browser session, your login, workflows, run state and screenshots can all disappear
> after a sleep, restart or redeploy. This service detects and *reports* those losses; it cannot prevent them.
> Download or export whatever you want to keep. See [Render Free limitations](#render-free-limitations).

---

## Contents

1. [Architecture](#architecture)
2. [Technology stack](#technology-stack)
3. [Prerequisites](#prerequisites)
4. [Local installation and development](#local-installation-and-development)
5. [Environment configuration](#environment-configuration)
6. [Docker](#docker)
7. [Deploy to Render](#deploy-to-render)
8. [API authentication](#api-authentication)
9. [Standalone backend testing](#standalone-backend-testing)
10. [Swagger documentation](#swagger-documentation)
11. [How the automation works](#how-the-automation-works) — browser, manual login/MFA, recording, workflows, screenshots
12. [Dashboard integration](#dashboard-integration)
13. [Render Free limitations](#render-free-limitations)
14. [Testing](#testing)
15. [Troubleshooting](#troubleshooting)

More detail: [docs/API.md](docs/API.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md) · [docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md) ·
[docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md)

---

## Architecture

```
GitHub repository ──push──▶ Render (auto deploy, Docker)
                                   │
                    ┌──────────────▼───────────────────────────────────────────┐
                    │  Render Free Web Service  (one container, 512 MB)        │
                    │                                                          │
                    │  Express ─ REST API ─ SSE events ─ Swagger ─ Test console│
                    │     │                                                    │
                    │     ├─ BrowserService ──▶ headless Chromium (Playwright) │
                    │     ├─ RemoteBrowserService   (screenshot + coordinates) │
                    │     ├─ LoginService           (manual login / MFA)       │
                    │     ├─ RecorderService        (element picker, locators) │
                    │     ├─ WorkflowService        (CRUD, import/export)      │
                    │     ├─ AutomationService      (run state machine)        │
                    │     └─ ScreenshotService      (temp files, ZIP, Range)   │
                    │                                                          │
                    │  /tmp/screenshot-automation/{screenshots,workflows,runtime}
                    └──────────────▲───────────────────────────────────────────┘
                                   │ HTTPS + Bearer token, Server-Sent Events
                    GitHub Pages dashboard (separate repo, optional)
                    └─ downloads screenshots, keeps them in IndexedDB
```

- **One browser session at a time.** A single Chromium, one context, one page. This is deliberate: it is what fits in 512 MB.
- **In-memory state + temporary files.** Nothing needs a database or a persistent disk.
- **The dashboard owns persistence.** The service keeps screenshots only until they are downloaded.

## Technology stack

Node.js 22+ · Express 5 · Playwright 1.64.1 (Chromium) · Docker (`mcr.microsoft.com/playwright:v1.64.1-noble`) ·
Server-Sent Events · Swagger UI / OpenAPI 3.1 · `yazl` for ZIP · Ajv for validation · `node:test` for tests ·
vanilla HTML/CSS/JS for the test console.

No Puppeteer, Selenium, Python, Edge extension, paid API, external database or cloud storage is used.

## Prerequisites

- Node.js **22 or newer** (`node -v`)
- Git
- For local browser features: Chromium for Playwright (`npm run install:browsers`, ~150 MB)
- Optional: Docker, to build the same image Render builds
- A GitHub account and a Render account (the free plan is enough)

## Local installation and development

```bash
git clone https://github.com/YOUR-USERNAME/cloud-screenshot-service.git
cd cloud-screenshot-service
npm install                 # installs dependencies
npm run install:browsers    # downloads Playwright's Chromium (local runs only; Docker has it)
cp .env.example .env        # then edit .env (see below)
npm run token               # prints a random token: paste it as API_TOKEN in .env
npm start                   # http://localhost:3000
```

Open <http://localhost:3000/api/test>, paste the token, and press **Connect**.

Notes for local runs:

- `npm run dev` restarts on file changes.
- `ALLOW_PRIVATE_URLS=true` lets the browser open `localhost` pages. **Never set it on a deployed service** — it switches off
  the protection that stops web pages from reaching internal addresses.
- On Windows, temporary files go to your `%TEMP%\screenshot-automation` folder.

## Environment configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_TOKEN` | **yes** | – | Bearer token for every protected endpoint. 24+ characters in production. Generate with `npm run token`. |
| `DASHBOARD_ORIGIN` | **yes** (for a dashboard) | – | Exact origin of the GitHub Pages dashboard, e.g. `https://YOUR-USERNAME.github.io`. A repo path is ignored. Comma-separate several. No wildcards. |
| `PORT` | no | `3000` | Render provides this automatically. |
| `NODE_ENV` | no | `development` | Use `production` on Render. |
| `DEFAULT_LOGIN_URL` | no | `https://aaj23525.apps.dynatrace.com/` | Where "Open Login Page" goes. Also changeable at runtime via `PUT /api/settings`. |
| `BROWSER_HEADLESS` | no | `true` | Keep `true` in the cloud. |
| `DEFAULT_VIEWPORT_WIDTH` / `_HEIGHT` | no | `1920` / `1080` | Browser viewport. |
| `NAVIGATION_TIMEOUT` | no | `30000` | ms to wait for a page to load. |
| `ELEMENT_TIMEOUT` | no | `15000` | ms to wait for an element. |
| `ADDITIONAL_PAGE_DELAY` | no | `5000` | ms to wait after each step before continuing. |
| `SCREENSHOT_DIR` | no | `/tmp/screenshot-automation/screenshots` | Where screenshots are stored (temporary). |
| `DATA_DIR` | no | `/tmp/screenshot-automation` | Parent of `screenshots/`, `workflows/`, `runtime/`. |
| `SCREENSHOT_FORMAT` / `_TYPE` / `_QUALITY` | no | `png` / `viewport` / `80` | `png`\|`jpeg`; `viewport`\|`fullPage`. |
| `MAX_SCREENSHOTS` / `MAX_SCREENSHOT_MB` | no | `200` / `200` | Storage budget; oldest are evicted, already-downloaded ones first. |
| `MIN_FREE_MEMORY_MB` | no | `150` | Refuse to launch Chromium with less free memory. |
| `BROWSER_LOW_MEMORY` | no | `true` on Render | Extra Chromium flags that save memory. |
| `SSE_MAX_CLIENTS` / `RATE_LIMIT_PER_MINUTE` | no | `10` / `600` | Protective limits. |
| `LOG_LEVEL` | no | `info` | `debug`\|`info`\|`warn`\|`error`\|`silent`. |
| `ALLOW_PRIVATE_URLS` | no | `false` | **Local development only.** |

The service refuses to start if `API_TOKEN` is missing, still a placeholder, or too short, and prints why (never the token).

**Which to set in Render:** `API_TOKEN` (use *Generate*), `DASHBOARD_ORIGIN`, and `NODE_ENV=production`. The rest have
sensible defaults; [render.yaml](render.yaml) lists them all.

## Docker

```bash
docker build -t cloud-screenshot-service .
docker run --rm --init -p 10000:10000 \
  -e API_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e DASHBOARD_ORIGIN=https://YOUR-USERNAME.github.io \
  cloud-screenshot-service
```

The image is `mcr.microsoft.com/playwright:v1.64.1-noble`: Chromium is already inside it, and the build **fails** if the npm
`playwright` version does not match that Chromium. When upgrading Playwright, change both `package.json` and the `FROM` tag.
The process runs as the non-root `pwuser`.

> **Verification status:** the Dockerfile's individual steps (production install, Chromium check, startup, health check) were
> exercised on a development machine, but `docker build` itself has **not** been run — Docker was not available where this
> was developed. Run the two commands above once before relying on it; any mismatch will show up at build time.

## Deploy to Render

Full walkthrough with screenshots-in-words: **[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md)**. Summary:

1. Push this repository to GitHub (private or public).
2. Render dashboard → **New + → Web Service** → connect the repository.
3. **Runtime: Docker**, **Instance type: Free**, **Health Check Path: `/api/status`**.
4. Environment: `API_TOKEN` = *Generate*, `DASHBOARD_ORIGIN` = `https://YOUR-USERNAME.github.io`, `NODE_ENV` = `production`.
5. **Create Web Service.** Auto-deploy on push is on by default.
6. Open `https://YOUR-SERVICE.onrender.com/api/test`, paste the token, **Connect**, **Run All Tests**.

Alternatively use **New + → Blueprint** with [render.yaml](render.yaml).

## API authentication

Every endpoint except `GET /api/status` (liveness only), the test console page and Swagger UI requires:

```
Authorization: Bearer <API_TOKEN>
```

- The token is accepted **only** in that header — never in the URL or body.
- It is compared in constant time, never logged and never returned by any endpoint or error.
- After 30 failed attempts from one address in 15 minutes, further attempts get `429`.
- Browsers may call the API only from the **same origin** (test console, Swagger) or from `DASHBOARD_ORIGIN`. Other origins get
  `403`, including for CORS preflights. Cookies are not used.

Rotate the token by changing `API_TOKEN` in Render (the service restarts).

## Standalone backend testing

`GET /api/test` serves a self-contained console (HTML + CSS + vanilla JS, no build step) that calls the **same production
API** the dashboard will use.

- Paste the token and **Connect**. It lives only in the page's JavaScript memory — not in `localStorage`, cookies, the URL or
  the page after you press Connect. **Disconnect / Clear token** removes it.
- Tabs: Health · Browser & Remote (click the screenshot to click in the cloud browser; type; keys; scroll) · Login ·
  Recorder · Workflows (create sample, import/export, start/pause/resume/stop/restart/execute/skip/test) · Screenshots
  (thumbnails, download, ZIP, delete) · live Events · Test results.
- **Run All Tests** runs 14 real tests against the built-in demo website (`/api/test/fixture/`) — login with MFA, recording,
  a 3-step workflow, pause/skip/stop, downloads, ZIP. A test is *Passed* only if the real operation succeeded. Results can be
  exported as JSON.
- If the service is asleep, the first request can take up to a minute; the console shows a **Waking up…** badge instead of
  failing, and reconnects its event stream automatically.

Step-by-step manual checks: [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

## Swagger documentation

`GET /api/docs` — OpenAPI 3.1 for every endpoint (55 operations), with examples and error responses. Click **Authorize**,
paste the token, and use *Try it out*. The raw document is at `/api/docs/openapi.json`. A test fails the build if a route is
added without documenting it (and vice versa), and the documented request bodies are the very schemas the API validates with.

## How the automation works

### Browser

One headless Chromium, one context, one page (`POST /api/browser/launch`). Settings (viewport, timeouts, delay, screenshot
format/type, login URL) come from the environment and can be changed at runtime with `PUT /api/settings`. The service detects
Chromium dying, page crashes and disconnects; a crashed page is recreated on the next action. Launch is refused with `503`
when too little memory is free. Only `http(s)` URLs can be opened, and the browser cannot reach `localhost`/private networks
(blocked for navigations *and* for requests made by pages).

### Manual login and MFA

1. `POST /api/login/open` launches Chromium (if needed) and opens the configured login URL → state `waiting_for_login`.
2. You use the remote browser (click the screenshot, **type**, press keys) to enter your username, password and MFA code.
3. You press **I'm Logged In — Continue Automation** (`POST /api/login/confirm`).

Confirmation is **your acknowledgement**; the service cannot verify that authentication worked. It never fills in credentials,
and what you type is sent to the browser and forgotten: not logged, stored, returned or echoed. If a step later finds a
login form, or the browser session is lost, the run **pauses** and asks you to log in again.

### Recording navigation steps

`POST /api/recorder/start`, then in the remote view: hovering draws an orange border and tooltip in the page; clicking selects
the element **without triggering the site's own action**. You get the tag, id, classes, text, role, accessible name, stable
attributes, CSS selector, XPath, URL, title and frame details, plus locators tried in this order — **id → data attribute →
role + name → CSS → text → XPath** — each validated against the live page. If a locator matches several elements the response
says so and a unique one is chosen instead (or none, with an explanation). Save the selection as a step with
`POST /api/workflows/{id}/steps {"fromSelection": true}`.

Supported: open shadow DOM, same-origin and cross-origin-accessible iframes, dynamic ids/classes are ignored. Not possible:
**closed shadow roots, canvas content, and browser-native UI** (PDF viewer, native `<select>` popups, `chrome://` pages).
Password/one-time-code fields are recognised and their names/placeholders are withheld.

### Workflows

A workflow has an id, name, description, timestamps, enabled flag and ordered steps. A step has an id, number, name, action
(`click`, `wait_for_element`, `capture_screenshot`, `wait_for_navigation`), target locator (with optional fallbacks, index and
frame path), expected URL, wait condition (`page_ready`, `element_visible`, `element_hidden`, `url_matches`, `url_change`),
timeout, delay, screenshot flag and enabled flag. You can create, edit, rename, duplicate, delete, reorder, enable/disable,
test a single step, and import/export JSON (imports are fully validated, get new ids, and lose any destructive permission).

### Running

`POST /api/automation/start` (needs a running browser and a confirmed login). One run at a time; **pause** takes effect at the
next safe checkpoint (after the current step), **resume** continues with the first unfinished step, **stop** cancels the step in
flight and schedules nothing more, **restart** begins again, **execute-step** runs exactly one step, **skip-step** skips one.
Waits are polling-based on URL, element and DOM-quiet checks, so single-page apps that never reload work.

It only performs the configured clicks. A click that *looks* destructive (delete, pay, log out, submit …) is **refused** unless the
step has `allowDestructive: true` **and** the run was started with `confirmDestructive: true`.

### Screenshots

PNG viewport screenshots by default (JPEG and full-page optional). Files are named like
`Dynatrace_Dashboard_Navigation_Open_Problems_2026-10-30_130000.png` and stored under
`/tmp/screenshot-automation/screenshots/` with metadata (id, filename, source URL, page title, workflow, step number and name,
timestamp, format, size, SHA-256). List, preview, download (with `ETag`, checksum header and `Range` support so an interrupted
transfer can resume), delete, delete all, and export any selection as a ZIP with a `manifest.json`.

## Dashboard integration

See **[docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md)**: connecting, SSE over `fetch` (EventSource cannot send the
token), reconnect and replay, remote-view coordinate mapping, recording, running, downloading screenshots into IndexedDB with
checksum verification and resume, and handling cold starts, restarts and lost sessions.

## Render Free limitations

Documented as facts about the platform, not promises about this service:

- **Spin-down.** A free web service sleeps after a period without inbound traffic; the next request wakes it, taking from
  several seconds to about a minute. This service does **not** try to prevent that (no keep-alive pings), and the dashboard
  should show a waiting state.
- **Everything is lost on sleep, restart or redeploy:** the Chromium session (so your **login**), workflow run state,
  **workflows**, and **screenshots**. The service detects this and says so (`service.restarted`, `workflow.interrupted`,
  `interrupted` automation state, `410` for vanished files) — it cannot recover the browser session.
- **512 MB of RAM, shared CPU.** Chromium alone uses a large part of it. The service allows one browser session, uses
  low-memory flags, and refuses to launch (`503 insufficient_memory`) rather than crash. Prefer the default viewport or smaller,
  viewport screenshots over full-page, and few steps with moderate delays.
- **Long actions can be cut off** by a restart at any time; the dashboard should treat a run as best-effort.
- **No persistent disk is used or required.** The dashboard keeps what matters (IndexedDB, exported JSON).
- **Outbound access.** Login to sites that block datacenter IP addresses or that use bot protection / CAPTCHA may not work from a
  cloud browser. This service does not and will not try to bypass CAPTCHA or security controls.

Check Render's current plan limits and policies at <https://render.com/docs/free> — they change, and this file may lag.

## Testing

```bash
npm test                 # unit tests: pure logic, no browser, no network, no server
npm run test:integration # API tests against a real HTTP server with a fake browser; includes SSE, restart simulation, ZIP
npm run test:browser     # real Chromium against the built-in demo site (needs: npm run install:browsers)
npm run test:all
```

Coverage includes health, authentication, CORS, browser launch/status/navigation, the manual-login state machine, the recorder
and locator validation, workflow creation/validation/import/export, automation controls and pause/resume, screenshot capture/
download/ZIP, temporary-storage cleanup and eviction, service-restart handling, and error handling. The browser tests are
**skipped with an explicit message** (not silently passed) when Chromium is not installed.

Developer helpers in `scripts/` (each starts its own throw-away server; none contacts an external website):

| Script | What it checks |
|---|---|
| `node scripts/e2e-smoke.js` | A printed 23-step end-to-end walkthrough against real Chromium and the demo site. |
| `node scripts/console-check.js` | Drives the test console UI in a real browser: connect, token hygiene, SSE, **Run All Tests**, select & continue. |
| `node scripts/docs-check.js` | Swagger UI renders under its CSP, lists all operations, authorises and executes a call. |
| `node scripts/image-contents-check.js` | Without Docker: the files the Dockerfile copies are not excluded by `.dockerignore` and every `require()` resolves. |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Service won't start: `API_TOKEN is not set` / `placeholder` / `at least 24` | Set a real `API_TOKEN` (`npm run token`). |
| `401 invalid_token` | Wrong token, or the service was redeployed with a new one. Reconnect. |
| `403 origin_not_allowed` from the dashboard | `DASHBOARD_ORIGIN` must equal the dashboard's origin exactly (`https://user.github.io`, no path, `https`). |
| `429 too_many_auth_failures` | Too many wrong tokens; wait ~15 minutes. |
| First request very slow / times out | The free service was asleep. Wait and retry. |
| `503 insufficient_memory` on launch | Not enough free RAM. Close the browser, wait, try a smaller viewport. |
| `503 browser_not_installed` | Locally run `npm run install:browsers`. In Docker, the image tag and `playwright` version don't match. |
| `409 browser_not_running` | The browser was lost (restart/sleep/crash). Launch it and log in again. |
| `409 login_required` / run paused with "log in again" | Session expired or lost; log in through the remote view, confirm, then resume. |
| `422 element_ambiguous` | The locator matches several elements. Re-record, add a `data-testid` on the page, or set `index`. |
| `404 element_not_found` / `422 element_not_visible` | The page changed, is not the one the step expects, or the session expired. |
| `403 destructive_action_blocked` | The step looks destructive. See [Running](#running). |
| `410 screenshot_file_missing` | Temporary storage was reset. Capture again; download sooner. |
| Test console shows "Disconnected" right after Connect | The token was rejected (see `401`). |
| Event stream keeps reconnecting | The service is restarting or asleep; it resumes and replays by itself. |
| Dashboard cannot read the token-protected stream | Use `fetch()` streaming with the header, not `EventSource`. |
