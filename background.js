// Service worker for Stealth Browser Assistant.
//
// hideMode — when ON, every matching tab is moved into a minimized stash window.
// Mute uses script injection (no Chrome mute API). The popup has a toggle
// that stores a boolean `scriptMute` in chrome.storage. When toggled ON, we
// inject a mute script into every matching tab; when toggled OFF, we inject
// an unmute script. The stored flag is purely for the toggle UI — it does NOT
// drive continuous enforcement. New matching tabs are NOT auto-muted (the
// user can toggle off/on to re-apply). Chrome's native mute/unmute keeps
// working freely.
//
// NOTE on "hiding" tabs: Chrome has no public chrome.tabs.hide API (reserved for
// enterprise-policy extensions). We emulate hiding by moving matching tabs into a
// single minimized "stash" window and recording their original position so they can
// be restored. Hidden tabs are automatically muted so they don't keep playing audio.

import {
  STORAGE_KEYS, getState, setState, getKeywords,
  getScriptMute, getHideMode, getEmergencyAction, getPauseOnMuteHide,
  getRedBorderFlash, getTabIconOverride, getCleanupTypes, CLEANUP_TYPE_KEYS,
  getAutoCleanupState, setAutoCleanupState,
  tabMatchesKeywords, isPremium, refreshPremiumState,
  hasCleanupPermissions,
} from './shared.js';
import { maybeCheckIn } from './license.js';
import { UNINSTALL_URL } from './config.js';

const STASH_WINDOW_STATE = 'minimized';

// Ask the browser to open the goodbye page after the extension is uninstalled.
// Registration is persisted by the browser; setting it on Service Worker
// startup also keeps the destination current after extension updates. Use the
// callback form because Firefox's chrome.* compatibility layer may not return
// a Promise here.
chrome.runtime.setUninstallURL(UNINSTALL_URL, () => {
  void chrome.runtime.lastError;
});

// In-memory set of window ids we have designated as the minimized "stash" window.
const STASH_WINDOW_IDS = new Set();

// ───────────────────────── matching ─────────────────────────

async function findMatchingTabs() {
  const keywords = await getKeywords();
  if (!keywords.length) return [];
  const allTabs = await chrome.tabs.query({});
  return allTabs.filter((t) => tabMatchesKeywords(t, keywords));
}

// ───────────────────────── mute (script-level, toggle) ─────────────────────────

/**
 * Inject a small script into a tab. Returns false on failure (e.g. protected page).
 */
async function injectScript(tabId, func, args = []) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return true;
  } catch {
    return false;
  }
}

function MUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = true; }); }
function UNMUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = false; }); }
function PAUSE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { if (!el.paused) el.pause(); }); }

/**
 * Flash a bold red border around the whole page (match-hit feedback).
 * Uses a fixed overlay + CSSOM property sets only, so it works under strict
 * page CSP and never disturbs the page layout or input. Deliberately
 * prominent: 4px border + red glow, 3 flashes over ~1.4s — a 2px/0.6s flash
 * was too easy to miss on content-heavy pages.
 */
function FLASH_RED_BORDER_SCRIPT() {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.inset = '0';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '2147483647';
  el.style.border = '4px solid #d8392b';
  el.style.boxShadow =
    'inset 0 0 0 1px rgba(216,57,43,0.35), 0 0 28px 6px rgba(216,57,43,0.55)';
  el.style.opacity = '0';
  (document.documentElement || document.body).appendChild(el);

  let count = 0;
  const FLASHES = 3;
  const hide = () => {
    el.style.opacity = '0';
    count += 1;
    if (count < FLASHES) setTimeout(show, 200); // brief gap between flashes
    else setTimeout(() => el.remove(), 120);
  };
  const show = () => { el.style.opacity = '1'; setTimeout(hide, 250); };
  setTimeout(show, 0);
}

async function setScriptMute(on) {
  await setState(STORAGE_KEYS.SCRIPT_MUTE, on);
  const tabs = await findMatchingTabs();
  const func = on ? MUTE_SCRIPT : UNMUTE_SCRIPT;
  const shouldPause = on && await getPauseOnMuteHide() && isPremium();
  for (const t of tabs) {
    await injectScript(t.id, func);
    if (shouldPause) await injectScript(t.id, PAUSE_SCRIPT);
  }
  await updateBadge();
}

/**
 * Apply script-level mute to a single tab. No-op if scriptMute is off.
 */
async function enforceScriptMuteOnTab(tab) {
  if (!(await getScriptMute())) return;
  const keywords = await getKeywords();
  if (!tabMatchesKeywords(tab, keywords)) return;
  await injectScript(tab.id, MUTE_SCRIPT);
  if (await getPauseOnMuteHide() && isPremium()) await injectScript(tab.id, PAUSE_SCRIPT);
}

// ───────────────────────── hide mode ─────────────────────────

/**
 * Apply the current hide mode to a single tab. No-op if hide mode is off.
 */
async function enforceHideOnTab(tab) {
  if (!(await getHideMode())) return;
  const keywords = await getKeywords();
  if (!tabMatchesKeywords(tab, keywords)) return;
  if (await getPauseOnMuteHide() && isPremium()) await injectScript(tab.id, PAUSE_SCRIPT);
  await hideTab(tab);
}

async function setHideMode(on) {
  await setState(STORAGE_KEYS.HIDE_MODE, on);
  if (on) {
    const tabs = await findMatchingTabs();
    const shouldPause = await getPauseOnMuteHide() && isPremium();
    for (const tab of tabs) {
      // Also mute hidden tabs so the stash window stays silent.
      try { await chrome.tabs.update(tab.id, { muted: true }); } catch {}
      if (shouldPause) await injectScript(tab.id, PAUSE_SCRIPT);
      await hideTab(tab);
    }
  } else {
    await unhideAll();
  }
  await updateBadge();
}

/**
 * Move a single tab into the stash window and record it. Skips tabs already hidden.
 */
async function hideTab(tab) {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  if (hidden.some((r) => r.tabId === tab.id)) return; // already stashed
  if (hidden.some((r) => r.url === tab.url)) {
    // de-dupe by url is intentionally NOT used — two distinct tabs can share a url.
  }

  const originalWindowId = tab.windowId;
  const originalIndex = tab.index;

  let stashWindowId = await findStashWindow();
  let targetWindowId = stashWindowId;
  if (targetWindowId == null) {
    const win = await chrome.windows.create({ tabId: tab.id, state: STASH_WINDOW_STATE });
    targetWindowId = win.id;
    stashWindowId = win.id;
  } else {
    await chrome.tabs.move(tab.id, { windowId: targetWindowId, index: -1 });
  }
  await chrome.windows.update(targetWindowId, { state: STASH_WINDOW_STATE });
  STASH_WINDOW_IDS.add(targetWindowId);

  // Mute so the minimized window stays silent.
  try { await chrome.tabs.update(tab.id, { muted: true }); } catch {}

  const record = {
    tabId: tab.id,
    windowId: targetWindowId,
    originalWindowId,
    originalIndex,
    url: tab.url,
    title: tab.title,
    hiddenAt: Date.now(),
  };
  await mergeRecords([record]);
}

/**
 * Restore all hidden tabs to their original windows/positions.
 * Always unmute restored tabs (they were only muted because of hiding).
 */
async function unhideAll() {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  if (!hidden.length) return 0;

  const restored = [];
  for (const record of hidden) {
    try {
      const exists = await chrome.tabs.get(record.tabId).then(() => true).catch(() => false);
      if (!exists) continue;

      let destWindowId = record.originalWindowId;
      try {
        await chrome.windows.get(record.originalWindowId);
      } catch {
        const last = await chrome.windows.getLastFocused();
        destWindowId = last.id;
      }

      const targetIndex = record.originalIndex ?? -1;
      await chrome.tabs.move(record.tabId, { windowId: destWindowId, index: targetIndex });
      // Hidden tabs are always muted as a side-effect; unmute on restore.
      try { await chrome.tabs.update(record.tabId, { muted: false }); } catch {}
      restored.push(record);
    } catch (err) {
      console.warn('Stealth Browser Assistant: failed to restore tab', record, err);
    }
  }

  const restoredIds = new Set(restored.map((r) => r.tabId));
  const remaining = hidden.filter((r) => !restoredIds.has(r.tabId));
  await setState(STORAGE_KEYS.HIDDEN, remaining);

  await maybeCloseStashWindow();
  return restored.length;
}

// ───────────────────────── stash window helpers ─────────────────────────

async function findStashWindow() {
  for (const wid of [...STASH_WINDOW_IDS]) {
    try {
      await chrome.windows.get(wid);
      return wid;
    } catch {
      STASH_WINDOW_IDS.delete(wid);
    }
  }
  return null;
}

async function maybeCloseStashWindow() {
  for (const wid of [...STASH_WINDOW_IDS]) {
    try {
      const win = await chrome.windows.get(wid, { populate: true });
      if (!win.tabs || win.tabs.length === 0) {
        await chrome.windows.remove(wid);
        STASH_WINDOW_IDS.delete(wid);
      }
    } catch {
      STASH_WINDOW_IDS.delete(wid);
    }
  }
}

function mergeRecords(newRecords) {
  return getState(STORAGE_KEYS.HIDDEN).then((existing) => {
    const combined = [...existing, ...newRecords];
    return setState(STORAGE_KEYS.HIDDEN, combined);
  });
}

// ───────────────────────── tab events ─────────────────────────

chrome.tabs.onCreated.addListener((tab) => {
  maybeApplyToTabLater(tab.id);
  reevaluateSensitiveSession().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ('url' in change || 'title' in change || change.status === 'complete') {
    enforceScriptMuteOnTab(tab).catch(() => {});
    enforceHideOnTab(tab).catch(() => {});
    enforceFaviconOnTab(tab).catch(() => {});
    reevaluateSensitiveSession().catch(() => {});
    // A newly opened / navigated tab that matches a keyword: flash only when
    // it's the tab the user is actually looking at.
    if (tab.active) flashIfMatched(tab).catch(() => {});
  }
});

// ───────────────────────── match-hit feedback ─────────────────────────

const MATCH_FLASH_COOLDOWN_MS = 1500;
const lastMatchFlashByTab = new Map();

/**
 * Flash a red border on the tab if it matches a keyword and the feedback
 * setting is on. Only called for the active tab — flashing a background tab
 * would be invisible.
 */
async function flashIfMatched(tab) {
  if (!(await getRedBorderFlash())) return;
  const keywords = await getKeywords();
  if (!keywords.length || !tabMatchesKeywords(tab, keywords)) return;

  // Avoid double-flashes when onActivated and onUpdated fire for the same
  // navigation within a short window.
  const now = Date.now();
  if (now - (lastMatchFlashByTab.get(tab.id) || 0) < MATCH_FLASH_COOLDOWN_MS) return;
  lastMatchFlashByTab.set(tab.id, now);

  await injectScript(tab.id, FLASH_RED_BORDER_SCRIPT);
}

// Switching to a matching tab (or a newly opened one that already matches).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    flashIfMatched(tab).catch(() => {});
  } catch {
    // tab already gone — nothing to flash
  }
});

// ───────────────────────── tab icon override ─────────────────────────

// The extension icon as a data: URI, computed once and reused for every tab.
let faviconDataUri = null;

async function getFaviconDataUri() {
  if (faviconDataUri !== null) return faviconDataUri;
  try {
    const res = await fetch(chrome.runtime.getURL('icons/icon-16.png'));
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    faviconDataUri = `data:image/png;base64,${btoa(bin)}`;
  } catch {
    faviconDataUri = '';
  }
  return faviconDataUri;
}

/**
 * Replace every favicon <link> of the page with the given icon URL (data URI),
 * or add one if the page has none. Chrome picks up the change and updates the
 * tab icon.
 */
function SET_FAVICON_SCRIPT(url) {
  const links = document.querySelectorAll('link[rel~="icon"]');
  if (links.length) {
    for (const link of links) link.href = url;
  } else {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = url;
    (document.head || document.documentElement).appendChild(link);
  }
}

/**
 * Point a matching tab's favicon at our own icon. Skips hidden (stashed) tabs.
 */
async function enforceFaviconOnTab(tab) {
  if (!(await getTabIconOverride())) return;
  const keywords = await getKeywords();
  if (!keywords.length || !tabMatchesKeywords(tab, keywords)) return;
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  if (hidden.some((r) => r.tabId === tab.id)) return;

  const uri = await getFaviconDataUri();
  if (!uri) return;
  await injectScript(tab.id, SET_FAVICON_SCRIPT, [uri]);
}

/**
 * Apply the icon override to every currently matching tab. Runs on
 * browser/extension startup so tabs opened before this setting existed still
 * get the icon.
 */
async function syncFavicons() {
  if (!(await getTabIconOverride())) return;
  const keywords = await getKeywords();
  if (!keywords.length) return;
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  const hiddenIds = new Set(hidden.map((r) => r.tabId));
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (hiddenIds.has(tab.id)) continue;
    if (tabMatchesKeywords(tab, keywords)) {
      await enforceFaviconOnTab(tab).catch(() => {});
    }
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  reevaluateSensitiveSession().catch(() => {});
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  if (!hidden.some((r) => r.tabId === tabId)) return;
  const remaining = hidden.filter((r) => r.tabId !== tabId);
  await setState(STORAGE_KEYS.HIDDEN, remaining);
  await updateBadge();
  await maybeCloseStashWindow();
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  const rec = hidden.find((r) => r.tabId === tabId);
  if (!rec) return;
  if (![...STASH_WINDOW_IDS].includes(newWindowId)) {
    await setState(STORAGE_KEYS.HIDDEN, hidden.filter((r) => r.tabId !== tabId));
    // Unmute since it's no longer in the stash window.
    try { await chrome.tabs.update(tabId, { muted: false }); } catch {}
    await updateBadge();
  }
});

chrome.windows.onRemoved.addListener(async (wid) => {
  const wasStash = STASH_WINDOW_IDS.delete(wid);
  // If this was a stash window, drop the hidden-tab records pointing at it.
  // chrome.tabs.onRemoved may not fire for every tab inside a closed window,
  // so we can't rely on tab-level cleanup alone.
  if (wasStash) {
    const hidden = await getState(STORAGE_KEYS.HIDDEN);
    const remaining = hidden.filter((r) => r.windowId !== wid);
    if (remaining.length !== hidden.length) {
      await setState(STORAGE_KEYS.HIDDEN, remaining);
      await updateBadge();
    }
  }
});

async function maybeApplyToTabLater(tabId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url || tab.title) {
        await enforceScriptMuteOnTab(tab);
        await enforceHideOnTab(tab);
        await enforceFaviconOnTab(tab).catch(() => {});
        return;
      }
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ───────────────────────── auto cleanup (sensitive session) ─────────────────────────
//
// When the LAST tab matching a keyword is closed, wait `delayMinutes` (default 5)
// and then run the scoped cleanup — unless a matching tab reappears, which
// cancels the countdown. State lives in chrome.storage (cleanupAt is an
// absolute timestamp) so it survives SW recycling and browser restarts;
// chrome.alarms only wakes us up at the right moment.

const AUTO_CLEANUP_ALARM = 'sba-auto-cleanup';

async function hasMatchingTabs() {
  return (await findMatchingTabs()).length > 0;
}

async function scheduleAutoCleanup() {
  const state = await getAutoCleanupState();
  const delayMs = Math.max(1, state.delayMinutes || 0) * 60 * 1000;
  const cleanupAt = Date.now() + delayMs;
  await setAutoCleanupState({ cleanupPending: true, sessionActive: true, cleanupAt });
  await chrome.alarms.create(AUTO_CLEANUP_ALARM, { when: cleanupAt });
  console.log(`SBA: auto cleanup scheduled for ${new Date(cleanupAt).toLocaleString()}`);
}

async function cancelAutoCleanup() {
  await chrome.alarms.clear(AUTO_CLEANUP_ALARM);
  await setAutoCleanupState({ cleanupPending: false, cleanupAt: null });
}

/**
 * Core state machine. Called on every relevant tab event, on startup and when
 * keywords/auto-cleanup settings change.
 */
async function reevaluateSensitiveSession() {
  const state = await getAutoCleanupState();

  if (!state.enabled) {
    if (state.cleanupPending || state.cleanupAt) {
      await chrome.alarms.clear(AUTO_CLEANUP_ALARM);
      await setAutoCleanupState({ sessionActive: false, cleanupPending: false, cleanupAt: null });
    }
    return;
  }

  if (await hasMatchingTabs()) {
    // Sensitive session active — cancel any pending cleanup.
    if (state.cleanupPending || state.cleanupAt) {
      await chrome.alarms.clear(AUTO_CLEANUP_ALARM);
    }
    await setAutoCleanupState({ sessionActive: true, cleanupPending: false, cleanupAt: null });
    return;
  }

  // No matching tabs.
  if (!state.sessionActive) return; // never entered a sensitive session

  if (state.cleanupPending && state.cleanupAt && Date.now() >= state.cleanupAt) {
    // Overdue (e.g. Chrome was closed past the deadline) — clean now.
    const res = await runCleanup();
    await setAutoCleanupState({ sessionActive: false, cleanupPending: false, cleanupAt: null });
    console.log('SBA: auto cleanup executed (overdue)', res);
    return;
  }

  if (!state.cleanupPending) {
    await scheduleAutoCleanup();
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_CLEANUP_ALARM) return;
  const state = await getAutoCleanupState();
  if (!state.enabled || !state.cleanupPending) return;

  // Alarm firing alone is not permission to clean — re-check the tabs.
  if (await hasMatchingTabs()) {
    await cancelAutoCleanup();
    await setAutoCleanupState({ sessionActive: true });
    return;
  }
  if (state.cleanupAt && Date.now() >= state.cleanupAt) {
    const res = await runCleanup();
    await setAutoCleanupState({ sessionActive: false, cleanupPending: false, cleanupAt: null });
    console.log('SBA: auto cleanup executed', res);
  } else if (state.cleanupAt) {
    // Fired early — reschedule for the real deadline.
    await chrome.alarms.create(AUTO_CLEANUP_ALARM, { when: state.cleanupAt });
  }
});

// Re-evaluate whenever tab state, keywords or auto-cleanup settings change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.KEYWORDS] || changes[STORAGE_KEYS.AUTO_CLEANUP]) {
    reevaluateSensitiveSession().catch(() => {});
  }
});

// ───────────────────────── keyboard commands ─────────────────────────

/**
 * One-shot sensitive-data cleanup. Premium only.
 *
 * Cleanup is SCOPED to the keyword domains (the section's description says so):
 * - history / downloads: matched by URL substring against the keywords
 *   (faithful to the extension's keyword matching; clearing history also
 *   clears Chrome's address-bar suggestions).
 * - cookies & site data: cleaned only for origins derived from domain-like
 *   keywords (includeOrigins).
 * - cache / address-bar suggestions: excluded — cache can't be filtered by
 *   origin, and address-bar suggestions aren't reliably removable on their own.
 */
async function runCleanup() {
  if (!isPremium()) return { ok: false, reason: 'locked' };
  const types = await getCleanupTypes();
  const keywords = (await getKeywords()).map((k) => k.toLowerCase()).filter(Boolean);
  if (!Object.values(types).some(Boolean)) return { ok: false, reason: 'none_selected' };
  if (!keywords.length) return { ok: false, reason: 'no_keywords' };

  // Cleanup permissions are optional — the user grants them on the options /
  // popup page (which has a gesture). A background/alarm run has no gesture,
  // so if a permission was revoked we must bail out loudly instead of calling
  // a chrome.* API that will throw.
  const selected = CLEANUP_TYPE_KEYS.filter((t) => types[t]);
  if (!(await hasCleanupPermissions(selected))) {
    return { ok: false, reason: 'permission_denied' };
  }

  const origins = keywordOrigins(keywords);
  const byUrl = (url) => keywords.some((k) => (url || '').toLowerCase().includes(k));

  const results = [];
  if (types.history) results.push(['history', await cleanHistoryByKeywords(keywords)]);
  if (types.cookies && origins.length) {
    await Promise.allSettled(
      ['removeCookies', 'removeLocalStorage', 'removeIndexedDB', 'removeFileSystems',
       'removeServiceWorkers', 'removeWebSQL'].map(
        (m) => safeBrowsingDataRemove(m, { since: 0, includeOrigins: origins }),
      ),
    );
  }
  if (types.downloads) results.push(['downloads', await cleanDownloadsByKeywords(byUrl)]);

  console.log('Stealth Browser Assistant: cleanup done', Object.fromEntries(results));
  return { ok: true };
}

/** Origins (scheme://host) for domain-like keywords; ignores path-like words. */
function keywordOrigins(keywords) {
  const origins = new Set();
  for (const kw of keywords) {
    if (!isDomainLike(kw)) continue;
    origins.add(`https://${kw}`);
    origins.add(`http://${kw}`);
  }
  return [...origins];
}

function isDomainLike(kw) {
  return (
    /^localhost(:\d+)?$/.test(kw) ||
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(kw)
  );
}

async function safeBrowsingDataRemove(method, opts) {
  try {
    await chrome.browsingData[method](opts);
  } catch {
    // one type failing shouldn't block the others
  }
}

/**
 * Delete history entries whose URL/title matches any keyword. Walks backwards
 * in time windows so the maxResults cap never hides older items.
 */
async function cleanHistoryByKeywords(keywords) {
  const search = (q) => new Promise((res) => chrome.history.search(q, res));
  const del = (url) => new Promise((res) => chrome.history.deleteUrl({ url }, res));
  const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
  let endTime = Date.now();
  let deleted = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const items = await search({ text: '', startTime: 0, endTime, maxResults: 500 });
    if (!items || items.length === 0) break;
    let oldest = endTime;
    for (const it of items) {
      if (it.lastVisitTime && it.lastVisitTime < oldest) oldest = it.lastVisitTime;
      if (tabMatchesKeywords({ url: it.url, title: it.title }, keywords)) {
        try {
          await del(it.url);
          deleted += 1;
        } catch (err) {
          console.warn('Stealth Browser Assistant: deleteUrl failed', it.url, err);
        }
      }
    }
    if (items.length < 500 || oldest >= endTime) break;
    endTime = oldest - 1;
  }
  return deleted;
}

/** Erase download-history records whose URL matches a keyword (files stay). */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function cleanDownloadsByKeywords(byUrl) {
  // Callback-style wrappers: work whether or not the downloads API supports
  // promises in the current Chrome version.
  const search = () => new Promise((resolve) => chrome.downloads.search({}, resolve));
  const erase = (query) => new Promise((resolve) => chrome.downloads.erase(query, resolve));
  try {
    const items = await search();
    if (!Array.isArray(items)) {
      console.warn('Stealth Browser Assistant: downloads.search returned', items);
      return 0;
    }
    const matched = items.filter((d) => byUrl(d.url || ''));
    // erase() takes a DownloadQuery, NOT an array of ids. Match each record via
    // its exact URL as an (unanchored) regex so only that record is erased.
    for (const d of matched) {
      await erase({ urlRegex: escapeRegExp(d.url || '') });
    }
    console.log(
      `Stealth Browser Assistant: downloads cleanup — erased ${matched.length}/${items.length} records`,
    );
    return matched.length;
  } catch (err) {
    console.warn('Stealth Browser Assistant: downloads cleanup failed', err);
    return 0;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-mute') {
    await setScriptMute(!(await getScriptMute()));
  } else if (command === 'toggle-hide') {
    await setHideMode(!(await getHideMode()));
  } else if (command === 'clean-sensitive-data') {
    await runCleanup();
  } else if (command === 'emergency-mode') {
    let action = await getEmergencyAction();
    if (action === 'closeMatchTabs' && !isPremium()) action = 'muteHide';
    const matching = await findMatchingTabs();
    if (action === 'closeMatchTabs') {
      for (const t of matching) {
        try { await chrome.tabs.remove(t.id); } catch {}
      }
    } else {
      await setScriptMute(true);
      for (const t of matching) {
        await hideTab(t);
      }
    }
  }
  await updateBadge();
});

// ───────────────────────── message bridge ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'set-mute-mode': {
        await setScriptMute(!!msg.on);
        break;
      }
      case 'set-hide-mode': {
        await setHideMode(!!msg.on);
        break;
      }
      case 'run-cleanup': {
        sendResponse(await runCleanup());
        return;
      }
      case 'status': {
        const tabs = await findMatchingTabs();
        const hidden = await getState(STORAGE_KEYS.HIDDEN);
        sendResponse({
          ok: true,
          scriptMute: await getScriptMute(),
          hideMode: await getHideMode(),
          matching: tabs.length,
          hidden: hidden.length,
        });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
        return;
    }
    sendResponse({ ok: true });
  })();
  return true; // async sendResponse
});

// ───────────────────────── icon ─────────────────────────

const ICON_PATHS = {
  hide: { 16: 'icons/hide-16.png', 32: 'icons/hide-32.png', 48: 'icons/hide-48.png', 128: 'icons/hide-128.png' },
  mute: { 16: 'icons/mute-16.png', 32: 'icons/mute-32.png', 48: 'icons/mute-48.png', 128: 'icons/mute-128.png' },
  default: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
};

async function updateBadge() {
  const hideMode = await getHideMode();
  const scriptMute = await getScriptMute();

  if (hideMode) {
    await chrome.action.setIcon({ path: ICON_PATHS.hide });
  } else if (scriptMute) {
    await chrome.action.setIcon({ path: ICON_PATHS.mute });
  } else {
    await chrome.action.setIcon({ path: ICON_PATHS.default });
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await rehydrateStashWindowIds();
  await refreshPremiumState();
  maybeCheckIn().then(() => refreshPremiumState());
  await updateBadge();
  if (await getHideMode()) {
    const tabs = await findMatchingTabs();
    for (const tab of tabs) await hideTab(tab);
  }
  syncFavicons().catch(() => {});
  reevaluateSensitiveSession().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  scheduleLicenseCheckIn();
  syncFavicons().catch(() => {});
  reevaluateSensitiveSession().catch(() => {});
});

// ───────────────────────── license (premium) ─────────────────────────

const LICENSE_CHECK_IN_ALARM = 'license-check-in';

function scheduleLicenseCheckIn() {
  // Heartbeat at half the signature TTL (default 24h) so revocations / refunds
  // take effect without waiting for a full browser restart.
  chrome.alarms.create(LICENSE_CHECK_IN_ALARM, { periodInMinutes: 12 * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LICENSE_CHECK_IN_ALARM) {
    maybeCheckIn().then(() => refreshPremiumState());
  }
});

// Keep the sync premium cache in step with activation from the options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.LICENSE]) {
    refreshPremiumState();
  }
});

// Warm the cache on service-worker startup.
refreshPremiumState();
scheduleLicenseCheckIn();

async function rehydrateStashWindowIds() {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  hidden.forEach((r) => STASH_WINDOW_IDS.add(r.windowId));
}
rehydrateStashWindowIds();
