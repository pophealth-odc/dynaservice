# Deploying to Render (Free) from GitHub

This is a step-by-step guide. It assumes you have never used Render. Render's screens change from time to time; if a label
below does not match exactly, look for the closest one. **Nothing in this guide has been executed against a live Render
account** — the service, its Dockerfile steps and its tests were verified on a development machine. The first deploy is
the real proof; the *Verify the deployment* section tells you exactly what to check.

## 0. What you will end up with

- A GitHub repository containing this project.
- A Render **Web Service** (Docker runtime, Free instance) that rebuilds every time you push to the connected branch.
- A secret `API_TOKEN` known only to Render and to you.
- A URL like `https://cloud-screenshot-service.onrender.com` serving the API, `/api/docs` and `/api/test`.

## 1. Put the code on GitHub

```bash
cd cloud-screenshot-service
git init                      # skip if this is already a repository
git add .
git status                    # check: .env must NOT be listed (it is git-ignored)
git commit -m "Cloud screenshot service"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/cloud-screenshot-service.git
git push -u origin main
```

A private repository works. Render asks for permission to read it during step 3.

> Never commit a real `API_TOKEN`. `.env` is in `.gitignore` and `.dockerignore`; `.env.example` contains only placeholders.

## 2. Generate a token (optional — Render can do it)

Render can generate the value for you (step 4). To make your own:

```bash
npm run token        # prints 64 hex characters
```

## 3. Create the Web Service

1. Sign in at <https://dashboard.render.com> (GitHub sign-in is easiest).
2. **New +** → **Web Service**.
3. **Build and deploy from a Git repository** → connect your GitHub account → pick `cloud-screenshot-service`.
4. Fill in:
   | Field | Value |
   |---|---|
   | Name | `cloud-screenshot-service` (becomes part of the URL) |
   | Region | the one closest to you (cannot be changed later) |
   | Branch | `main` |
   | **Runtime / Language** | **Docker** |
   | Dockerfile path | `./Dockerfile` (default) |
   | **Instance type** | **Free** |
5. Open **Advanced** and set **Health Check Path** to `/api/status`.

### Alternative: Blueprint

**New +** → **Blueprint** → select the repository. Render reads [render.yaml](../render.yaml), proposes the service with the
free plan and the health check, generates `API_TOKEN` for you, and asks you for `DASHBOARD_ORIGIN`.

## 4. Environment variables

| Key | Value | Notes |
|---|---|---|
| `API_TOKEN` | *Generate* (or your own 24+ char secret) | **Required.** The service will not start without it. |
| `DASHBOARD_ORIGIN` | `https://YOUR-USERNAME.github.io` | The origin only — no path, no trailing slash. A project page at `https://user.github.io/my-dashboard/` still uses `https://user.github.io`. Comma-separate several. If you have no dashboard yet, put the placeholder; the test console does not need it. |
| `NODE_ENV` | `production` | |

Everything else has a default (see the README table): `DEFAULT_LOGIN_URL`, `DEFAULT_VIEWPORT_*`, `NAVIGATION_TIMEOUT`,
`ELEMENT_TIMEOUT`, `ADDITIONAL_PAGE_DELAY`, `BROWSER_HEADLESS`, `SCREENSHOT_DIR`. Do **not** set `PORT` (Render provides it) and
do **not** set `ALLOW_PRIVATE_URLS`.

Click **Create Web Service**. The first build downloads the Playwright base image (large) and can take several minutes.

### Auto-deploy

By default Render redeploys on every push to the branch. Each deploy restarts the service, which ends the browser session,
your login, any running automation and all temporary screenshots/workflows. Download what you need *before* you push.

## 5. Verify the deployment

1. Watch **Logs**. You should see `Cloud Screenshot Service 1.0.0 listening on 0.0.0.0:<port>`.
   - `Configuration error: API_TOKEN ...` → fix the variable and redeploy.
   - A Docker build error mentioning *"expects Chromium at … which is not in this image"* → the `playwright` version in
     `package.json` and the `FROM ...:vX.Y.Z-noble` tag in the `Dockerfile` differ. Make them equal.
2. Open `https://YOUR-SERVICE.onrender.com/api/status` — you should get `{"ok":true,"data":{"status":"ok", ...}}`.
3. Open `https://YOUR-SERVICE.onrender.com/api/test`, paste the token, **Connect**.
4. **Health** tab → *Browser available* should be `true`.
5. **Test results** → **Run All Tests**. The first launch of Chromium on a 512 MB instance is the real test of the memory
   limits: a `503 insufficient_memory` is reported honestly, not hidden.

If step 5 passes on Render, the deployment works end to end.

## 6. Day-to-day

- **Cold starts.** After a period with no traffic the free service sleeps; the next request wakes it, which can take from
  several seconds to about a minute. The test console shows *Waking up…*.
- **Do not add keep-alive pings** to prevent sleeping; this service deliberately has none and Render's free-tier policy is
  about inactivity.
- **Rotating the token:** change `API_TOKEN` in *Environment* → save → Render redeploys. Reconnect clients with the new value.
- **Updating Playwright:** change `"playwright"` in `package.json` *and* the tag in the `Dockerfile` in the same commit.
- **Logs** are plain text, one line per request (method, path, status, duration). They never contain tokens, typed text,
  cookies, query strings or request bodies.

## 7. Free-instance limits that matter here

Render's current numbers are at <https://render.com/docs/free>; treat that page as authoritative. In short:

- Roughly **512 MB RAM** and a fraction of a CPU. Chromium is heavy; keep the viewport modest, prefer viewport screenshots, and
  run one workflow at a time (the service enforces one browser session).
- **Ephemeral filesystem.** `/tmp/screenshot-automation/` is wiped on every restart/redeploy. There is no persistent disk and none
  is needed.
- **Spin-down** after inactivity, with a wake-up delay (see above).
- Monthly free instance hours are limited; check your Render account page.

## Troubleshooting a deploy

| Log or behaviour | Fix |
|---|---|
| Build fails at `npm ci` | `package-lock.json` is out of sync: run `npm install` locally and commit the lockfile. |
| Build fails at the Chromium check | Version mismatch between `package.json` and the `Dockerfile` tag (see above). |
| Deploy "live" but health check fails | The process crashed on start; read the first log lines (usually `Configuration error`). |
| Service restarts repeatedly / "Out of memory" | Chromium plus the page exceeded the instance memory. Lower the viewport, close the browser between runs, avoid full-page screenshots, or use a paid instance. |
| `403 origin_not_allowed` from the dashboard | `DASHBOARD_ORIGIN` does not exactly equal the dashboard's origin. |
| Login site shows a CAPTCHA or blocks the page | Cloud IP addresses are often blocked by such sites. This service does not bypass CAPTCHA or bot protection. |
