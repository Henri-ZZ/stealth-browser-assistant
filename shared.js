// Shared utilities for Stealth Tabs: storage keys, keyword matching, hidden-tab registry.
// Imported by background.js, popup.js and options.js as an ES module.

export const STORAGE_KEYS = {
  KEYWORDS: 'keywords',
  HIDDEN: 'hiddenTabs', // array of HiddenRecord
  SCRIPT_MUTE: 'scriptMute', // boolean: user toggled mute via popup (script-level, not Chrome API)
  HIDE_MODE: 'hideMode', // boolean: auto-hide matching tabs while on
  LANG_PREF: 'langPref', // '' | 'en' | 'zh_CN' ('' => follow browser UI language)
};

/**
 * @typedef {Object} HiddenRecord
 * @property {number} tabId      The tab id inside the stash window (may become invalid).
 * @property {number} windowId   The minimized stash window holding the tab.
 * @property {number} [originalWindowId]
 * @property {number} [originalIndex]
 * @property {string} url
 * @property {string} title
 * @property {number} hiddenAt   Timestamp (ms) the tab was hidden.
 */

const DEFAULTS = {
  [STORAGE_KEYS.KEYWORDS]: [],
  [STORAGE_KEYS.HIDDEN]: [],
  [STORAGE_KEYS.SCRIPT_MUTE]: false,
  [STORAGE_KEYS.HIDE_MODE]: false,
  [STORAGE_KEYS.LANG_PREF]: '',
};

// Supported locales. Messages are bundled at build time so the UI can switch
// language instantly (chrome.i18n.getMessage only ever reads the browser UI
// language, so we maintain our own lookup table and feed it to applyI18n).
//
// We import the messages via sibling .js files rather than .json with
// `import ... with { type: 'json' }` because Chrome's extension service worker
// does not allow JSON module imports — that produces "Failed to load the
// script unexpectedly" at SW startup. The .json files still live alongside
// because Chrome's manifest i18n (`__MSG_xxx__`) reads them directly.
import enMessages from './_locales/en/messages.js';
import zhCNMessages from './_locales/zh_CN/messages.js';

export const MESSAGES = {
  en: enMessages,
  zh_CN: zhCNMessages,
};

export const SUPPORTED_LOCALES = ['en', 'zh_CN'];

export async function getState(key = null) {
  if (key === null) {
    const all = await chrome.storage.local.get(null);
    return { ...DEFAULTS, ...all };
  }
  const result = await chrome.storage.local.get(key);
  return result[key] ?? DEFAULTS[key];
}

export async function setState(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/**
 * Get the keywords list as an array of trimmed, non-empty strings.
 */
export async function getKeywords() {
  const list = await getState(STORAGE_KEYS.KEYWORDS);
  return (list || []).map((k) => String(k).trim()).filter(Boolean);
}

export async function getScriptMute() {
  return !!(await getState(STORAGE_KEYS.SCRIPT_MUTE));
}
export async function getHideMode() {
  return !!(await getState(STORAGE_KEYS.HIDE_MODE));
}

/**
 * True if a tab matches any keyword (case-insensitive substring of URL or title).
 */
export function tabMatchesKeywords(tab, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const title = (tab.title || '').toLowerCase();
  const url = (tab.url || '').toLowerCase();
  return keywords.some((k) => {
    const kw = String(k).toLowerCase();
    if (!kw) return false;
    return url.includes(kw) || title.includes(kw);
  });
}

/**
 * The user's language preference: '' (follow browser), 'en', or 'zh_CN'.
 */
export async function getLangPref() {
  const v = await getState(STORAGE_KEYS.LANG_PREF);
  return v || '';
}

/**
 * Resolve the effective locale used for UI rendering.
 * Priority: stored preference > browser UI language (if supported) > 'en'.
 */
export async function resolveLocale() {
  const pref = await getLangPref();
  if (SUPPORTED_LOCALES.includes(pref)) return pref;
  const ui = chrome.i18n.getUILanguage();
  const uiMapped = ui.startsWith('zh') ? 'zh_CN' : 'en';
  return SUPPORTED_LOCALES.includes(uiMapped) ? uiMapped : 'en';
}

/**
 * Look up a localized message for the given locale, with en fallback.
 * Substitutes $N$ placeholders in the message body.
 */
export function tFor(locale, messageName, substitutions = null) {
  const langs = [MESSAGES[locale], MESSAGES.en];
  let entry;
  for (const dict of langs) {
    if (dict && dict[messageName]) { entry = dict[messageName]; break; }
  }
  if (!entry) return messageName;
  let msg = entry.message ?? '';
  if (entry.placeholders && substitutions != null) {
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    for (const [key, ph] of Object.entries(entry.placeholders)) {
      const idx = parseInt(ph.content?.replace(/[^0-9]/g, ''), 10) - 1;
      if (!Number.isNaN(idx) && subs[idx] != null) {
        msg = msg.replace(new RegExp(`\\$${key}\\$`, 'gi'), String(subs[idx]));
      }
    }
  }
  return msg;
}