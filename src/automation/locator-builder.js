'use strict';

/**
 * Locator specs
 * -------------
 * A locator spec is a small JSON object stored inside workflow steps:
 *
 *   { strategy: 'id' | 'data' | 'role' | 'css' | 'text' | 'xpath',
 *     selector?: string,            // id / data / css / xpath
 *     role?: string, name?: string, // role
 *     text?: string,                // text
 *     exact?: boolean,              // role name / text matching (default true)
 *     frames?: string[],            // chain of <iframe> selectors leading to the element
 *     index?: number,               // pick the n-th match on purpose (0-based)
 *     fallbacks?: LocatorSpec[],    // alternatives tried in order when the primary is not unique
 *     description?, tag?, stability? }
 *
 * Specs are resolved with Playwright's locator API only. Nothing is evaluated as script.
 */

const STRATEGIES = ['id', 'data', 'role', 'css', 'text', 'xpath'];
const STRATEGY_PRIORITY = { id: 1, data: 2, role: 3, css: 4, text: 5, xpath: 6 };

const DATA_ATTR_PRIORITY = [
  'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
  'data-automation-id', 'data-automationid', 'data-e2e', 'data-id', 'data-name', 'data-component',
];
const IGNORED_DATA_ATTRS = /^data-(ss-|reactid|react-|reactroot|v-|vue|ember|radix|state|focus|hover|selected|active|open|testid-dynamic)/i;
const STATE_CLASS = /^(active|selected|current|open|opened|closed|show|shown|hide|hidden|visible|focus|focused|hover|hovered|disabled|enabled|checked|loading|loaded|expanded|collapsed|is-.+|has-.+|ng-.+|mat-.+-(active|focused)|ui-state-.+)$/i;

const MAX_SELECTOR_LENGTH = 1000;
const MAX_TEXT_LENGTH = 200;

function looksDynamic(token) {
  if (!token) return true;
  const t = String(token);
  if (t.length > 60) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(t)) return true; // UUID
  if (/\d{4,}/.test(t)) return true; // long digit runs (timestamps, counters)
  if (/^(:r[0-9a-z]*:|ember\d+|react-|radix-|headlessui-|mui-\d+|rc[-_]|ng-|__|js-)/i.test(t)) return true;
  if (/^(css|sc|jss|emotion|styled|svelte|astro|_)[-_]?[a-z0-9]{5,}$/i.test(t)) return true; // css-in-js hashes
  if (/^[a-z]{1,3}[-_]?[0-9a-f]{6,}$/i.test(t)) return true;
  if (/^[A-Za-z0-9]{24,}$/.test(t)) return true; // long opaque token
  return false;
}

/** CSS.escape equivalent (CSSOM spec) so identifiers are safe inside selectors. */
function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (code === 0) out += '�';
    else if ((code >= 1 && code <= 31) || code === 127) out += `\\${code.toString(16)} `;
    else if (i === 0 && code >= 48 && code <= 57) out += `\\${code.toString(16)} `;
    else if (i === 1 && code >= 48 && code <= 57 && s.charCodeAt(0) === 45) out += `\\${code.toString(16)} `;
    else if (i === 0 && code === 45 && s.length === 1) out += `\\${ch}`;
    else if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/** Quote a value for use inside an attribute selector: [attr="value"]. */
function cssString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '')}"`;
}

function xpathString(value) {
  const s = String(value);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat(${s.split('"').map((p) => `"${p}"`).join(`, '"', `)})`;
}

const stableClasses = (classes = []) =>
  classes.filter((c) => c && c.length <= 40 && !looksDynamic(c) && !STATE_CLASS.test(c) && /^[A-Za-z_][\w-]*$/.test(c));

const isStableId = (id) => Boolean(id) && !looksDynamic(id) && id.length <= 80;

function dataEntries(data = {}) {
  const names = Object.keys(data).filter((n) => !IGNORED_DATA_ATTRS.test(n) && data[n] && !looksDynamic(data[n]));
  const preferred = DATA_ATTR_PRIORITY.filter((n) => names.includes(n));
  return [...preferred, ...names.filter((n) => !preferred.includes(n))];
}

function nodeSimple(node, { withClasses = true } = {}) {
  let sel = node.tag;
  if (isStableId(node.id)) return `${node.tag}#${cssEscape(node.id)}`;
  const dn = dataEntries(node.data)[0];
  if (dn) return `${node.tag}[${dn}=${cssString(node.data[dn])}]`;
  if (withClasses) {
    const cls = stableClasses(node.classes).slice(0, 2);
    if (cls.length) sel += cls.map((c) => `.${cssEscape(c)}`).join('');
  }
  return sel;
}

/**
 * Nearest node with a stable id or data attribute, with its index in `ancestry`. Starts at `from`:
 * 1 skips the element itself (used to scope a variant selector under an ancestor), 0 includes it.
 */
function findAnchor(ancestry, maxDepth = 8, from = 1) {
  for (let i = from; i < ancestry.length && i <= maxDepth; i += 1) {
    const node = ancestry[i];
    if (isStableId(node.id)) return { index: i, selector: `#${cssEscape(node.id)}` };
    const dn = dataEntries(node.data)[0];
    if (dn) return { index: i, selector: `[${dn}=${cssString(node.data[dn])}]` };
  }
  return null;
}

/** Joins selector parts (outermost first), using a descendant combinator across shadow-root boundaries. */
function joinParts(parts) {
  return parts.reduce((acc, part, i) => {
    if (i === 0) return part.sel;
    return `${acc}${part.crossesShadow ? ' ' : ' > '}${part.sel}`;
  }, '');
}

function positionalCss(ancestry) {
  const anchor = findAnchor(ancestry, 40, 0);
  const last = anchor ? anchor.index : ancestry.length - 1;
  const parts = [];
  for (let i = last; i >= 0; i -= 1) {
    const node = ancestry[i];
    if (anchor && i === last) {
      parts.push({ sel: anchor.selector, crossesShadow: false });
      continue;
    }
    // `child` is the node below `anchor`; its link to the parent decides the combinator.
    parts.push({ sel: node.sameTag > 1 ? `${node.tag}:nth-of-type(${node.index})` : node.tag, crossesShadow: node.crossesShadow });
  }
  return joinParts(parts);
}

function xpathFor(ancestry) {
  if (ancestry.some((n) => n.crossesShadow)) return null; // XPath cannot pierce shadow DOM
  const anchor = findAnchor(ancestry, 40, 0);
  const last = anchor ? anchor.index : ancestry.length - 1;
  let path = '';
  for (let i = last; i >= 0; i -= 1) {
    const node = ancestry[i];
    if (anchor && i === last) {
      const attr = anchor.selector.startsWith('#') ? `@id=${xpathString(ancestry[i].id)}` : null;
      if (attr) {
        path = `//*[${attr}]`;
      } else {
        const dn = dataEntries(node.data)[0];
        path = `//*[@${dn}=${xpathString(node.data[dn])}]`;
      }
      continue;
    }
    path += `/${node.tag}${node.sameTag > 1 ? `[${node.index}]` : ''}`;
  }
  return anchor ? path : `/${path.replace(/^\//, '')}`;
}

function cssVariants(info, ancestry) {
  const self = ancestry[0];
  const variants = [];
  const attrs = info.attributes || {};
  const tag = info.tag;
  if (attrs['aria-label']) variants.push(`${tag}[aria-label=${cssString(attrs['aria-label'])}]`);
  if (attrs.name && !info.sensitive) variants.push(`${tag}[name=${cssString(attrs.name)}]`);
  if (attrs.title) variants.push(`${tag}[title=${cssString(attrs.title)}]`);
  if (attrs.alt) variants.push(`${tag}[alt=${cssString(attrs.alt)}]`);
  if (attrs.placeholder && !info.sensitive) variants.push(`${tag}[placeholder=${cssString(attrs.placeholder)}]`);
  const cls = stableClasses(info.classes).slice(0, 2);
  if (cls.length) variants.push(`${tag}${cls.map((c) => `.${cssEscape(c)}`).join('')}`);
  if (info.hrefPath && info.hrefPath.length <= 150) variants.push(`${tag}[href*=${cssString(info.hrefPath)}]`);
  if (!variants.length) variants.push(nodeSimple(self));
  return [...new Set(variants)];
}

function textCandidate(info) {
  const text = (info.text || '').trim();
  if (!text || info.sensitive || info.isFormControl) return null;
  if (text.length > 80 || /\n/.test(text)) return null;
  return text;
}

/**
 * Build the ordered list of locator candidates for one element.
 * @param info      raw facts from the in-page picker (`__ssPicker.describe`)
 * @param ancestry  innermost-first ancestor chain (`__ssPicker.ancestry`)
 * @param frames    selectors of the iframe elements leading to the element's frame
 */
function buildCandidates(info, ancestry, { frames = [] } = {}) {
  const out = [];
  const add = (spec) => out.push({ ...spec, frames: frames.length ? [...frames] : undefined, tag: info.tag });
  const self = ancestry[0];

  // 1. unique, stable id
  if (isStableId(info.id)) {
    add({ strategy: 'id', selector: `#${cssEscape(info.id)}`, label: `id "${info.id}"`, stability: 'high' });
  }
  // 2. stable data attributes
  for (const name of dataEntries(info.dataAttributes)) {
    add({ strategy: 'data', selector: `[${name}=${cssString(info.dataAttributes[name])}]`, label: `${name}="${info.dataAttributes[name]}"`, stability: 'high' });
  }
  // 3. accessible role and name
  if (info.role && info.name && !info.sensitive && info.name.length <= 120 && !['generic', 'presentation', 'none'].includes(info.role)) {
    add({ strategy: 'role', role: info.role, name: info.name, exact: true, label: `${info.role} "${info.name}"`, stability: 'high' });
  }
  // 4. CSS: attribute/class variants, anchored variants, finally the positional path
  const anchor = findAnchor(ancestry, 8);
  for (const variant of cssVariants(info, ancestry)) {
    add({ strategy: 'css', selector: variant, label: `css ${variant}`, stability: 'medium' });
    if (anchor) {
      add({ strategy: 'css', selector: `${anchor.selector} ${variant}`, label: `css ${anchor.selector} ${variant}`, stability: 'medium' });
    }
  }
  const positional = positionalCss(ancestry);
  if (positional && !out.some((c) => c.strategy === 'css' && c.selector === positional)) {
    add({ strategy: 'css', selector: positional, label: 'css position path', stability: 'low' });
  }
  // 5. text
  const text = textCandidate(info);
  if (text) add({ strategy: 'text', text, exact: true, label: `text "${text}"`, stability: 'medium' });
  // 6. xpath fallback
  const xp = xpathFor(ancestry);
  if (xp && xp.length <= MAX_SELECTOR_LENGTH) add({ strategy: 'xpath', selector: xp, label: 'xpath position path', stability: 'low' });

  // Deduplicate identical selectors while preserving priority order.
  const seen = new Set();
  return out
    .filter((c) => {
      const key = `${c.strategy}|${c.selector ?? ''}|${c.role ?? ''}|${c.name ?? ''}|${c.text ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return (c.selector ?? c.text ?? c.name ?? '').length <= MAX_SELECTOR_LENGTH;
    })
    .map((c) => ({ ...c, priority: STRATEGY_PRIORITY[c.strategy] }));
}

/** Strip evaluation-only fields so a candidate can be stored in a workflow step. */
function toStoredSpec(candidate, extras = {}) {
  const { label, priority, matches, unique, relation, usable, ...rest } = candidate;
  const spec = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) spec[k] = v;
  return { ...spec, ...extras };
}

/**
 * Pick the primary locator and fallbacks from candidates that have been validated against the live page.
 * `evaluated` entries carry `matches` (count) and `relation` ('same' | 'descendant' | ...).
 */
function pickBest(evaluated, { description } = {}) {
  const usable = evaluated.filter((c) => c.matches === 1 && (c.relation === 'same' || (c.strategy === 'text' && c.relation === 'descendant')));
  const ambiguous = evaluated.filter((c) => c.matches > 1);
  if (!usable.length) {
    return {
      primary: null,
      fallbacks: [],
      unique: false,
      ambiguous: ambiguous.length > 0,
      message: ambiguous.length
        ? 'No locator matched exactly one element. Provide a more specific selector (for example a data-testid, or a CSS selector that includes a parent).'
        : 'No locator could be validated against the page (the element may be in a closed shadow root or a restricted frame).',
      ambiguousCandidates: ambiguous,
    };
  }
  const [first, ...rest] = usable;
  const fallbacks = rest.slice(0, 3);
  const xpath = rest.find((c) => c.strategy === 'xpath');
  if (xpath && !fallbacks.includes(xpath)) fallbacks.push(xpath);
  const primary = toStoredSpec(first, { description: description || undefined });
  primary.fallbacks = fallbacks.map((c) => toStoredSpec(c));
  const warnings = [];
  if (first.stability === 'low') {
    warnings.push('Only a position-based locator is unique for this element; it may break when the page layout changes. Prefer adding a data-testid or aria-label to the page.');
  }
  if (ambiguous.length) {
    warnings.push(`${ambiguous.length} higher-priority locator(s) matched several elements and were not used.`);
  }
  return { primary, fallbacks: primary.fallbacks, unique: true, ambiguous: false, warnings, ambiguousCandidates: ambiguous };
}

// ---------------------------------------------------------------------------------------------
// Resolution + validation of stored specs
// ---------------------------------------------------------------------------------------------

/** Turn a stored spec into a Playwright Locator on `page` (honouring the frame chain). */
function resolveLocator(page, spec) {
  let scope = page;
  for (const frameSelector of spec.frames || []) scope = scope.frameLocator(frameSelector);
  let locator;
  switch (spec.strategy) {
    case 'role':
      locator = scope.getByRole(spec.role, { name: spec.name, exact: spec.exact !== false });
      break;
    case 'text':
      locator = scope.getByText(spec.text, { exact: spec.exact !== false });
      break;
    case 'xpath':
      locator = scope.locator(`xpath=${spec.selector}`);
      break;
    default:
      locator = scope.locator(`css=${spec.selector}`);
  }
  return Number.isInteger(spec.index) ? locator.nth(spec.index) : locator;
}

/** Short, human-readable description of a spec for logs, events and error messages. */
function describeSpec(spec) {
  if (!spec) return '(no target)';
  const frames = spec.frames?.length ? ` in frame ${spec.frames.join(' > ')}` : '';
  const idx = Number.isInteger(spec.index) ? ` [#${spec.index}]` : '';
  switch (spec.strategy) {
    case 'role':
      return `role ${spec.role} named "${spec.name ?? ''}"${idx}${frames}`;
    case 'text':
      return `text "${spec.text}"${idx}${frames}`;
    case 'xpath':
      return `xpath ${spec.selector}${idx}${frames}`;
    default:
      return `${spec.strategy} ${spec.selector}${idx}${frames}`;
  }
}

const ROLE_RE = /^[a-z][a-z-]{1,30}$/;

/** Structural validation of a spec (no page needed). Returns a list of problems; empty means valid. */
function validateLocatorSpec(spec, path = 'target', depth = 0) {
  const problems = [];
  const bad = (msg) => problems.push({ path, message: msg });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    bad('Locator must be an object.');
    return problems;
  }
  if (!STRATEGIES.includes(spec.strategy)) {
    bad(`strategy must be one of: ${STRATEGIES.join(', ')}.`);
    return problems;
  }
  const needsSelector = ['id', 'data', 'css', 'xpath'].includes(spec.strategy);
  if (needsSelector) {
    if (typeof spec.selector !== 'string' || !spec.selector.trim()) bad('selector is required.');
    else if (spec.selector.length > MAX_SELECTOR_LENGTH) bad(`selector is longer than ${MAX_SELECTOR_LENGTH} characters.`);
    else if (/>>|internal:|\bjs=|\bjavascript:/i.test(spec.selector)) bad('selector must be a plain CSS/XPath expression (engine chaining is not allowed).');
  }
  if (spec.strategy === 'role') {
    if (typeof spec.role !== 'string' || !ROLE_RE.test(spec.role)) bad('role must be a lowercase ARIA role name.');
    if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length > MAX_TEXT_LENGTH)) bad('name must be a string up to 200 characters.');
  }
  if (spec.strategy === 'text' && (typeof spec.text !== 'string' || !spec.text.trim() || spec.text.length > MAX_TEXT_LENGTH)) {
    bad('text is required (up to 200 characters).');
  }
  if (spec.exact !== undefined && typeof spec.exact !== 'boolean') bad('exact must be a boolean.');
  if (spec.index !== undefined && (!Number.isInteger(spec.index) || spec.index < 0 || spec.index > 1000)) bad('index must be an integer between 0 and 1000.');
  if (spec.frames !== undefined) {
    if (!Array.isArray(spec.frames) || spec.frames.length > 6 || spec.frames.some((f) => typeof f !== 'string' || !f.trim() || f.length > 300 || /internal:|\bjs=/i.test(f))) {
      bad('frames must be an array of up to 6 iframe selectors.');
    }
  }
  if (spec.fallbacks !== undefined) {
    if (depth > 0) bad('fallbacks cannot be nested.');
    else if (!Array.isArray(spec.fallbacks) || spec.fallbacks.length > 6) bad('fallbacks must be an array of up to 6 locators.');
    else spec.fallbacks.forEach((f, i) => problems.push(...validateLocatorSpec(f, `${path}.fallbacks[${i}]`, depth + 1)));
  }
  return problems;
}

/** Copy only the known fields of a spec (drops unknown keys and evaluation-only fields). */
function normalizeLocatorSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = {};
  for (const key of ['strategy', 'selector', 'role', 'name', 'text', 'exact', 'frames', 'index', 'description', 'tag', 'stability']) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
  if (Array.isArray(spec.fallbacks)) out.fallbacks = spec.fallbacks.map(normalizeLocatorSpec);
  return out;
}

/** The primary spec followed by its fallbacks, each without nested fallbacks. */
function specChain(spec) {
  if (!spec) return [];
  const { fallbacks, ...primary } = spec;
  return [primary, ...(fallbacks || [])];
}

module.exports = {
  STRATEGIES,
  looksDynamic,
  cssEscape,
  cssString,
  buildCandidates,
  pickBest,
  toStoredSpec,
  resolveLocator,
  describeSpec,
  validateLocatorSpec,
  normalizeLocatorSpec,
  specChain,
  stableClasses,
  positionalCss,
  xpathFor,
};
