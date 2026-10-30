'use strict';

/** Consistent success envelope: { ok: true, data }. Errors use { ok: false, error } (see error.middleware). */
function sendOk(res, data = {}, status = 200) {
  return res.status(status).json({ ok: true, data });
}

/** Binary image response with metadata headers a dashboard needs for coordinate conversion. */
function sendImage(res, { buffer, format, viewport, url }) {
  res.set({
    'Content-Type': format === 'png' ? 'image/png' : 'image/jpeg',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Viewport-Width': String(viewport?.width ?? ''),
    'X-Viewport-Height': String(viewport?.height ?? ''),
    'X-Page-Url': encodeURI(url ?? ''),
  });
  res.status(200).end(buffer);
}

module.exports = { sendOk, sendImage };
