# Manual end-to-end testing guide

This walks through the whole product by hand using only the built-in test console, with **no dashboard**. It uses the bundled
demo website first (always available, no account needed), then your real target site.

You need: the service URL (`http://localhost:3000` locally, or `https://YOUR-SERVICE.onrender.com`) and the `API_TOKEN`.

> Automated equivalents: `npm test`, `npm run test:integration`, `npm run test:browser`, and the console's own **Run All Tests**.
> This guide is for a human confirming the behaviour with their eyes, especially on Render.

## A. Connect and check health

1. Open `<service>/api/test`. If the service was asleep, wait for the *Waking up…* badge to clear (up to ~1 minute on Render Free).
2. Paste the token → **Connect**. Expect the badge to turn **Connected** and the token field to disappear.
   - A wrong token must leave it **Disconnected** with a message.
3. **Health** tab: *Service status* `ok`, *Browser available* `true`, memory shows a limit (≈512 MB on Render Free).
4. **Events** tab: state is **live**; you should already see `service.connected`.

## B. Browser and remote control (demo site)

1. **Browser & Remote** → **Launch Chromium**. Expect a `browser.ready` event and *Browser state: ready*.
2. **Open demo site**. The remote view shows a "Sign in" page. *Current URL* ends in `/api/test/fixture/`.
3. Click the **username field** in the image. The coordinate line under the image shows both the displayed point and the real browser
   point (e.g. `Displayed 412,260 → browser 960,402 (scale ×2.33)`) — this proves the conversion is applied.
4. Try **Hover**, **Scroll**, a **key** (Tab), **Reload page**. The image should change accordingly.

## C. Manual login and MFA (demo site)

The demo accepts any username, the password `demo`, then any six digits.

1. **Login** tab → **Open Login Page**, enter the demo URL when asked, or use the *Open demo site* button first. State becomes
   *waiting_for_login*.
2. In **Browser & Remote**: click the username field, type `tester` in the *Type* box → **Type**; press **Tab**; type `demo` → **Type** + tick *press Enter after*.
3. The page asks for a one-time code: click the code field, type `123456` with *press Enter after*.
4. You should land on **Problems**. **Check that your password and code do not appear anywhere**: not in the Events table, the
   *Last API response* box, or the service logs (Render → Logs).
5. **Login** tab → **I'm Logged In — Continue Automation**. *Eligible for automation* becomes `true`.
6. Negative checks: **Cancel Login** then try to confirm → refused. Start a workflow before confirming → `409 login_required`.

## D. Record elements

1. **Recorder** → **Start Recording**. Status shows `ACTIVE`.
2. In **Browser & Remote**, move over the nav (the image refreshes while you hover): an **orange border and tooltip** appear around the
   element under the pointer. Switch the radio to *Click* and click **Services**.
3. The page must **not** navigate (recording blocks the site's own action). The **Recorder** tab shows the full metadata: tag, id,
   classes, text, role, accessible name, CSS selector, XPath, page URL/title, frame, and the locator candidates with their match counts.
4. Click one of the identical **Open** buttons in the Problems table: expect *Locator unique: yes* with a **position-based** primary
   locator and a warning about fragility, while the role/text candidates show `matches` greater than 1 (ambiguous, rejected).
5. Click **Delete all reports** on the Reports page: the warnings must say it looks destructive.
6. Click the password field: it must be marked **sensitive**, with no name/placeholder-based locators.
7. **Stop Recording**. The highlight disappears; clicking links works normally again.

## E. Build, edit and run a workflow

1. **Workflows** → **Create Sample Workflow** (3 steps: Problems → Services → a service). It appears in the list.
2. Select a step and press **Disable**, then **Enable**; use **↑ / ↓** to reorder and undo it; **Rename**; **Duplicate**; **Export JSON**
   (a file downloads); **Delete** the duplicate; **Import Workflow JSON** with the exported file (it comes back with a new name/id).
3. Make sure you are logged in to the demo site and on *Problems*. **Start Workflow**.
   - The progress bar, *Step* and the per-step list update **from real events** (watch the Events tab: `step.started`,
     `screenshot.saved`, `step.completed`, `workflow.completed`).
4. **Screenshots** tab: three thumbnails named like `Demo_Navigation_Open_Services_<date>_<time>.png` with workflow/step/URL/time.
5. Use **Start Paused (step mode)** → **Execute Current Step** (one step runs, then it waits) → **Skip Current Step** → **Resume**.
6. Start again and press **Pause** while a step runs: it finishes the step, then shows *paused*; **Resume** continues from the next step
   (no repeated screenshots). **Stop** during a run: the current action is cancelled and nothing new starts. **Restart** begins at step 1.
7. Select a step in the list and press **Test Selected Step** to run just it against the current page.

## F. Screenshots

1. **Preview** a thumbnail; **Download** it (open it: it should be the page you captured).
2. **Capture Screenshot** manually; **Export All as ZIP** → the archive has every image and a `manifest.json`.
3. **Delete** one; **Clear Screenshots**. The list empties.

## G. Safety checks

1. Open the demo **Reports** page, record a step on **Delete all reports**, and run it: it fails with `destructive_action_blocked` and
   the button is **not** clicked. (Enabling it needs `allowDestructive` on the step *and* the *confirm destructive actions* tick.)
2. Try opening `file:///etc/passwd` or `http://169.254.169.254/` with **Open Website**: refused with a clear error.
3. Call any endpoint without the token (e.g. `curl <service>/api/workflows`): `401`.

## H. Resilience (this is the Render-specific part)

1. **Browser killed.** With a confirmed login, in Render's shell or locally kill the Chromium process (or use *Close Browser*).
   Expect `browser.disconnected` / `session.expired`, *Login state: lost*, and an attempt to start automation refused. **Launch** and log in again.
2. **Service restart.** Start a workflow with slow steps (set a step delay of 20000), then in Render press **Manual Deploy → Restart** (or
   Suspend/Resume). After the service is back and the console reconnects:
   - the **Events** tab shows `service.restarted` and `workflow.interrupted`,
   - a banner says the run was interrupted and the session lost,
   - **Browser** is not running, **workflows and screenshots are gone** on Render Free (re-import your exported JSON),
   - **Login** is `idle`; automation is `interrupted` until you press **Stop** to acknowledge.
3. **Sleep and wake.** Leave the service idle until it spins down (Render's free-tier timing), then reload the console. The first request
   shows *Waking up…* and then succeeds; the events stream reconnects by itself.
4. **Authentication expiry.** On the demo site, in the remote browser, open the page and run a workflow whose later step needs a session
   after you log out (press **Log out** in the remote view mid-run). The run **pauses** with a "log in again" message instead of failing.
   Log in, **Confirm**, **Resume**: it continues.
5. **Memory.** Launch with the default 1920×1080 viewport on Render Free and run the full workflow. If Chromium cannot start you get
   `503 insufficient_memory` (not a crash). Lower the viewport with `PUT /api/settings` and retry.

## I. Your real site (Dynatrace)

1. **Login** → **Open Login Page** (opens `https://aaj23525.apps.dynatrace.com/`, the default `DEFAULT_LOGIN_URL`).
2. Complete your real sign-in and MFA through the remote view, then **I'm Logged In — Continue Automation**.
3. Record: **Recorder → Start Recording** → click **Problems** in the remote view → **Save as workflow step** (choose the workflow).
   To move on to the next page while recording, tick **select & continue** on the Recorder tab: the next click selects the element
   *and* performs it, then recording carries on at the new page (it never clicks delete/pay/log-out style elements). Repeat for each item.
4. Run it and review the screenshots.

> Not verified: behaviour against Dynatrace itself, Render's sleep/wake timing, or memory use on a real 512 MB instance. Those need
> your account and deployment; steps H and I are how you confirm them.

## J. Record your result

**Test results → Export Results as JSON** saves the console's pass/fail list with timings, which is a convenient record of a run.
