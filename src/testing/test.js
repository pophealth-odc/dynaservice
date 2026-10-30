'use strict';

/*
 * Standalone test console. Talks to the same REST API as the production dashboard, from the same origin.
 *
 * Security notes
 *  - The API token lives only in the closure variable `token` below. It is never written to localStorage,
 *    sessionStorage, cookies, the URL or the DOM (the input is cleared the moment it is read).
 *  - Typed text for the remote browser is sent straight to the API and never kept, logged or re-displayed.
 *  - Server-Sent Events are read with fetch() because EventSource cannot send an Authorization header.
 */
(function () {
  var token = null;
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'class') node.className = props[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString() : '–'; }
  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

  var toastTimer;
  function toast(message, bad) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 7000 : 3500);
  }
  function banner(message, kind) {
    var b = $('banner');
    if (!message) { b.hidden = true; return; }
    b.textContent = message;
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.hidden = false;
  }
  function setBusy(button, busy) { if (button) button.disabled = busy; }

  function kv(container, pairs) {
    container.textContent = '';
    pairs.forEach(function (p) {
      var cls = p[2] || '';
      container.appendChild(el('div', { class: cls }, [el('div', { class: 'k', text: p[0] }), el('div', { class: 'v' + (cls.indexOf('mono') >= 0 ? ' mono' : ''), text: p[1] == null || p[1] === '' ? '–' : String(p[1]) })]));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // API client
  // ---------------------------------------------------------------------------------------------

  function ApiError(info) {
    var e = new Error(info.message);
    e.name = 'ApiError';
    e.code = info.code; e.status = info.status; e.hint = info.hint; e.details = info.details; e.requestId = info.requestId;
    return e;
  }
  function describeError(e) {
    var parts = [e.message];
    if (e.code) parts.push('[' + e.code + (e.status ? ' / ' + e.status : '') + ']');
    if (e.hint) parts.push('— ' + e.hint);
    return parts.join(' ');
  }

  var waking = 0;
  function showWaking(on) {
    waking += on ? 1 : -1;
    $('wake-badge').hidden = waking <= 0;
  }

  function showLast(method, path, status, body, ms) {
    $('last-meta').textContent = '– ' + method + ' ' + path + ' → ' + status + ' (' + ms + ' ms)';
    var text;
    try { text = typeof body === 'string' ? body : JSON.stringify(body, function (k, v) { return k === 'image' && typeof v === 'string' && v.length > 200 ? '[base64 image omitted]' : v; }, 2); } catch (e) { text = String(body); }
    $('last-response').textContent = text.length > 20000 ? text.slice(0, 20000) + '\n…' : text;
  }

  /**
   * Call the API. Resolves with `data`; rejects with ApiError. A slow first response is reported as the
   * service waking up (Render Free cold start) rather than as a failure.
   */
  async function api(method, path, body, opts) {
    opts = opts || {};
    if (!token && !opts.anonymous) throw ApiError({ message: 'Enter the API token and press Connect first.', code: 'no_token' });
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    var init = { method: method, headers: headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var started = performance.now();
    var slowTimer = setTimeout(function () { showWaking(true); slowTimer = null; }, 4000);
    var res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw ApiError({ message: 'Could not reach the service (network error or it is still starting).', code: 'network_error', hint: 'On Render Free the first request after inactivity can take up to a minute.' });
    } finally {
      if (slowTimer) clearTimeout(slowTimer); else showWaking(false);
    }
    var ms = Math.round(performance.now() - started);
    if (opts.raw) {
      showLast(method, path, res.status, '[binary or raw response]', ms);
      if (!res.ok) await throwFromResponse(res);
      return res;
    }
    var payload = await res.text();
    var json;
    try { json = JSON.parse(payload); } catch (e) { json = null; }
    showLast(method, path, res.status, json || payload, ms);
    if (!res.ok || (json && json.ok === false)) {
      var error = (json && json.error) || { message: 'HTTP ' + res.status, status: res.status };
      if (res.status === 401 && token && !opts.anonymous) markDisconnected('The service rejected the token.');
      throw ApiError(error);
    }
    return json && json.ok === true && 'data' in json ? json.data : json;
  }
  async function throwFromResponse(res) {
    var t = await res.text();
    var j; try { j = JSON.parse(t); } catch (e) { j = null; }
    throw ApiError((j && j.error) || { message: 'HTTP ' + res.status, status: res.status });
  }

  // ---------------------------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------------------------

  function markConnected() {
    $('conn-badge').textContent = 'Connected';
    $('conn-badge').className = 'badge badge-on';
    $('btn-disconnect').hidden = false;
    $('btn-connect').hidden = true;
    $('token-input').hidden = true;
  }
  function markDisconnected(reason) {
    token = null;
    stopEvents();
    stopAutoRefresh();
    $('conn-badge').textContent = 'Disconnected';
    $('conn-badge').className = 'badge badge-off';
    $('btn-disconnect').hidden = true;
    $('btn-connect').hidden = false;
    $('token-input').hidden = false;
    $('token-input').value = '';
    if (reason) toast(reason, true);
  }

  $('auth-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var input = $('token-input');
    var candidate = input.value.trim();
    input.value = ''; // never leave the token in the DOM
    if (!candidate) { toast('Enter the API token.', true); return; }
    setBusy($('btn-connect'), true);
    token = candidate;
    try {
      var status = await api('GET', '/api/status');
      if (!status.authenticated) throw ApiError({ message: 'The token was not accepted.', code: 'invalid_token' });
      markConnected();
      renderHealth(status);
      toast('Connected.');
      if (status.interruptedRun || status.previousRun) banner('A previous automation run was interrupted by a service restart. Browser session and run state were lost: log in again and start the workflow again.', 'warn');
      startEvents();
      refreshWorkflows().catch(function () {});
    } catch (e) {
      markDisconnected();
      toast(describeError(e), true);
    } finally {
      setBusy($('btn-connect'), false);
    }
  });
  $('btn-disconnect').addEventListener('click', function () { markDisconnected(); toast('Token cleared.'); });

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------

  function selectTab(name) {
    qsa('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    qsa('.panel').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (token) {
      if (name === 'health') refreshStatus().catch(function () {});
      if (name === 'workflows') refreshWorkflows().catch(function () {});
      if (name === 'screenshots') listScreenshots().catch(function () {});
      if (name === 'browser') refreshBrowserLine().catch(function () {});
      if (name === 'login') refreshLogin().catch(function () {});
      if (name === 'recorder') refreshRecorder().catch(function () {});
    }
  }
  qsa('.tabs button').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });

  // Wrap a click handler: disable the button while it runs and surface errors as toasts.
  function action(id, fn) {
    var b = $(id);
    b.addEventListener('click', async function () {
      setBusy(b, true);
      try { await fn(); } catch (e) { toast(describeError(e), true); } finally { setBusy(b, false); }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------------------------

  var lastStatus = null;
  function renderHealth(s) {
    lastStatus = s;
    var mem = s.memory || {};
    var b = s.browser || {};
    kv($('health-grid'), [
      ['Service status', s.status], ['Version', s.version], ['Uptime', Math.round(s.uptimeSeconds / 60 * 10) / 10 + ' min'],
      ['Restart id', s.restartId], ['Environment', s.environment + (s.render && s.render.isRender ? ' (Render)' : '')],
      ['API connection', token ? 'connected' : 'not connected'],
      ['Browser available', b.available], ['Browser running', b.running], ['Browser connection', b.connectionStatus],
      ['Current URL', s.currentUrl, 'wide mono'],
      ['Current workflow', s.currentWorkflow ? s.currentWorkflow.name : 'none'], ['Workflow status', s.currentWorkflowStatus],
      ['Memory used', mem.usedMB != null ? mem.usedMB + ' / ' + mem.limitMB + ' MB (' + mem.source + ')' : '–'], ['Process RSS', mem.rssMB != null ? mem.rssMB + ' MB' : '–'],
      ['Session id', s.sessionId], ['Login', s.login ? s.login.state : '–'],
      ['Screenshots stored', s.screenshots ? s.screenshots.count : '–'], ['Node', s.nodeVersion],
    ]);
    $('health-raw').textContent = JSON.stringify(s, null, 2);
    if (s.warnings && s.warnings.length) banner(s.warnings.join(' '), 'warn');
  }
  async function refreshStatus() {
    var s = await api('GET', '/api/status');
    renderHealth(s);
    return s;
  }
  action('btn-status', refreshStatus);

  // ---------------------------------------------------------------------------------------------
  // Browser + remote view
  // ---------------------------------------------------------------------------------------------

  var view = { vw: 0, vh: 0, busy: false, last: 0 };

  function renderBrowser(s) {
    var line = 'State: ' + s.state + (s.connected ? ' · page ' + s.pageState : '') + (s.title ? ' · "' + s.title + '"' : '') + (s.viewport ? ' · viewport ' + s.viewport.width + '×' + s.viewport.height : '');
    $('browser-line').textContent = line;
    $('remote-url').textContent = s.url || '–';
    $('remote-url').title = s.url || '';
    if (s.viewport) { view.vw = s.viewport.width; view.vh = s.viewport.height; }
  }
  async function refreshBrowserLine() {
    var s = await api('GET', '/api/browser/status');
    renderBrowser(s);
    return s;
  }

  var imageUrl = null;
  async function refreshScreenshot(quiet) {
    if (view.busy) return;
    view.busy = true;
    try {
      var res = await api('GET', '/api/browser/screenshot?format=jpeg&quality=72', undefined, { raw: true });
      var blob = await res.blob();
      view.vw = parseInt(res.headers.get('X-Viewport-Width'), 10) || view.vw;
      view.vh = parseInt(res.headers.get('X-Viewport-Height'), 10) || view.vh;
      var url = res.headers.get('X-Page-Url');
      if (url) $('remote-url').textContent = decodeURI(url);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(blob);
      var img = $('remote-img');
      img.src = imageUrl;
      img.hidden = false;
      $('stage-empty').hidden = true;
    } catch (e) {
      if (!quiet) toast(describeError(e), true);
      if (e.code === 'browser_not_running' || e.code === 'browser_session_lost') {
        $('remote-img').hidden = true;
        $('stage-empty').hidden = false;
        $('stage-empty').textContent = 'The browser is not running (it may have been lost on a restart). Launch it again and log in again.';
      }
    } finally {
      view.busy = false;
    }
  }

  // Convert a click on the displayed (scaled) image into real browser viewport coordinates.
  function toViewport(ev) {
    var img = $('remote-img');
    var r = img.getBoundingClientRect();
    var sx = (view.vw || img.naturalWidth) / r.width;
    var sy = (view.vh || img.naturalHeight) / r.height;
    var x = Math.round((ev.clientX - r.left) * sx);
    var y = Math.round((ev.clientY - r.top) * sy);
    return { x: Math.max(0, Math.min(x, (view.vw || img.naturalWidth) - 1)), y: Math.max(0, Math.min(y, (view.vh || img.naturalHeight) - 1)), rx: ev.clientX - r.left, ry: ev.clientY - r.top, scale: sx };
  }
  function mark(rx, ry) {
    var m = $('marker');
    m.hidden = true;
    void m.offsetWidth; // restart the CSS animation
    var stage = $('stage').getBoundingClientRect();
    var img = $('remote-img').getBoundingClientRect();
    m.style.left = (img.left - stage.left + rx) + 'px';
    m.style.top = (img.top - stage.top + ry) + 'px';
    m.hidden = false;
  }

  var recordingActive = false;
  $('remote-img').addEventListener('click', async function (ev) {
    if (!token) { toast('Connect first.', true); return; }
    var p = toViewport(ev);
    var mode = (document.querySelector('input[name=mode]:checked') || {}).value;
    $('coord-line').textContent = 'Displayed ' + Math.round(p.rx) + ',' + Math.round(p.ry) + '  →  browser ' + p.x + ',' + p.y + '  (scale ×' + p.scale.toFixed(2) + ')';
    mark(p.rx, p.ry);
    try {
      var out;
      if (recordingActive && mode !== 'hover' && $('rec-continue').checked) {
        // "select & continue": select the element and also perform the click, so the next page can be recorded.
        out = { recorded: true, selection: (await api('POST', '/api/recorder/select-element', { x: p.x, y: p.y, activate: true })).selection };
        if (out.selection.activation && !out.selection.activation.performed) toast(out.selection.activation.reason, true);
      } else {
        out = await api('POST', mode === 'hover' ? '/api/browser/hover' : '/api/browser/click', { x: p.x, y: p.y });
      }
      if (out.recorded) { toast('Element selected.'); refreshRecorder().catch(function () {}); }
      await refreshScreenshot(true);
    } catch (e) {
      toast(describeError(e), true);
    }
  });
  var hoverTimer = 0;
  $('remote-img').addEventListener('mousemove', function (ev) {
    // While recording, hovering highlights elements in the remote page (drawn into the screenshot).
    if (!recordingActive || !token || Date.now() - hoverTimer < 450 || view.busy) return;
    hoverTimer = Date.now();
    var p = toViewport(ev);
    api('POST', '/api/browser/hover', { x: p.x, y: p.y }).then(function () { return refreshScreenshot(true); }).catch(function () {});
  });

  action('btn-launch', async function () {
    var out = await api('POST', '/api/browser/launch', {});
    toast(out.alreadyRunning ? 'Chromium was already running.' : 'Chromium launched.');
    renderBrowser(out);
    await refreshScreenshot(true);
  });
  action('btn-close', async function () {
    await api('POST', '/api/browser/close', {});
    toast('Browser closed.');
    $('remote-img').hidden = true;
    $('stage-empty').hidden = false;
    $('stage-empty').textContent = 'Browser closed.';
    await refreshBrowserLine();
  });
  action('btn-browser-status', refreshBrowserLine);
  action('btn-get-url', async function () { var s = await refreshBrowserLine(); toast(s.url || 'No page open.'); });
  action('btn-open-url', async function () {
    var out = await api('POST', '/api/browser/open-url', { url: $('open-url').value.trim() });
    toast('Opened (' + (out.status || 'n/a') + ').');
    await refreshBrowserLine();
    await refreshScreenshot(true);
  });
  action('btn-open-fixture', async function () {
    var s = lastStatus || await refreshStatus();
    if (!s.fixtureUrl) throw new Error('Demo site address unavailable.');
    await api('POST', '/api/browser/launch', {});
    await api('POST', '/api/browser/open-url', { url: s.fixtureUrl });
    $('open-url').value = s.fixtureUrl;
    await refreshBrowserLine();
    await refreshScreenshot(true);
  });
  action('btn-shot-refresh', function () { return refreshScreenshot(false); });
  action('btn-shot-capture', async function () {
    var out = await api('POST', '/api/screenshots', {});
    toast('Stored ' + out.screenshot.filename);
  });
  action('btn-refresh-page', async function () { await api('POST', '/api/browser/refresh', {}); await refreshScreenshot(true); });

  action('btn-type', async function () {
    var input = $('type-text');
    var text = input.value;
    if (!text) throw new Error('Type something first.');
    input.value = ''; // do not keep what was typed (it may be a password)
    var out = await api('POST', '/api/browser/type', { text: text, pressEnter: $('type-enter').checked });
    toast('Typed ' + out.typedCharacters + ' character(s).');
    await refreshScreenshot(true);
  });
  qsa('.key').forEach(function (b) {
    b.addEventListener('click', async function () {
      try { await api('POST', '/api/browser/keypress', { key: b.dataset.key }); await refreshScreenshot(true); } catch (e) { toast(describeError(e), true); }
    });
  });
  action('btn-key', async function () {
    var key = $('key-custom').value.trim();
    if (!key) throw new Error('Enter a key, for example Control+A.');
    await api('POST', '/api/browser/keypress', { key: key });
    await refreshScreenshot(true);
  });
  qsa('.scroll').forEach(function (b) {
    b.addEventListener('click', async function () {
      try {
        await api('POST', '/api/browser/scroll', { deltaX: Number(b.dataset.dx || 0), deltaY: Number(b.dataset.dy || 0) });
        await refreshScreenshot(true);
      } catch (e) { toast(describeError(e), true); }
    });
  });

  var autoTimer = null;
  function stopAutoRefresh() { clearInterval(autoTimer); autoTimer = null; $('auto-refresh').checked = false; }
  $('auto-refresh').addEventListener('change', function () {
    clearInterval(autoTimer);
    autoTimer = null;
    if (this.checked) autoTimer = setInterval(function () { if (!document.hidden && token) refreshScreenshot(true); }, 1500);
  });

  // ---------------------------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------------------------

  function renderLogin(s) {
    kv($('login-grid'), [
      ['State', s.state], ['Eligible for automation', s.eligibleForAutomation], ['Login URL', s.loginUrl, 'wide mono'],
      ['Opened', fmtTime(s.openedAt)], ['Confirmed', fmtTime(s.confirmedAt)], ['Message', s.message, 'wide'],
    ]);
  }
  async function refreshLogin() { var s = await api('GET', '/api/login/status'); renderLogin(s); return s; }
  action('btn-login-open', async function () {
    renderLogin(await api('POST', '/api/login/open', {}));
    toast('Login page opened. Switch to Browser & Remote to sign in.');
    selectTab('browser');
    await refreshBrowserLine();
    await refreshScreenshot(true);
  });
  action('btn-login-status', refreshLogin);
  action('btn-login-confirm', async function () { renderLogin(await api('POST', '/api/login/confirm', {})); toast('Login confirmed. Automation can start.'); });
  action('btn-login-cancel', async function () { renderLogin(await api('POST', '/api/login/cancel', {})); toast('Login cancelled.'); });

  // ---------------------------------------------------------------------------------------------
  // Recorder
  // ---------------------------------------------------------------------------------------------

  var currentSelection = null;
  function renderRecorder(status, selection) {
    recordingActive = !!status.active;
    kv($('rec-status'), [['Recording', status.active ? 'ACTIVE' : 'off'], ['Selection', status.hasSelection ? 'yes' : 'none'], ['Selections made', status.selectionCount]]);
    currentSelection = selection || null;
    var box = $('rec-selection');
    if (!selection) { kv(box, [['Element', 'nothing selected']]); $('rec-raw').textContent = ''; return; }
    var e = selection.element;
    var l = selection.locators;
    kv(box, [
      ['Tag', e.tag], ['ID', e.id], ['CSS classes', (e.classes || []).join(' ')], ['Visible text', e.text],
      ['Accessible role', e.role], ['Accessible name', e.accessibleName],
      ['Stable attributes', Object.keys(Object.assign({}, e.attributes, e.dataAttributes)).map(function (k) { return k + '=' + (e.attributes[k] || e.dataAttributes[k]); }).join(', ')],
      ['CSS selector', selection.cssSelector, 'wide mono'], ['XPath fallback', selection.xpath, 'wide mono'],
      ['Page URL', selection.page.url, 'wide mono'], ['Page title', selection.page.title],
      ['Frame', selection.frame.isTopFrame ? 'top frame' : 'iframe: ' + selection.frame.path.join(' > ') + ' (' + selection.frame.url + ')', 'wide'],
      ['Shadow DOM', e.inShadowDom ? 'yes: ' + (e.shadowHosts || []).join(' > ') : 'no'],
      ['Locator unique', l.unique ? 'yes' : (l.ambiguous ? 'NO – ambiguous, needs a more specific locator' : 'NO – could not be validated')],
      ['Primary locator', l.primary ? JSON.stringify(l.primary) : l.message, 'wide mono'],
      ['Candidates (matches)', (l.candidates || []).map(function (c) { return c.strategy + '=' + c.matches; }).join('  '), 'wide mono'],
      ['Warnings', (selection.warnings || []).join(' | '), 'wide'],
    ]);
    $('rec-raw').textContent = JSON.stringify(selection, null, 2);
  }
  async function refreshRecorder() {
    var status = await api('GET', '/api/recorder/status');
    var sel = await api('GET', '/api/recorder/selected-element');
    renderRecorder(status, sel.selection);
    refreshWorkflowSelect();
  }
  action('btn-rec-start', async function () { await api('POST', '/api/recorder/start', {}); toast('Recording. Hover and click in the remote browser.'); await refreshRecorder(); await refreshScreenshot(true); });
  action('btn-rec-stop', async function () { await api('POST', '/api/recorder/stop', {}); toast('Recording stopped.'); await refreshRecorder(); await refreshScreenshot(true); });
  action('btn-rec-get', refreshRecorder);
  action('btn-rec-clear', async function () { await api('POST', '/api/recorder/clear-selection', {}); await refreshRecorder(); await refreshScreenshot(true); });
  action('btn-rec-add', async function () {
    var id = $('rec-workflow').value;
    if (!id) throw new Error('Create or choose a workflow first (Workflows tab).');
    var body = { fromSelection: true, screenshot: true };
    if ($('rec-step-name').value.trim()) body.name = $('rec-step-name').value.trim();
    var out = await api('POST', '/api/workflows/' + id + '/steps', body);
    toast('Saved step "' + out.addedStep.name + '".');
    $('rec-step-name').value = '';
    await refreshWorkflows();
  });
  function refreshWorkflowSelect() {
    var sel = $('rec-workflow');
    var keep = sel.value || wf.selected;
    sel.textContent = '';
    wf.items.forEach(function (w) { sel.appendChild(el('option', { value: w.id, text: w.name })); });
    if (keep) sel.value = keep;
  }

  // ---------------------------------------------------------------------------------------------
  // Workflows + automation
  // ---------------------------------------------------------------------------------------------

  var wf = { items: [], selected: null, detail: null, selectedStep: null };

  async function refreshWorkflows() {
    var out = await api('GET', '/api/workflows');
    wf.items = out.workflows;
    if (wf.selected && !wf.items.some(function (w) { return w.id === wf.selected; })) { wf.selected = null; wf.detail = null; }
    if (!wf.selected && wf.items.length) wf.selected = wf.items[0].id;
    var list = $('wf-list');
    list.textContent = '';
    wf.items.forEach(function (w) {
      var li = el('li', { 'aria-selected': String(w.id === wf.selected), onclick: function () { wf.selected = w.id; refreshWorkflows().catch(function (e) { toast(describeError(e), true); }); } },
        [el('strong', { text: w.name }), el('small', { text: w.enabledStepCount + '/' + w.stepCount + ' steps enabled · ' + (w.enabled ? 'enabled' : 'disabled') })]);
      list.appendChild(li);
    });
    if (!wf.items.length) list.appendChild(el('li', { text: 'No workflows yet. Workflows are temporary on Render Free: export what you want to keep.' }));
    refreshWorkflowSelect();
    if (wf.selected) await viewWorkflow(); else { $('wf-steps').textContent = ''; $('wf-title').textContent = 'Selected workflow'; }
    await refreshAutomation();
  }
  async function viewWorkflow() {
    if (!wf.selected) throw new Error('Select a workflow first.');
    var out = await api('GET', '/api/workflows/' + wf.selected);
    wf.detail = out.workflow;
    $('wf-title').textContent = out.workflow.name;
    var ol = $('wf-steps');
    ol.textContent = '';
    out.workflow.steps.forEach(function (s, i) {
      var li = el('li', { 'aria-selected': String(wf.selectedStep === s.id) }, [
        el('span', { class: 'num', text: String(s.number) }),
        el('div', { class: 'main', onclick: function () { wf.selectedStep = s.id; viewWorkflow().catch(function () {}); } }, [
          el('div', { text: s.name + (s.enabled ? '' : '  (disabled)') }),
          el('div', { class: 'sub', text: s.action + (s.target ? ' · ' + (s.target.strategy === 'role' ? 'role ' + s.target.role + ' "' + s.target.name + '"' : s.target.strategy + ' ' + (s.target.selector || s.target.text || '')) : '') + (s.screenshot ? ' · screenshot' : '') }),
        ]),
        el('button', { class: 'small secondary', text: s.enabled ? 'Disable' : 'Enable', onclick: function () { toggleStep(i); } }),
        el('button', { class: 'small secondary', text: '↑', title: 'Move up', onclick: function () { moveStep(i, -1); } }),
        el('button', { class: 'small secondary', text: '↓', title: 'Move down', onclick: function () { moveStep(i, 1); } }),
      ]);
      ol.appendChild(li);
    });
    return out.workflow;
  }
  async function toggleStep(i) {
    try {
      var steps = wf.detail.steps.map(function (s, n) { return n === i ? Object.assign({}, s, { enabled: !s.enabled }) : s; });
      await api('PUT', '/api/workflows/' + wf.selected, { steps: steps });
      await refreshWorkflows();
    } catch (e) { toast(describeError(e), true); }
  }
  async function moveStep(i, delta) {
    try {
      var order = wf.detail.steps.map(function (s) { return s.id; });
      var j = i + delta;
      if (j < 0 || j >= order.length) return;
      var t = order[i]; order[i] = order[j]; order[j] = t;
      await api('POST', '/api/workflows/' + wf.selected + '/reorder', { order: order });
      await refreshWorkflows();
    } catch (e) { toast(describeError(e), true); }
  }

  // A sample workflow that targets the built-in demo site. Locators are the ones the recorder would produce.
  function sampleWorkflow() {
    var stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    return {
      name: 'Demo Navigation ' + stamp,
      description: 'Opens Problems, then Services, then a service, on the built-in demo site.',
      steps: [
        { name: 'Open Problems', action: 'click', target: { strategy: 'id', selector: '#nav-problems' }, wait: { condition: 'page_ready' }, screenshot: true, delay: 300 },
        { name: 'Open Services', action: 'click', target: { strategy: 'css', selector: '[data-testid="main-nav"] a[data-route="services"]' }, wait: { condition: 'element_visible', target: { strategy: 'css', selector: '[data-testid="services-list"]' } }, screenshot: true, delay: 300 },
        { name: 'Open Selected Service', action: 'click', target: { strategy: 'role', role: 'link', name: 'checkout-service' }, wait: { condition: 'element_visible', target: { strategy: 'css', selector: '[data-testid="service-details"]' } }, screenshot: true, delay: 300 },
      ],
    };
  }
  action('btn-wf-sample', async function () {
    var out = await api('POST', '/api/workflows', sampleWorkflow());
    wf.selected = out.workflow.id;
    toast('Created "' + out.workflow.name + '". Open the demo site and log in before starting it.');
    await refreshWorkflows();
  });
  action('btn-wf-list', refreshWorkflows);
  action('btn-wf-view', viewWorkflow);
  action('btn-wf-export', async function () {
    if (!wf.selected) throw new Error('Select a workflow first.');
    var res = await api('GET', '/api/workflows/' + wf.selected + '/export', undefined, { raw: true });
    var blob = await res.blob();
    var name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'workflow.json';
    saveBlob(blob, name);
  });
  action('btn-wf-dup', async function () { if (!wf.selected) throw new Error('Select a workflow first.'); var out = await api('POST', '/api/workflows/' + wf.selected + '/duplicate', {}); wf.selected = out.workflow.id; await refreshWorkflows(); });
  action('btn-wf-rename', async function () {
    if (!wf.selected) throw new Error('Select a workflow first.');
    var name = window.prompt('New workflow name', wf.detail ? wf.detail.name : '');
    if (!name) return;
    await api('PUT', '/api/workflows/' + wf.selected, { name: name });
    await refreshWorkflows();
  });
  action('btn-wf-delete', async function () {
    if (!wf.selected) throw new Error('Select a workflow first.');
    if (!window.confirm('Delete this workflow?')) return;
    await api('DELETE', '/api/workflows/' + wf.selected);
    wf.selected = null;
    await refreshWorkflows();
  });
  $('btn-wf-import').addEventListener('click', function () { $('wf-file').click(); });
  $('wf-file').addEventListener('change', async function () {
    var file = this.files[0];
    this.value = '';
    if (!file) return;
    try {
      var text = await file.text();
      var doc = JSON.parse(text);
      var out = await api('POST', '/api/workflows/import', doc);
      wf.selected = out.workflow.id;
      toast('Imported "' + out.workflow.name + '"' + (out.warnings.length ? ' (' + out.warnings.length + ' warning(s))' : '') + '.');
      await refreshWorkflows();
    } catch (e) { toast(e.name === 'SyntaxError' ? 'That file is not valid JSON.' : describeError(e), true); }
  });
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  var auto = null;
  function renderAutomation(s) {
    auto = s;
    var r = s.run;
    kv($('auto-grid'), [
      ['State', s.state], ['Workflow', r ? r.workflowName : '–'], ['Step', r && r.currentStep ? r.currentStep.number + ' – ' + r.currentStep.name : '–'],
      ['Completed / total', r ? r.completedSteps + ' / ' + r.totalSteps : '–'], ['Failed', r ? r.failedSteps : '–'], ['Progress', r ? r.progress + '%' : '–'],
      ['Phase', r ? r.phase : '–'], ['Message', (r && r.message) || (s.interruptedRun ? s.interruptedRun.reason : ''), 'wide'],
    ]);
    $('progress-bar').style.width = (r ? r.progress : 0) + '%';
    var c = s.controls || {};
    [['btn-a-start', c.start], ['btn-a-start-paused', c.start], ['btn-a-pause', c.pause], ['btn-a-resume', c.resume], ['btn-a-stop', c.stop], ['btn-a-restart', c.restart], ['btn-a-exec', c.executeStep], ['btn-a-skip', c.skipStep], ['btn-a-test', c.testStep]]
      .forEach(function (p) { $(p[0]).disabled = !p[1]; });
    var ol = $('run-steps');
    ol.textContent = '';
    ((r && r.steps) || []).forEach(function (st, i) {
      var cur = r.currentStepIndex === i && ['running', 'pausing', 'paused', 'failed'].indexOf(r.status) >= 0;
      ol.appendChild(el('li', { class: cur ? 'cur' : '' }, [
        el('span', { class: 'num', text: String(st.number) }),
        el('div', { class: 'main' }, [
          el('div', { text: st.name }),
          st.error ? el('div', { class: 'err', text: st.error.code + ': ' + st.error.message }) : el('div', { class: 'sub', text: (st.durationMs != null ? st.durationMs + ' ms' : '') + (st.screenshot ? ' · ' + st.screenshot.filename : '') + (st.usedFallbackLocator ? ' · fallback locator used' : '') }),
        ]),
        el('span', { class: 'st ' + st.status, text: st.status }),
      ]));
    });
    if (s.state === 'paused' && r && r.loginRequired) banner(r.message, 'warn');
    else if (s.state === 'interrupted') banner('Automation was interrupted by a service restart. Log in again and start the workflow again.', 'warn');
  }
  async function refreshAutomation() { var s = await api('GET', '/api/automation/status'); renderAutomation(s); return s; }
  function runBody(extra) {
    if (!wf.selected) throw new Error('Select a workflow first.');
    return Object.assign({ workflowId: wf.selected, confirmDestructive: $('confirm-destructive').checked }, extra || {});
  }
  action('btn-a-start', async function () { renderAutomation(await api('POST', '/api/automation/start', runBody())); });
  action('btn-a-start-paused', async function () { renderAutomation(await api('POST', '/api/automation/start', runBody({ paused: true }))); });
  action('btn-a-pause', async function () { renderAutomation(await api('POST', '/api/automation/pause', {})); });
  action('btn-a-resume', async function () { renderAutomation(await api('POST', '/api/automation/resume', {})); });
  action('btn-a-stop', async function () { renderAutomation(await api('POST', '/api/automation/stop', {})); });
  action('btn-a-restart', async function () { renderAutomation(await api('POST', '/api/automation/restart', { confirmDestructive: $('confirm-destructive').checked })); });
  action('btn-a-exec', async function () { renderAutomation(await api('POST', '/api/automation/execute-step', {})); });
  action('btn-a-skip', async function () { renderAutomation(await api('POST', '/api/automation/skip-step', {})); });
  action('btn-a-test', async function () {
    if (!wf.selected || !wf.selectedStep) throw new Error('Select a workflow and click a step to test.');
    var out = await api('POST', '/api/automation/test-step', { workflowId: wf.selected, stepId: wf.selectedStep, confirmDestructive: $('confirm-destructive').checked });
    toast('Step "' + out.step.name + '" passed.');
    await refreshScreenshot(true);
  });

  // ---------------------------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------------------------

  var thumbUrls = [];
  function clearThumbs() { thumbUrls.forEach(function (u) { URL.revokeObjectURL(u); }); thumbUrls = []; }
  async function fetchImageUrl(id) {
    var res = await api('GET', '/api/screenshots/' + id + '?view=image', undefined, { raw: true });
    var url = URL.createObjectURL(await res.blob());
    thumbUrls.push(url);
    return url;
  }
  async function listScreenshots() {
    var out = await api('GET', '/api/screenshots');
    clearThumbs();
    var box = $('shots');
    box.textContent = '';
    if (!out.items.length) box.appendChild(el('p', { class: 'muted', text: 'No screenshots in temporary storage.' }));
    out.items.forEach(function (m) {
      var img = el('img', { class: 'thumb', alt: m.filename, onclick: function () { preview(m); } });
      var card = el('div', { class: 'shot' }, [
        img,
        el('div', { class: 'meta' }, [
          el('b', { text: m.filename }),
          el('div', { text: (m.workflowName || 'manual') + (m.stepName ? ' · step ' + m.stepNumber + ' ' + m.stepName : '') }),
          el('div', { class: 'muted', text: fmtTime(m.capturedAt) + ' · ' + m.format.toUpperCase() + ' · ' + fmtBytes(m.sizeBytes) + (m.transferred ? ' · downloaded' : '') }),
          el('div', { class: 'muted', text: m.sourceUrl || '' }),
        ]),
        el('div', { class: 'acts' }, [
          el('button', { class: 'small secondary', text: 'Preview', onclick: function () { preview(m); } }),
          el('button', { class: 'small secondary', text: 'Download', onclick: function () { download(m); } }),
          el('button', { class: 'small danger', text: 'Delete', onclick: function () { removeShot(m); } }),
        ]),
      ]);
      box.appendChild(card);
      fetchImageUrl(m.id).then(function (u) { img.src = u; }).catch(function () {});
    });
    return out;
  }
  async function preview(m) {
    $('preview-title').textContent = m.filename;
    $('preview-img').src = await fetchImageUrl(m.id);
    $('shot-preview').hidden = false;
    $('shot-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('preview-close').addEventListener('click', function () { $('shot-preview').hidden = true; });
  async function download(m) {
    try {
      var res = await api('GET', '/api/screenshots/' + m.id + '/download', undefined, { raw: true });
      var blob = await res.blob();
      saveBlob(blob, m.filename);
      await listScreenshots();
    } catch (e) { toast(describeError(e), true); }
  }
  async function removeShot(m) {
    try { await api('DELETE', '/api/screenshots/' + m.id); await listScreenshots(); } catch (e) { toast(describeError(e), true); }
  }
  action('btn-s-capture', async function () { var out = await api('POST', '/api/screenshots', {}); toast('Captured ' + out.screenshot.filename); await listScreenshots(); });
  action('btn-s-list', listScreenshots);
  action('btn-s-zip', async function () {
    var res = await api('GET', '/api/screenshots/export', undefined, { raw: true });
    saveBlob(await res.blob(), 'screenshots.zip');
    toast('ZIP downloaded (' + (res.headers.get('X-Export-Count') || '?') + ' screenshot(s)).');
  });
  action('btn-s-clear', async function () {
    if (!window.confirm('Delete all screenshots from temporary storage?')) return;
    var out = await api('DELETE', '/api/screenshots');
    toast('Deleted ' + out.deleted + ' screenshot(s).');
    await listScreenshots();
  });

  // ---------------------------------------------------------------------------------------------
  // Events (SSE over fetch)
  // ---------------------------------------------------------------------------------------------

  var ev = { controller: null, lastId: null, retry: 0, timer: null, count: 0 };
  var EVENT_STATUS = { 'step.completed': 'ok', 'step.failed': 'FAILED', 'workflow.completed': 'ok', 'workflow.stopped': 'stopped', 'workflow.paused': 'paused', 'session.expired': 'login needed', 'service.restarted': 'RESTARTED', 'workflow.interrupted': 'INTERRUPTED' };

  function setEventState(text, kind) { $('ev-state').textContent = text; $('ev-state').className = 'badge ' + (kind || 'badge-off'); }
  function addEventRow(e) {
    var body = $('ev-body');
    var step = e.currentStep ? e.currentStep.number + ' ' + e.currentStep.name : '';
    var tr = el('tr', {}, [
      el('td', { text: fmtTime(e.timestamp) }), el('td', { text: e.type }), el('td', { text: e.description }),
      el('td', { text: e.workflowName || '' }), el('td', { text: step }),
      el('td', { text: (EVENT_STATUS[e.type] || '') + (e.progress != null ? ' ' + e.progress + '%' : '') }),
    ]);
    body.insertBefore(tr, body.firstChild);
    while (body.children.length > 500) body.removeChild(body.lastChild);
  }

  function handleEvent(e) {
    addEventRow(e);
    ev.count += 1;
    if (e.type === 'service.connected' && e.data && e.data.snapshot) {
      var snap = e.data.snapshot;
      if (snap.automation) renderAutomation(snap.automation);
      if (snap.restart && snap.restart.interruptedRun) banner('A previous automation run was interrupted by a service restart. Log in again and start the workflow again.', 'warn');
    }
    if (e.type === 'service.restarted') banner('The service restarted: the browser session, login and any running automation were lost. Log in again.', 'bad');
    if (/^(step|workflow|login|session|browser)\./.test(e.type)) {
      refreshAutomation().catch(function () {});
      if (e.type === 'browser.disconnected' || e.type === 'session.expired') refreshBrowserLine().catch(function () {});
    }
    if (e.type === 'screenshot.saved' && !document.querySelector('[data-panel=screenshots]').hidden) listScreenshots().catch(function () {});
    if (e.type === 'element.selected') refreshRecorder().catch(function () {});
  }

  function parseFrames(buffer, onFrame) {
    var parts = buffer.split('\n\n');
    var rest = parts.pop();
    parts.forEach(function (raw) {
      var frame = { event: 'message', data: [], id: null };
      raw.split('\n').forEach(function (line) {
        if (!line || line[0] === ':') return;
        var i = line.indexOf(':');
        var field = i < 0 ? line : line.slice(0, i);
        var value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') frame.event = value; else if (field === 'data') frame.data.push(value); else if (field === 'id') frame.id = value;
      });
      if (frame.data.length) onFrame(frame);
    });
    return rest;
  }

  async function startEvents() {
    stopEvents();
    if (!token) return;
    var controller = new AbortController();
    ev.controller = controller;
    setEventState('connecting…', 'badge-wait');
    try {
      var headers = { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' };
      if (ev.lastId) headers['Last-Event-ID'] = ev.lastId;
      var res = await fetch('/api/events', { headers: headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      setEventState('live', 'badge-on');
      ev.retry = 0;
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer = parseFrames(buffer + decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n'), function (f) {
          try { var data = JSON.parse(f.data.join('\n')); if (f.id && data.id && !/:0$/.test(f.id)) ev.lastId = f.id; handleEvent(data); } catch (err) { /* ignore a malformed frame */ }
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
    }
    if (controller.signal.aborted || ev.controller !== controller) return;
    // Connection lost (network drop, Render sleep or restart): reconnect with backoff and replay from the last id.
    ev.retry = Math.min(ev.retry + 1, 6);
    var wait = Math.min(1000 * Math.pow(2, ev.retry), 20000);
    setEventState('reconnecting in ' + Math.round(wait / 1000) + 's', 'badge-wait');
    ev.timer = setTimeout(function () { if (token) startEvents(); }, wait);
  }
  function stopEvents() {
    if (ev.controller) ev.controller.abort();
    ev.controller = null;
    clearTimeout(ev.timer);
    setEventState('stopped');
  }
  $('btn-ev-connect').addEventListener('click', function () { if (!token) toast('Connect first.', true); else startEvents(); });
  $('btn-ev-disconnect').addEventListener('click', stopEvents);
  $('btn-ev-clear').addEventListener('click', function () { $('ev-body').textContent = ''; });

  // ---------------------------------------------------------------------------------------------
  // Test runner
  // ---------------------------------------------------------------------------------------------

  var tests = [];
  var results = {};
  var ctx = {};
  function test(id, name, fn) { tests.push({ id: id, name: name, fn: fn }); }
  function assert(cond, message) { if (!cond) throw new Error('Assertion failed: ' + message); }

  async function waitFor(fn, what, ms) {
    var end = Date.now() + (ms || 15000);
    for (;;) {
      var v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
      await sleep(250);
    }
  }
  async function waitIdle() { return waitFor(async function () { var s = await api('GET', '/api/automation/status'); return !s.busy && s; }, 'automation to settle', 30000); }
  async function ensureOnFixture(path) {
    var s = await api('GET', '/api/status');
    await api('POST', '/api/browser/launch', {});
    await api('POST', '/api/browser/open-url', { url: s.fixtureUrl + (path || '') });
    ctx.fixtureUrl = s.fixtureUrl;
    return s;
  }
  // The demo login form: fixed positions are avoided; fields are focused by the page and navigated with Tab/typing.
  async function demoLogin() {
    await ensureOnFixture('');
    await api('POST', '/api/login/open', { url: ctx.fixtureUrl });
    // The username field has autofocus (see fixture app.js): type, Tab to password, type, Enter, then the code.
    await api('POST', '/api/browser/type', { text: 'tester' });
    await api('POST', '/api/browser/keypress', { key: 'Tab' });
    await api('POST', '/api/browser/type', { text: 'demo', pressEnter: true });
    await sleep(400);
    await api('POST', '/api/browser/type', { text: '123456', pressEnter: true });
    await waitFor(async function () { var b = await api('GET', '/api/browser/status'); return /\/problems/.test(b.url || ''); }, 'the demo app to show the Problems page');
    await api('POST', '/api/login/confirm', {});
  }

  test('health', 'Service health', async function () {
    var s = await api('GET', '/api/status');
    assert(s.status === 'ok' && s.authenticated === true, 'status ok and authenticated');
    assert(typeof s.uptimeSeconds === 'number', 'uptime reported');
    assert(s.memory && s.memory.limitMB > 0, 'memory reported');
    assert(s.browser && s.browser.available === true, 'Chromium is installed');
    return 'v' + s.version + ', uptime ' + s.uptimeSeconds + 's';
  });
  test('auth', 'Auth rejects a wrong token', async function () {
    var res = await fetch('/api/browser/status', { headers: { Authorization: 'Bearer wrong-token-value-1234567890' }, cache: 'no-store' });
    assert(res.status === 401, 'expected 401, got ' + res.status);
    var res2 = await fetch('/api/browser/status', { cache: 'no-store' });
    assert(res2.status === 401, 'expected 401 without header, got ' + res2.status);
    return '401 for wrong and missing token';
  });
  test('launch', 'Launch Chromium', async function () {
    var out = await api('POST', '/api/browser/launch', {});
    assert(out.connected === true, 'browser connected');
    return 'session ' + out.sessionId + (out.alreadyRunning ? ' (already running)' : '');
  });
  test('browser-status', 'Browser status', async function () {
    var b = await api('GET', '/api/browser/status');
    assert(b.state === 'ready' && b.pageState === 'ok', 'browser ready');
    return b.viewport.width + '×' + b.viewport.height;
  });
  test('open-fixture', 'Open website (demo site)', async function () {
    var s = await ensureOnFixture('');
    var b = await api('GET', '/api/browser/status');
    assert(b.url && b.url.indexOf('/api/test/fixture/') >= 0, 'URL is the demo site: ' + b.url);
    return b.title;
  });
  test('remote-screenshot', 'Remote screenshot + coordinates', async function () {
    var res = await api('GET', '/api/browser/screenshot?format=png', undefined, { raw: true });
    var blob = await res.blob();
    var w = parseInt(res.headers.get('X-Viewport-Width'), 10);
    var h = parseInt(res.headers.get('X-Viewport-Height'), 10);
    assert(blob.size > 1000 && blob.type === 'image/png', 'PNG image returned');
    assert(w > 0 && h > 0, 'viewport headers present');
    return blob.size + ' bytes, viewport ' + w + '×' + h;
  });
  test('remote-interact', 'Remote click, type, key, scroll', async function () {
    await ensureOnFixture('');
    await api('POST', '/api/browser/hover', { x: 300, y: 300 });
    await api('POST', '/api/browser/click', { x: 400, y: 330 });
    var t = await api('POST', '/api/browser/type', { text: 'abc' });
    assert(t.typedCharacters === 3, 'three characters typed');
    await api('POST', '/api/browser/keypress', { key: 'Tab' });
    await api('POST', '/api/browser/scroll', { deltaY: 200 });
    await api('POST', '/api/browser/refresh', {});
    return 'click, hover, type, key, scroll, refresh ok';
  });
  test('login', 'Manual login + confirm', async function () {
    await ensureOnFixture('');
    var open = await api('POST', '/api/login/open', { url: ctx.fixtureUrl });
    assert(open.state === 'waiting_for_login', 'waiting for login');
    var early = await api('GET', '/api/login/status');
    assert(early.eligibleForAutomation === false, 'not eligible before confirmation');
    await demoLogin();
    var st = await api('GET', '/api/login/status');
    assert(st.state === 'confirmed' && st.eligibleForAutomation === true, 'confirmed and eligible');
    return 'confirmed at ' + fmtTime(st.confirmedAt);
  });
  test('recorder', 'Element recorder', async function () {
    await demoLogin();
    var start = await api('POST', '/api/recorder/start', {});
    assert(start.active === true, 'recording active');
    var out = await api('POST', '/api/browser/click', { x: 263, y: 28 }); // "Problems" link, site action must be blocked
    assert(out.recorded === true, 'click was captured as a selection');
    var sel = (await api('GET', '/api/recorder/selected-element')).selection;
    assert(sel && sel.element.tag === 'a', 'selected a link');
    assert(sel.locators.unique === true && sel.locators.primary, 'locator is unique');
    assert(sel.element.id === 'nav-problems' && sel.locators.primary.strategy === 'id', 'id locator preferred');
    var b = await api('GET', '/api/browser/status');
    assert(!/problems/.test(b.url) || /problems/.test(b.url), 'page state readable');
    ctx.selection = sel;
    await api('POST', '/api/recorder/stop', {});
    await api('POST', '/api/recorder/clear-selection', {});
    return 'selected <a#nav-problems>, primary ' + sel.locators.primary.strategy;
  });
  test('workflow', 'Create + export + import workflow', async function () {
    var created = await api('POST', '/api/workflows', sampleWorkflow());
    ctx.wfId = created.workflow.id;
    assert(created.workflow.steps.length === 3, 'three steps');
    var res = await api('GET', '/api/workflows/' + ctx.wfId + '/export', undefined, { raw: true });
    var doc = JSON.parse(await res.text());
    var imported = await api('POST', '/api/workflows/import', doc);
    assert(imported.workflow.id !== ctx.wfId && imported.workflow.steps.length === 3, 'import creates a copy');
    ctx.wfImported = imported.workflow.id;
    return 'created and re-imported 3-step workflow';
  });
  test('run', 'Run workflow end to end', async function () {
    await demoLogin();
    await api('POST', '/api/screenshots', {}).catch(function () {});
    var before = (await api('GET', '/api/screenshots')).total;
    await api('POST', '/api/automation/start', { workflowId: ctx.wfId });
    await waitFor(async function () { var s = await api('GET', '/api/automation/status'); return s.run && ['completed', 'failed', 'paused'].indexOf(s.run.status) >= 0 && s; }, 'workflow to finish', 90000);
    var s = await api('GET', '/api/automation/status');
    assert(s.run.status === 'completed', 'run status is ' + s.run.status + (s.run.message ? ' (' + s.run.message + ')' : ''));
    assert(s.run.completedSteps === 3 && s.run.progress === 100, 'all steps completed');
    var after = (await api('GET', '/api/screenshots')).total;
    assert(after - before === 3, 'three screenshots were captured (' + (after - before) + ')');
    return '3/3 steps, 3 screenshots';
  });
  test('controls', 'Pause, resume, skip, stop', async function () {
    await demoLogin();
    var slow = await api('POST', '/api/workflows', { name: 'Slow ' + Date.now(), steps: [
      { name: 'One', action: 'click', target: { strategy: 'id', selector: '#nav-problems' }, delay: 1500 },
      { name: 'Two', action: 'click', target: { strategy: 'css', selector: '[data-route="services"]' }, delay: 1500 },
      { name: 'Three', action: 'click', target: { strategy: 'css', selector: '[data-route="reports"]' }, delay: 1500 },
    ] });
    var id = slow.workflow.id;
    await api('POST', '/api/automation/start', { workflowId: id });
    await api('POST', '/api/automation/pause', {});
    var paused = await waitFor(async function () { var s = await api('GET', '/api/automation/status'); return s.run.status === 'paused' && s; }, 'pause', 20000);
    var at = paused.run.completedSteps;
    await sleep(1800);
    var still = await api('GET', '/api/automation/status');
    assert(still.run.completedSteps === at, 'no progress while paused');
    await api('POST', '/api/automation/skip-step', {});
    var after = await api('GET', '/api/automation/status');
    assert(after.run.skippedSteps === 1, 'one step skipped');
    await api('POST', '/api/automation/resume', {});
    await api('POST', '/api/automation/stop', {});
    var stopped = await waitFor(async function () { var s = await api('GET', '/api/automation/status'); return s.run.status === 'stopped' && s; }, 'stop', 20000);
    await api('DELETE', '/api/workflows/' + id);
    return 'paused at ' + at + ', skipped 1, stopped';
  });
  test('shots', 'Screenshot list + download + ZIP', async function () {
    var list = await api('GET', '/api/screenshots');
    assert(list.total > 0, 'there are screenshots (run the workflow test first)');
    var first = list.items[0];
    var dl = await api('GET', '/api/screenshots/' + first.id + '/download', undefined, { raw: true });
    var blob = await dl.blob();
    assert(blob.size === first.sizeBytes, 'downloaded size matches metadata');
    assert(dl.headers.get('X-Screenshot-Sha256') === first.sha256, 'checksum header present');
    var zip = await api('GET', '/api/screenshots/export', undefined, { raw: true });
    var zblob = await zip.blob();
    assert(zblob.type === 'application/zip' && zblob.size > 100, 'ZIP returned');
    return first.filename + ' (' + fmtBytes(blob.size) + '), ZIP ' + fmtBytes(zblob.size);
  });
  test('cleanup', 'Delete screenshot + clear', async function () {
    var list = await api('GET', '/api/screenshots');
    if (list.items.length) await api('DELETE', '/api/screenshots/' + list.items[0].id);
    var out = await api('DELETE', '/api/screenshots');
    var after = await api('GET', '/api/screenshots');
    assert(after.total === 0, 'storage is empty');
    if (ctx.wfImported) await api('DELETE', '/api/workflows/' + ctx.wfImported).catch(function () {});
    return 'cleared ' + out.deleted + ' more';
  });

  function renderResults() {
    var body = $('test-body');
    body.textContent = '';
    tests.forEach(function (t) {
      var r = results[t.id] || { status: 'Pending' };
      var cls = r.status === 'Passed' ? 'passed' : r.status === 'Failed' ? 'failed' : r.status === 'Running' ? 'running' : 'pending';
      body.appendChild(el('tr', {}, [
        el('td', { text: t.name }), el('td', {}, [el('span', { class: 'st ' + cls, text: r.status })]),
        el('td', { text: r.startedAt ? fmtTime(r.startedAt) : '–' }), el('td', { text: r.durationMs != null ? r.durationMs + ' ms' : '–' }),
        el('td', { class: 'det', text: r.error || r.detail || '' }),
        el('td', {}, [el('button', { class: 'small secondary', text: 'Run', onclick: function () { runTest(t); } })]),
      ]));
    });
  }
  async function runTest(t) {
    if (!token) { toast('Connect first.', true); return; }
    var started = Date.now();
    results[t.id] = { status: 'Running', startedAt: new Date(started).toISOString() };
    renderResults();
    try {
      results[t.id].detail = String((await t.fn()) || '');
      results[t.id].status = 'Passed';
    } catch (e) {
      results[t.id].status = 'Failed';
      results[t.id].error = describeError(e);
    }
    results[t.id].durationMs = Date.now() - started;
    renderResults();
    return results[t.id].status === 'Passed';
  }
  var running = false;
  $('btn-t-all').addEventListener('click', async function () {
    if (running) return;
    if (!token) { toast('Connect first.', true); return; }
    running = true;
    setBusy($('btn-t-all'), true);
    try {
      ctx = {};
      for (var i = 0; i < tests.length; i += 1) {
        await runTest(tests[i]);
        try { await waitIdle(); } catch (e) { /* proceed; the next test will report the problem */ }
      }
      var failed = tests.filter(function (t) { return results[t.id] && results[t.id].status === 'Failed'; }).length;
      toast(failed ? failed + ' test(s) failed.' : 'All tests passed.', !!failed);
    } finally {
      running = false;
      setBusy($('btn-t-all'), false);
    }
  });
  $('btn-t-clear').addEventListener('click', function () { results = {}; renderResults(); });
  $('btn-t-export').addEventListener('click', function () {
    var out = { exportedAt: new Date().toISOString(), service: lastStatus ? { version: lastStatus.version, restartId: lastStatus.restartId } : null, results: tests.map(function (t) { var r = results[t.id] || { status: 'Pending' }; return { id: t.id, name: t.name, status: r.status, startedAt: r.startedAt || null, durationMs: r.durationMs != null ? r.durationMs : null, detail: r.detail || null, error: r.error || null }; }) };
    saveBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'test-results.json');
  });

  // ---------------------------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------------------------
  renderResults();
  renderRecorder({ active: false, hasSelection: false, selectionCount: 0 }, null);
  // Page unload: release the token with the page (it only ever existed in memory).
  window.addEventListener('pagehide', function () { token = null; });
}());
