# Integrating the GitHub Pages dashboard

The dashboard is a separate static site. It talks to this service over HTTPS with the **same routes and the same bearer token as the
built-in test console** (`/api/test`), so you can develop it against the console's behaviour. Nothing in the backend needs to change
when the dashboard is connected.

> All snippets are plain browser JavaScript (no framework). They show the intended calls; adapt them to your UI code.
> The test console's source — [src/testing/test.js](../src/testing/test.js) — is a working reference for every pattern here and is
> exercised by the test suite.

## 1. Service URL and token

Ask the user for two values and keep them **in memory**, or in `sessionStorage` if you accept the trade-off that anything in browser
storage can be read by script running on that origin. Do not put the token in a URL, a query string, or a link.

```js
const state = { base: 'https://YOUR-SERVICE.onrender.com', token: null };

async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(state.base + path, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (raw) { if (!res.ok) throw await asError(res); return res; }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), json?.error);
  return json.data;
}
```

**CORS:** the service allows exactly the origin set in `DASHBOARD_ORIGIN` (scheme + host + port, no path). A project site at
`https://user.github.io/my-dashboard/` has the origin `https://user.github.io`. Cookies are not used, so use `credentials: 'omit'`.
Readable response headers include `Content-Disposition`, `ETag`, `X-Screenshot-Sha256`, `X-Viewport-Width/Height`, `X-Export-Count`.

## 2. Connect and check the service

```js
state.token = tokenFromInput;
const status = await api('GET', '/api/status');          // 401 if the token is wrong
// status: { status, version, uptimeSeconds, restartId, browser:{available,running,...}, currentUrl,
//           currentWorkflow, currentWorkflowStatus, memory, sessionId, login, previousRun, storage, ... }
```

`GET /api/status` *without* a token works too (liveness only) — useful to detect the service waking up before you ask for a token.

## 3. Cold starts (service waking up)

A sleeping free service answers the first request slowly (or the browser reports a network error / 502 from the platform). Show a
waiting state instead of an error, and retry with backoff:

```js
async function waitUntilAwake({ onWaiting, timeoutMs = 120000 }) {
  const end = Date.now() + timeoutMs;
  for (let delay = 2000; Date.now() < end; delay = Math.min(delay * 1.5, 8000)) {
    try {
      const r = await fetch(state.base + '/api/status', { cache: 'no-store' });
      if (r.ok) return (await r.json()).data;       // awake; data.restartId identifies this process
    } catch { /* network error while the instance boots */ }
    onWaiting?.();
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error('The service did not wake up in time.');
}
```

Compare `restartId` with the one you stored: if it changed, **the service restarted** — see section 12.

## 4. Launch Chromium, open the login page

```js
await api('POST', '/api/browser/launch', {});          // 503 insufficient_memory if the instance is too small right now
const login = await api('POST', '/api/login/open', {}); // opens DEFAULT_LOGIN_URL; or { url: '...' } to override
// login.state === 'waiting_for_login'
```

## 5. The remote browser (manual login, MFA)

Poll or refresh a screenshot, and translate clicks. Use `fetch` + `Blob` (the endpoint needs the header, so an `<img src>` will not work):

```js
let view = { vw: 0, vh: 0 };
async function refreshView(img) {
  const res = await api('GET', '/api/browser/screenshot?format=jpeg&quality=70', undefined, { raw: true });
  view.vw = +res.headers.get('X-Viewport-Width');
  view.vh = +res.headers.get('X-Viewport-Height');
  const old = img.src;
  img.src = URL.createObjectURL(await res.blob());
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
}

img.addEventListener('click', async (e) => {
  const r = img.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) * (view.vw / r.width));
  const y = Math.round((e.clientY - r.top)  * (view.vh / r.height));
  await api('POST', '/api/browser/click', { x, y });
  await refreshView(img);
});
// typing into the focused field (click the field first) — the text is sent once and never echoed back:
await api('POST', '/api/browser/type', { text: valueFromAPasswordInput, pressEnter: false });
await api('POST', '/api/browser/keypress', { key: 'Tab' });     // Enter, Tab, Escape, ArrowDown, F5, Control+A ...
await api('POST', '/api/browser/scroll', { deltaY: 600 });
await api('POST', '/api/browser/hover', { x, y });
```

- Use an `<input type="password">` for the text box and clear it right after sending. Never log what the user typed.
- Refresh the view after each action; a gentle interval (1–2 s) is fine while the user is interacting, but stop it when the tab is hidden.
- While a workflow runs, interaction calls return `409 automation_running`; the live view (`GET /browser/screenshot`) keeps working.

## 6. Confirm the login

When the user says they are signed in (after MFA), call:

```js
await api('POST', '/api/login/confirm', {});   // "I'm Logged In — Continue Automation"
```

This is an acknowledgement, not a verification. `GET /api/login/status` → `state` is `confirmed` and `eligibleForAutomation: true`.
It becomes `expired` or `lost` if the session ends; then automation pauses until the user signs in again and confirms.

## 7. Record elements

```js
await api('POST', '/api/recorder/start', {});
// show the remote view; the user hovers (send POST /browser/hover with the mapped coordinates, then refresh) and clicks.
// While recording, a click selects the element and the site's own click handlers do NOT run.
const { selection } = await api('GET', '/api/recorder/selected-element');
// selection.element {tag,id,classes,text,role,accessibleName,attributes,...}, selection.cssSelector, selection.xpath,
// selection.page {url,title}, selection.frame, selection.locators {unique, primary, fallbacks, candidates[]}, selection.warnings
await api('POST', '/api/recorder/stop', {});
```

- If `selection.locators.unique` is `false`, tell the user why (`selection.locators.message`) and ask them to select a more specific
  element — a step cannot be saved from it (`422 selection_not_unique`).
- Show `selection.warnings` (sensitive field, destructive-looking element, fragile position locator).
- Pointer-only: `POST /api/browser/click` while recording selects; `POST /api/recorder/select-element {x,y,activate:true}` selects **and**
  performs the click so the user can reach the next page and record the next step (refused for destructive-looking elements).

## 8. Create and manage workflows

```js
const { workflow } = await api('POST', '/api/workflows', { name: 'Dynatrace Dashboard Navigation', steps: [] });
await api('POST', `/api/workflows/${workflow.id}/steps`, { fromSelection: true, name: 'Open Problems', screenshot: true });
await api('PUT',  `/api/workflows/${workflow.id}`, { name: 'Renamed' });            // omitted fields keep their value
await api('PUT',  `/api/workflows/${workflow.id}`, { steps: editedSteps });         // edit / enable / disable steps
await api('POST', `/api/workflows/${workflow.id}/reorder`, { order: [stepId3, stepId1, stepId2] });
await api('POST', `/api/workflows/${workflow.id}/duplicate`, {});
await api('POST', '/api/automation/test-step', { workflowId: workflow.id, stepId });   // try one step on the current page
```

Workflows live in the service's temporary storage. **Export them and keep the JSON in the dashboard** (IndexedDB or a downloaded file):

```js
const doc = await (await api('GET', `/api/workflows/${id}/export`, undefined, { raw: true })).json();
await api('POST', '/api/workflows/import', doc);      // later, e.g. after a restart; gets a new id; ?onConflict=reject to refuse duplicates
```

## 9. Run, pause, resume

```js
await api('POST', '/api/automation/start', { workflowId, confirmDestructive: false });   // 202
await api('POST', '/api/automation/pause', {});            // takes effect after the current step
await api('POST', '/api/automation/resume', {});
await api('POST', '/api/automation/stop', {});
await api('POST', '/api/automation/restart', {});
await api('POST', '/api/automation/start', { workflowId, paused: true });   // step mode …
await api('POST', '/api/automation/execute-step', {});     // … run exactly the next step
await api('POST', '/api/automation/skip-step', {});
const s = await api('GET', '/api/automation/status');       // use s.controls to enable/disable your buttons
```

If `s.run.loginRequired` is true, send the user back to the remote view, then `login/confirm`, then `resume`.

## 10. Receiving live events

`EventSource` cannot send an `Authorization` header, so read the stream with `fetch`. Reconnect with `Last-Event-ID` to replay what you missed.

```js
async function connectEvents(onEvent, signal) {
  let lastId = null;
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const res = await fetch(state.base + '/api/events', {
        headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream', ...(lastId && { 'Last-Event-ID': lastId }) },
        signal, cache: 'no-store', credentials: 'omit',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const frames = buf.split('\n\n'); buf = frames.pop();
        for (const raw of frames) {
          const dataLines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
          if (!dataLines.length) continue;                      // comments / heartbeats
          const event = JSON.parse(dataLines.join('\n'));
          if (event.id && !event.id.endsWith(':0')) lastId = event.id;   // ':0' frames are not replayable
          onEvent(event);
        }
      }
    } catch (e) { if (signal.aborted) return; }
    await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 20000)));   // the service may be asleep or restarting
  }
}
```

- The first event, `service.connected`, carries `data.snapshot` (browser, login, recorder, automation, screenshots, restart info) — use it to redraw
  your UI without extra requests.
- If the service restarted since your `lastId`, you also get `service.restarted` (see section 12) instead of a replay.
- Each event has `type`, `timestamp`, `description`, `workflowId`, `workflowName`, `currentStep`, `totalSteps`, `completedSteps`,
  `failedSteps`, `progress`, `currentUrl`. Progress reflects real step results; do not animate it yourself.
- A heartbeat comment (`: heartbeat`) arrives every ~25 s so intermediaries do not drop an idle stream. It is not a wake-up mechanism.

## 11. Download screenshots and keep them in IndexedDB

The service keeps screenshots only temporarily. When `screenshot.saved` arrives, fetch the file, **verify it**, store it, then (optionally) tell the
service it may free the space:

```js
async function transfer(meta, db) {
  // meta comes from the event (data.screenshot) or GET /api/screenshots
  const res = await api('GET', `/api/screenshots/${meta.id}/download`, undefined, { raw: true });
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (digest !== meta.sha256 || bytes.length !== meta.sizeBytes) throw new Error('Corrupt transfer; retry');
  await db.put('screenshots', { ...meta, blob });                 // IndexedDB (e.g. via the "idb" library)
}
```

- **Interrupted transfer:** repeat the request with `Range: bytes=<received>-` (the service answers `206`) and append, then verify the SHA-256.
  A screenshot counts as `transferred` on the service only when the whole body was sent.
- **Gone:** `404 screenshot_not_found` / `410 screenshot_file_missing` mean the service lost it (restart or eviction). If you already stored it, nothing
  is lost; otherwise capture again.
- Previews: `GET /api/screenshots/{id}?view=image` (inline).
- To free space after you saved a file: `DELETE /api/screenshots/{id}` (or `DELETE /api/screenshots?transferredOnly=true`).
- Eviction warning: the `screenshot.evicted` event says older screenshots were removed to stay within `MAX_SCREENSHOTS` / `MAX_SCREENSHOT_MB`.

## 12. Export

```js
const zip = await api('GET', '/api/screenshots/export', undefined, { raw: true });           // everything, plus manifest.json
const some = await api('POST', '/api/screenshots/export', { ids: [id1, id2] }, { raw: true }); // selected
saveBlob(await zip.blob(), (/filename="([^"]+)"/.exec(zip.headers.get('Content-Disposition')) || [])[1] || 'screenshots.zip');
```

Dashboard-side exports (from IndexedDB) are independent of the service and keep working when it is asleep.

## 13. Service restarts and lost browser sessions

Treat these as normal on Render Free. Signals, any of which means "log in again":

| Signal | Meaning | What to show / do |
|---|---|---|
| `restartId` in `/api/status` differs from the one you stored | The service restarted (deploy, crash, wake-up from sleep with a new instance) | "The service restarted. The browser session was lost." Reset your UI state; re-import workflows from your saved JSON; ask for login again. |
| `service.restarted` event after reconnecting | Same | Same |
| `workflow.interrupted` event, or `automation.interruptedRun` / `status.previousRun` | A run was in progress when the previous process died | "Automation was interrupted. Log in again and start it again." Acknowledge with `POST /api/automation/stop`. |
| `browser.disconnected` / `session.expired` events; `login.state` = `lost` | Chromium closed or crashed | Offer *Launch browser → Open login page*. |
| `409 browser_not_running` on any browser call | No browser (never launched, or lost) | Same |
| Automation `paused` with `loginRequired: true` (`session_expired`, `session_lost`) | The site logged you out, or the browser was lost mid-run | Send the user to the remote view, `login/confirm`, then `resume`. |
| `409 login_required` when starting | The login was not confirmed for the current browser | Run the login steps first. |
| `404 workflow_not_found` for an id you know | Workflows were wiped | Re-import from your stored export. |

A robust dashboard re-synchronises from `service.connected`'s snapshot (or `GET /status`, `/login/status`, `/automation/status`) every time it
(re)connects, rather than assuming its last known state is still true.
