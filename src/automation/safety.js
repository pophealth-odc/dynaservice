'use strict';

/**
 * Heuristics for "this click might do something that cannot be undone".
 *
 * The automation engine only runs explicitly configured actions, but a recorded locator can still point
 * at a "Delete" or "Pay now" button. Such clicks are refused unless the step carries
 * `allowDestructive: true` AND the run was started with `confirmDestructive: true`.
 */

const CATEGORIES = [
  { reason: 'delete', re: /\b(delete|remove|destroy|erase|purge|wipe|discard|trash)\b/i },
  { reason: 'payment', re: /\b(pay|payment|purchase|buy|checkout|place[- ]order|order now|subscribe|upgrade plan|donate)\b/i },
  { reason: 'logout', re: /\b(log[- ]?out|sign[- ]?out|end session)\b/i },
  { reason: 'account', re: /\b(deactivate|disable account|close account|terminate|revoke|unsubscribe|cancel (my )?(subscription|account|plan|order))\b/i },
  { reason: 'form_submit', re: /\b(submit|save changes|apply changes|confirm|transfer|reset (password|all)|send now)\b/i },
];
// Links that end in a logout / delete style path segment. Paths such as /checkout or /payments are NOT listed:
// they usually just open a page, and monitoring tools are full of services with those names.
const HREF_RE = /(?:^|\/)(?:log[-_]?out|sign[-_]?out)(?:[/?#]|$)|\/(?:delete|remove|destroy)(?:[/?#]|$)/i;
const MAX_LABEL_LENGTH = 80;
// A link only navigates, so wording about paying or submitting says nothing about what it does. Wording about
// deleting, logging out or closing an account still counts: those links are commonly GET endpoints.
const LINK_REASONS = new Set(['delete', 'logout', 'account']);

/**
 * @param info facts about the element ({ tag, text, name, attributes, hrefPath, inputType, inForm, id, classes })
 * @returns {{ destructive: boolean, reason: string|null, matched: string|null }}
 */
function assessElement(info) {
  if (!info || typeof info !== 'object') return { destructive: false, reason: null, matched: null };
  const attrs = info.attributes || {};
  const isLink = info.tag === 'a' || info.role === 'link';

  // Long text usually belongs to a container; only short labels say what the control does.
  const labels = [info.name, info.text, attrs.title, attrs['aria-label'], attrs.alt, attrs.value]
    .filter((l) => typeof l === 'string' && l.trim() && l.length <= MAX_LABEL_LENGTH);
  const identifiers = [info.id, ...(info.classes || []).slice(0, 8)].filter(Boolean).join(' ').replace(/[-_]+/g, ' ');

  for (const { reason, re } of CATEGORIES) {
    if (isLink && !LINK_REASONS.has(reason)) continue;
    for (const label of [...labels, identifiers]) {
      const m = re.exec(label);
      if (m) return { destructive: true, reason, matched: m[0].toLowerCase() };
    }
  }
  if (info.hrefPath && HREF_RE.test(info.hrefPath)) {
    return { destructive: true, reason: 'logout_or_delete_link', matched: info.hrefPath };
  }
  const isSubmit =
    (info.tag === 'button' && (attrs.type || 'submit').toLowerCase() === 'submit' && info.inForm) ||
    (info.tag === 'input' && ['submit', 'image'].includes(info.inputType) && info.inForm);
  if (isSubmit) return { destructive: true, reason: 'form_submit', matched: 'submit button' };
  return { destructive: false, reason: null, matched: null };
}

const REASON_TEXT = {
  delete: 'looks like it deletes or removes something',
  payment: 'looks like a payment or purchase action',
  logout: 'looks like it logs the user out',
  account: 'looks like it changes or closes an account',
  form_submit: 'looks like it submits a form or confirms a change',
  logout_or_delete_link: 'links to a logout or delete address',
};

const describeReason = (reason) => REASON_TEXT[reason] || 'may be destructive';

module.exports = { assessElement, describeReason };
