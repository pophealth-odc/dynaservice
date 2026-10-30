'use strict';

/*
 * Demo single-page app used by the test console. It has no backend and no real accounts:
 *  - "login" accepts any username with the password "demo" (and any 6 digits when the one-time code is shown)
 *  - the session lives in this tab's sessionStorage only
 *  - navigation uses history.pushState, so route changes fire no page load (like many real dashboards)
 */
(function () {
  var BASE = '/api/test/fixture';
  var TOKEN_KEY = 'demo-session';
  var $ = function (id) { return document.getElementById(id); };
  var views = ['login', 'problems', 'services', 'service-detail', 'reports', 'notfound'];

  function loggedIn() { return sessionStorage.getItem(TOKEN_KEY) === '1'; }

  function show(name, title) {
    views.forEach(function (v) { $('view-' + v).hidden = v !== name; });
    document.title = title || 'Demo Monitoring App';
    document.querySelectorAll('.nav-link').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === name || (name === 'service-detail' && a.getAttribute('data-route') === 'services'));
    });
    $('logout').hidden = !loggedIn();
    $('whoami').hidden = !loggedIn();
  }

  function route(path) {
    var rel = path.replace(BASE, '').replace(/^\/+|\/+$/g, '');
    if (!loggedIn() && rel !== '') { history.replaceState({}, '', BASE + '/'); rel = ''; }
    if (!loggedIn()) {
      show('login', 'Sign in - Demo Monitoring App');
      $('username').focus(); // lets a remote user (or the test console) start typing immediately
      return undefined;
    }
    if (rel === '' || rel === 'problems') return show('problems', 'Problems - Demo Monitoring App');
    if (rel === 'services') {
      show('services', 'Services - Demo Monitoring App');
      // The list renders late, like data fetched by a real dashboard.
      $('services-list').hidden = true;
      $('services-loading').hidden = false;
      clearTimeout(route.timer);
      route.timer = setTimeout(function () { $('services-loading').hidden = true; $('services-list').hidden = false; }, 700);
      return undefined;
    }
    if (rel.indexOf('services/') === 0) {
      var name = rel.split('/')[1];
      $('service-title').textContent = name + '-service';
      return show('service-detail', name + '-service - Demo Monitoring App');
    }
    if (rel === 'reports') return show('reports', 'Reports - Demo Monitoring App');
    return show('notfound', 'Not found - Demo Monitoring App');
  }

  function go(path) {
    history.pushState({}, '', path);
    route(path);
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="' + BASE + '"]');
    if (link) { event.preventDefault(); go(link.getAttribute('href')); }
  });
  window.addEventListener('popstate', function () { route(location.pathname); });

  // -- login -----------------------------------------------------------------------------------
  var stage = 'credentials';
  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var err = $('login-error');
    err.hidden = true;
    if (stage === 'credentials') {
      if (!$('username').value.trim() || $('password').value !== 'demo') {
        err.textContent = 'Invalid username or password.';
        err.hidden = false;
        return;
      }
      stage = 'mfa';
      $('mfa-box').hidden = false;
      $('username').disabled = true;
      $('password').disabled = true;
      $('login-submit').textContent = 'Verify';
      $('mfa').focus();
      return;
    }
    if (!/^\d{6}$/.test($('mfa').value.trim())) {
      err.textContent = 'Enter a 6 digit code.';
      err.hidden = false;
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, '1');
    $('whoami').textContent = $('username').value.trim();
    history.pushState({}, '', BASE + '/problems');
    route(location.pathname);
  });

  $('logout').addEventListener('click', function () {
    sessionStorage.removeItem(TOKEN_KEY);
    history.replaceState({}, '', BASE + '/');
    location.reload();
  });

  // -- page behaviour --------------------------------------------------------------------------
  document.addEventListener('click', function (event) {
    var open = event.target.closest && event.target.closest('.row-open');
    if (open) {
      var row = open.closest('tr');
      var d = $('problem-detail');
      d.textContent = 'Opened problem ' + row.children[0].textContent + ': ' + row.children[1].textContent;
      d.hidden = false;
    }
  });
  $('btn-refresh').addEventListener('click', function () {
    var r = $('reports-result'); r.textContent = 'Reports refreshed at ' + new Date().toLocaleTimeString(); r.hidden = false;
  });
  $('btn-delete').addEventListener('click', function () {
    var r = $('reports-result'); r.textContent = 'All reports deleted (demo).'; r.hidden = false;
    window.__demoDeleted = (window.__demoDeleted || 0) + 1;
  });

  // -- open shadow DOM component ---------------------------------------------------------------
  customElements.define('status-badge', class extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.wrap{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #d9deea;border-radius:8px;padding:10px 14px;width:max-content}button{padding:6px 12px;border:0;border-radius:6px;background:#1b7f3b;color:#fff;font:inherit;font-weight:600;cursor:pointer}</style>' +
        '<div class="wrap"><span id="state">Status: unknown</span><button type="button" class="check">Check status</button></div>';
      var state = root.getElementById('state');
      root.querySelector('.check').addEventListener('click', function () { state.textContent = 'Status: healthy'; });
    }
  });

  route(location.pathname);
}());
