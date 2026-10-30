'use strict';

/**
 * Browser-side element picker.
 *
 * `pickerBootstrap` is serialised by Playwright and executed inside every frame, so it must not
 * reference anything from this module's scope. It installs `window.__ssPicker`, which provides:
 *   - deepElementFromPoint(x, y)  hit-testing that descends through open shadow roots
 *   - describe(el) / ancestry(el) raw facts about an element (never form values)
 *   - highlightElement / clearHighlight  the visible border + tooltip drawn into the page
 *   - enable / disable / pause / resume  swallowing of site click handlers while recording
 *
 * The overlay is `pointer-events: none`, so it never interferes with hit-testing, and it lives in
 * the page DOM so that it shows up in the remote screenshots the user is looking at.
 */
function pickerBootstrap() {
  const VERSION = 3;
  if (window.__ssPicker && window.__ssPicker.version === VERSION) return true;
  if (window.__ssPicker && typeof window.__ssPicker.disable === 'function') window.__ssPicker.disable();

  const OVERLAY_ID = '__ss-picker-overlay';
  const BLOCKED_EVENTS = [
    'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'auxclick', 'contextmenu', 'submit', 'touchstart', 'touchend', 'dragstart',
  ];
  const state = { enabled: false, paused: false };

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 25) {
      guard += 1;
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  const IMPLICIT_ROLES = {
    a: (el) => (el.hasAttribute('href') ? 'link' : null),
    area: (el) => (el.hasAttribute('href') ? 'link' : null),
    article: () => 'article', aside: () => 'complementary', button: () => 'button',
    dialog: () => 'dialog', details: () => 'group', fieldset: () => 'group', figure: () => 'figure',
    footer: () => 'contentinfo', form: () => 'form', h1: () => 'heading', h2: () => 'heading',
    h3: () => 'heading', h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    header: () => 'banner', hr: () => 'separator', img: (el) => (el.getAttribute('alt') === '' ? 'presentation' : 'img'),
    li: () => 'listitem', main: () => 'main', menu: () => 'list', nav: () => 'navigation',
    ol: () => 'list', option: () => 'option', output: () => 'status', progress: () => 'progressbar',
    section: (el) => (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null),
    select: (el) => (el.multiple || el.size > 1 ? 'listbox' : 'combobox'),
    summary: () => 'button', table: () => 'table', tbody: () => 'rowgroup', td: () => 'cell',
    textarea: () => 'textbox', tfoot: () => 'rowgroup', th: () => 'columnheader', thead: () => 'rowgroup',
    tr: () => 'row', ul: () => 'list',
    input: (el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      // ARIA defines no implicit role for password or hidden inputs.
      if (t === 'hidden' || t === 'password') return null;
      return 'textbox';
    },
  };

  function roleOf(el) {
    const explicit = norm(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit.toLowerCase();
    const fn = IMPLICIT_ROLES[el.tagName.toLowerCase()];
    return fn ? fn(el) : null;
  }

  function textFromIds(el, attr) {
    const ids = norm(el.getAttribute(attr)).split(' ').filter(Boolean);
    const root = el.getRootNode();
    return norm(
      ids
        .map((id) => {
          const ref = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
          return ref ? ref.textContent : '';
        })
        .join(' '),
    );
  }

  /** Approximation of the accessible name computation (good enough to propose a role locator, which is then verified live). */
  function accessibleName(el) {
    const tag = el.tagName.toLowerCase();
    const byIds = el.hasAttribute('aria-labelledby') ? textFromIds(el, 'aria-labelledby') : '';
    if (byIds) return byIds;
    const label = norm(el.getAttribute('aria-label'));
    if (label) return label;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.labels && el.labels.length) {
        const t = norm(Array.from(el.labels).map((l) => l.textContent).join(' '));
        if (t) return t;
      }
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return norm(el.getAttribute('value')) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (type === 'image') return norm(el.getAttribute('alt'));
      return norm(el.getAttribute('placeholder')) || norm(el.getAttribute('title'));
    }
    if (tag === 'img' || tag === 'area') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
    const text = norm(el.innerText || el.textContent);
    if (text) return text.slice(0, 200);
    return norm(el.getAttribute('title'));
  }

  const SENSITIVE_HINT = /pass(word|wd)?|otp|mfa|token|secret|cvv|cvc|ssn|card.?number|security.?code/i;

  function isSensitive(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password' || /one-time-code|current-password|new-password|cc-/.test(ac)) return true;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    return SENSITIVE_HINT.test([el.id, el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '));
  }

  function classList(el) {
    return Array.from(el.classList || []).slice(0, 30);
  }

  function dataAttributes(el) {
    const out = {};
    let n = 0;
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-') && attr.value.length <= 100 && n < 12) {
        out[attr.name] = attr.value;
        n += 1;
      }
    }
    return out;
  }

  function pathOnly(href) {
    try {
      const u = new URL(href, location.href);
      return u.origin === location.origin ? u.pathname : u.origin + u.pathname;
    } catch (e) {
      return null;
    }
  }

  function shadowInfo(el) {
    const chain = [];
    let root = el.getRootNode();
    let guard = 0;
    while (root && root instanceof ShadowRoot && guard < 10) {
      guard += 1;
      const host = root.host;
      chain.unshift(host.tagName.toLowerCase() + (host.id ? '#' + host.id : ''));
      root = host.getRootNode();
    }
    return { inShadow: chain.length > 0, hostChain: chain };
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const isFormValue = tag === 'input' || tag === 'textarea' || tag === 'select';
    const sensitive = isSensitive(el);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const attrs = {};
    for (const name of ['name', 'type', 'placeholder', 'title', 'alt', 'aria-label', 'aria-controls', 'role', 'for', 'target', 'rel']) {
      const v = el.getAttribute(name);
      if (v != null && v.length <= 150) attrs[name] = v;
    }
    if (sensitive) delete attrs.placeholder;
    const href = el.getAttribute('href');
    const shadow = shadowInfo(el);
    return {
      tag,
      id: el.id || null,
      classes: classList(el),
      text: isFormValue || sensitive ? '' : norm(el.innerText || el.textContent).slice(0, 120),
      role: roleOf(el),
      name: sensitive ? '' : accessibleName(el).slice(0, 200),
      attributes: attrs,
      dataAttributes: dataAttributes(el),
      hrefPath: href ? pathOnly(href) : null,
      inputType: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
      isFormControl: isFormValue,
      inForm: Boolean(el.form || el.closest('form')),
      sensitive,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      shadow,
      possibleClosedShadowRoot: tag.indexOf('-') > 0 && !el.shadowRoot && el.children.length === 0 && !norm(el.textContent),
      frame: { url: location.href, name: window.name || null, isTop: window === window.top },
    };
  }

  /**
   * Ancestors from the element up to <html>, innermost first, for CSS/XPath construction.
   * Open shadow roots are crossed (the host becomes the next ancestor); `crossesShadow` marks an entry
   * whose link to its parent is a shadow boundary, where a descendant combinator must replace ">".
   */
  function ancestry(el) {
    const out = [];
    let node = el;
    while (node && node.nodeType === 1 && out.length < 40) {
      let parent = node.parentElement;
      let crossesShadow = false;
      if (!parent) {
        const root = node.getRootNode();
        if (root instanceof ShadowRoot) {
          parent = root.host;
          crossesShadow = true;
        }
      }
      const siblingParent = node.parentNode;
      const kids = siblingParent && siblingParent.children ? Array.from(siblingParent.children) : [node];
      const same = kids.filter((k) => k.tagName === node.tagName);
      out.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        classes: classList(node),
        data: dataAttributes(node),
        name: node.getAttribute('name'),
        role: node.getAttribute('role'),
        index: same.indexOf(node) + 1,
        sameTag: same.length,
        childIndex: kids.indexOf(node) + 1,
        crossesShadow,
      });
      node = parent;
    }
    return out;
  }

  // -- highlight overlay ----------------------------------------------------------------------

  function ensureOverlay() {
    let box = document.getElementById(OVERLAY_ID);
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.setAttribute('data-ss-picker', 'overlay');
    box.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #ff7a00;background:rgba(255,122,0,.12);border-radius:2px;';
    const tip = document.createElement('div');
    tip.style.cssText = 'all:initial;position:fixed;left:0;top:0;max-width:520px;pointer-events:none;z-index:2147483647;box-sizing:border-box;padding:4px 8px;border-radius:4px;font:12px/1.35 ui-monospace,Consolas,monospace;color:#fff;background:#1d1d1f;white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    tip.setAttribute('data-ss-picker', 'tooltip');
    box.__tip = tip;
    (document.documentElement || document.body).appendChild(box);
    (document.documentElement || document.body).appendChild(tip);
    return box;
  }

  function tooltipText(el) {
    const d = describe(el);
    const cls = d.classes.slice(0, 3).map((c) => '.' + c).join('');
    let head = d.tag + (d.id ? '#' + d.id : '') + cls;
    const bits = [head];
    if (d.role) bits.push('role=' + d.role + (d.name ? ' "' + d.name.slice(0, 50) + '"' : ''));
    else if (d.text) bits.push('"' + d.text.slice(0, 60) + '"');
    bits.push(d.rect.width + 'x' + d.rect.height);
    if (d.sensitive) bits.push('(sensitive field)');
    return bits.join('\n');
  }

  function highlightElement(el, mode) {
    const box = ensureOverlay();
    const tip = box.__tip;
    const rect = el.getBoundingClientRect();
    const color = mode === 'selected' ? '#00c853' : '#ff7a00';
    box.style.borderColor = color;
    box.style.background = mode === 'selected' ? 'rgba(0,200,83,.14)' : 'rgba(255,122,0,.12)';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = Math.max(rect.width, 1) + 'px';
    box.style.height = Math.max(rect.height, 1) + 'px';
    tip.textContent = (mode === 'selected' ? 'SELECTED  ' : '') + tooltipText(el);
    tip.style.background = mode === 'selected' ? '#0b6b32' : '#1d1d1f';
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.top - tipRect.height - 6;
    if (top < 4) top = Math.min(rect.bottom + 6, vh - tipRect.height - 4);
    let left = Math.min(Math.max(rect.left, 4), Math.max(4, vw - tipRect.width - 4));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(4, top) + 'px';
    return true;
  }

  function clearHighlight() {
    const box = document.getElementById(OVERLAY_ID);
    if (box) {
      if (box.__tip) box.__tip.remove();
      box.remove();
    }
    return true;
  }

  // -- blocking of site actions while recording -----------------------------------------------

  function blocker(event) {
    if (!state.enabled || state.paused) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  function enable() {
    if (state.enabled) return true;
    state.enabled = true;
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, blocker, true);
    return true;
  }

  function disable() {
    state.enabled = false;
    state.paused = false;
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, blocker, true);
    clearHighlight();
    return true;
  }

  window.__ssPicker = {
    version: VERSION,
    deepElementFromPoint,
    describe,
    ancestry,
    highlightElement,
    clearHighlight,
    enable,
    disable,
    pause() { state.paused = true; return true; },
    resume() { state.paused = false; return true; },
    isEnabled() { return state.enabled; },
  };
  return true;
}

module.exports = { pickerBootstrap };
