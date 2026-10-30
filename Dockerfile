# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------------------------------------------
# Cloud Screenshot Service - Render Free Web Service image
#
# The base image tag and the "playwright" version in package.json MUST be the same (1.64.1). The image ships the
# Chromium build that exactly that Playwright release expects, so no browser is downloaded at build time or at start.
# When you upgrade Playwright, change BOTH: package.json ("playwright": "x.y.z") and the tag below (vx.y.z-noble).
# ---------------------------------------------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    # Browsers come preinstalled in the base image; never download another copy.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Chromium needs a writable HOME for its profile/crash dirs when running as a non-root user.
    HOME=/home/pwuser \
    # Temporary storage: lost on restart / redeploy on Render Free. There is no persistent disk.
    DATA_DIR=/tmp/screenshot-automation \
    SCREENSHOT_DIR=/tmp/screenshot-automation/screenshots \
    PORT=10000

WORKDIR /app

# Install production dependencies only, from the lockfile, without running third-party install scripts
# (swagger-ui-dist pulls in a telemetry postinstall that this service does not want to run).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Fail the build if the Chromium that the installed Playwright expects is not the one baked into the image. This is
# the check that matters: it compares the npm package against what is actually on disk in the base image, so a
# version mismatch (npm 1.65, image 1.64) is caught here at build time instead of as a launch failure at runtime.
RUN node -e "const fs=require('fs');const v=require('playwright/package.json').version;\
const p=require('playwright').chromium.executablePath();\
if(!fs.existsSync(p)){console.error('Playwright '+v+' expects Chromium at '+p+', which is not in this image. The npm version and the image tag (v1.64.1-noble) must match.');process.exit(1)}\
console.log('Playwright '+v+' found its Chromium at '+p)"

COPY server.js ./
COPY src ./src

# Temporary directories, owned by the unprivileged user the process runs as.
RUN mkdir -p /tmp/screenshot-automation/screenshots /tmp/screenshot-automation/workflows /tmp/screenshot-automation/runtime \
 && chown -R pwuser:pwuser /tmp/screenshot-automation /app /home/pwuser

# Run as the non-root user that the Playwright image provides. Chromium's sandbox is left ENABLED (Playwright's
# default); the image is designed to run with it as pwuser.
USER pwuser

EXPOSE 10000

# Render performs its own health check on the path configured in the service settings (/api/status). This
# container-level check is for local `docker run`; it reads only the unauthenticated liveness fields.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node handles SIGTERM itself (Render sends it on every deploy): the graceful shutdown closes Chromium and ends the
# event streams. For local `docker run`, add --init so that orphaned Chromium helper processes are reaped.
CMD ["node", "server.js"]
