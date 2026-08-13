// Shared utilities for Stealth Browser Assistant: storage keys, keyword matching, hidden-tab registry.
// Imported by background.js, popup.js and options.js as an ES module.

export const STORAGE_KEYS = {
  KEYWORDS: "keywords",
  HIDDEN: "hiddenTabs", // array of HiddenRecord
  SCRIPT_MUTE: "scriptMute", // boolean: user toggled mute via popup (script-level, not Chrome API)
  HIDE_MODE: "hideMode", // boolean: auto-hide matching tabs while on
  LANG_PREF: "langPref", // '' | 'en' | 'zh_CN' ('' => follow browser UI language)
  EMERGENCY_ACTION: "emergencyAction", // 'muteHide' | 'closeMatchTabs' — what Alt+Shift+Space does
  PAUSE_ON_MUTE_HIDE: "pauseOnMuteHide", // boolean: also pause media when mute/hide is applied
  RED_BORDER_FLASH: "redBorderFlash", // boolean: flash a red border on a matched active tab
  TAB_ICON_OVERRIDE: "tabIconOverride", // boolean: replace matched tabs' favicon with ours
  CLEANUP_TYPES: "cleanupTypes", // object: which sensitive data types to clean (see CLEANUP_TYPE_KEYS)
  LICENSE: "license", // object|null: verified license state (see license.js)
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
  [STORAGE_KEYS.LANG_PREF]: "",
  [STORAGE_KEYS.EMERGENCY_ACTION]: "muteHide",
  [STORAGE_KEYS.PAUSE_ON_MUTE_HIDE]: false,
  [STORAGE_KEYS.RED_BORDER_FLASH]: false,
  [STORAGE_KEYS.TAB_ICON_OVERRIDE]: true,
  [STORAGE_KEYS.CLEANUP_TYPES]: { history: false, cookies: false, downloads: false },
  [STORAGE_KEYS.LICENSE]: null,
};

// Cleanup types that can be scoped to the keyword domains. Cache is excluded:
// Chrome's browsingData.removeCache cannot filter by origin. Address-bar
// suggestions are covered by history (clearing history also clears them).
export const CLEANUP_TYPE_KEYS = ["history", "cookies", "downloads"];

export const EMERGENCY_ACTIONS = ["muteHide", "closeMatchTabs"];

// Supported locales. Messages are bundled at build time so the UI can switch
// language instantly (chrome.i18n.getMessage only ever reads the browser UI
// language, so we maintain our own lookup table and feed it to applyI18n).
//
// We import the messages via sibling .js files rather than .json with
// `import ... with { type: 'json' }` because Chrome's extension service worker
// does not allow JSON module imports — that produces "Failed to load the
// script unexpectedly" at SW startup. The .json files still live alongside
// because Chrome's manifest i18n (`__MSG_xxx__`) reads them directly.
import enMessages from "./_locales/en/messages.js";
import zhCNMessages from "./_locales/zh_CN/messages.js";
import esMessages from "./_locales/es/messages.js";
import deMessages from "./_locales/de/messages.js";
import jaMessages from "./_locales/ja/messages.js";
import frMessages from "./_locales/fr/messages.js";
import ptMessages from "./_locales/pt/messages.js";
import koMessages from "./_locales/ko/messages.js";

export const MESSAGES = {
  en: enMessages,
  zh_CN: zhCNMessages,
  es: esMessages,
  de: deMessages,
  ja: jaMessages,
  fr: frMessages,
  pt: ptMessages,
  ko: koMessages,
};

export const SUPPORTED_LOCALES = [
  "en",
  "zh_CN",
  "es",
  "de",
  "ja",
  "fr",
  "pt",
  "ko",
];

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
 * True when the user wants media playback to be paused as a side-effect of
 * script-mute or hide being applied. One-way: unmuting / unhiding does NOT
 * auto-resume — the user clicks play themselves.
 */
export async function getPauseOnMuteHide() {
  return !!(await getState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE));
}

/**
 * True when the user wants the active tab to flash a red border when it
 * matches a keyword (or a newly opened tab matches).
 */
export async function getRedBorderFlash() {
  return !!(await getState(STORAGE_KEYS.RED_BORDER_FLASH));
}

/**
 * True when matching tabs should have their favicon replaced with the
 * extension's own icon.
 */
export async function getTabIconOverride() {
  return !!(await getState(STORAGE_KEYS.TAB_ICON_OVERRIDE));
}

/**
 * The set of sensitive-data types the user wants cleaned (all false by
 * default). Keys come from CLEANUP_TYPE_KEYS; unknown/stale keys are dropped.
 */
export async function getCleanupTypes() {
  const stored = await getState(STORAGE_KEYS.CLEANUP_TYPES);
  const out = {};
  for (const k of CLEANUP_TYPE_KEYS) out[k] = !!(stored && stored[k]);
  return out;
}

/** Toggle one cleanup type (e.g. 'history') on or off. */
export async function setCleanupType(type, enabled) {
  const types = await getCleanupTypes();
  types[type] = !!enabled;
  await setState(STORAGE_KEYS.CLEANUP_TYPES, types);
  return types;
}

/**
 * What the emergency-mode shortcut does: 'muteHide' (script-mute + hide tabs in stash)
 * or 'closeMatchTabs' (close every matching tab).
 */
export async function getEmergencyAction() {
  const v = await getState(STORAGE_KEYS.EMERGENCY_ACTION);
  return EMERGENCY_ACTIONS.includes(v) ? v : "muteHide";
}

/**
 * True if a tab matches any keyword (case-insensitive substring of URL or title).
 */
export function tabMatchesKeywords(tab, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const title = (tab.title || "").toLowerCase();
  const url = (tab.url || "").toLowerCase();
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
  return v || "";
}

/**
 * Resolve the effective locale used for UI rendering.
 * Priority: stored preference > browser UI language (if supported) > 'en'.
 */
export async function resolveLocale() {
  const pref = await getLangPref();
  if (SUPPORTED_LOCALES.includes(pref)) return pref;
  const ui = chrome.i18n.getUILanguage();
  // Try exact match first, then fall back to language prefix (e.g. 'pt-BR' → 'pt')
  if (SUPPORTED_LOCALES.includes(ui)) return ui;
  const prefix = ui.split("-")[0];
  const map = { zh: "zh_CN" }; // map language prefixes to our locale codes
  const mapped = map[prefix] || prefix;
  return SUPPORTED_LOCALES.includes(mapped) ? mapped : "en";
}

/**
 * Look up a localized message for the given locale, with en fallback.
 * Substitutes $N$ placeholders in the message body.
 */
export function tFor(locale, messageName, substitutions = null) {
  const langs = [MESSAGES[locale], MESSAGES.en];
  let entry;
  for (const dict of langs) {
    if (dict && dict[messageName]) {
      entry = dict[messageName];
      break;
    }
  }
  if (!entry) return messageName;
  let msg = entry.message ?? "";
  if (entry.placeholders && substitutions != null) {
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    for (const [key, ph] of Object.entries(entry.placeholders)) {
      const idx = parseInt(ph.content?.replace(/[^0-9]/g, ""), 10) - 1;
      if (!Number.isNaN(idx) && subs[idx] != null) {
        msg = msg.replace(new RegExp(`\\$${key}\\$`, "gi"), String(subs[idx]));
      }
    }
  }
  return msg;
}

// ───────────────────────── premium tier ─────────────────────────

/**
 * Maximum keywords a free-tier user can save. Adjust here to change the cap
 * for all non-premium users in one place.
 */
export const KEYWORD_LIMIT_FREE = 5;

// In-memory cache of premium status. Synchronous `isPremium()` reads this; it
// is refreshed from storage by `refreshPremiumState()` at startup in each
// context (and via storage.onChanged in the service worker). The actual
// license verification lives in license.js — here we only mirror the persisted
// "verified-until" deadline so feature gating stays cheap and synchronous.
let premiumActive = false;

/**
 * Whether the current user has an active, non-stale Premium license.
 * Reflects the cache maintained by refreshPremiumState().
 */
export function isPremium() {
  return premiumActive;
}

/**
 * Re-read the persisted license and update the premium cache. Returns the new
 * premium status. A license counts as active only while its signature's
 * valid_until timestamp is still in the future.
 */
export async function refreshPremiumState() {
  const lic = await getState(STORAGE_KEYS.LICENSE);
  premiumActive = !!(lic && typeof lic.validUntil === 'number' && lic.validUntil > Date.now());
  return premiumActive;
}

/**
 * Effective keyword cap for the current user. Premium users get unlimited;
 * everyone else is bounded by KEYWORD_LIMIT_FREE.
 */
export function getKeywordLimit() {
  return isPremium() ? Infinity : KEYWORD_LIMIT_FREE;
}
