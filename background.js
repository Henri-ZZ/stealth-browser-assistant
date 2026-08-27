// Service worker for Stealth Browser Assistant.
//
// hideMode — when ON, every matching tab is moved into a minimized stash window.
// Mute uses the browser's tab-level mute with ownership tracking. The former
// DOM media-element implementation is kept below as a legacy fallback while
// the native implementation is being tested.
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

// ───────────────────────── legacy media-element mute (kept for rollback) ─────────────────────────

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

/** Inject into the main document and every currently accessible child frame. */
async function injectScriptAllFrames(tabId, func, args = []) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args,
    });
    return true;
  } catch {
    return false;
  }
}

function MUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = true; }); }
function UNMUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = false; }); }
function PAUSE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { if (!el.paused) el.pause(); }); }

/**
 * Persistent Pause media controller, installed independently in every frame.
 * It pauses existing and newly inserted media, including media inside open
 * Shadow DOM. Disabling only removes observers/listeners; it never resumes.
 */
function PAUSE_MEDIA_CONTROLLER_SCRIPT(enabled) {
  const KEY = '__sbaPauseMediaControllerV1';
  const previous = globalThis[KEY];
  if (previous) {
    for (const observer of previous.observers) observer.disconnect();
    for (const [frame, listener] of previous.frameListeners) {
      frame.removeEventListener('load', listener);
    }
    document.removeEventListener('play', previous.pauseEvent, true);
    document.removeEventListener('loadedmetadata', previous.pauseEvent, true);
    clearInterval(previous.rescanInterval);
    delete globalThis[KEY];
  }
  if (!enabled) return;

  const controller = {
    observers: [],
    frameListeners: [],
    roots: new WeakSet(),
    frames: new WeakSet(),
    pauseEvent: null,
    rescanInterval: null,
  };

  const pauseElement = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    try {
      if (!element.paused) element.pause();
    } catch {
      // A page-controlled media implementation may reject pause().
    }
  };

  const watchRoot = (root) => {
    if (!root || controller.roots.has(root)) return;
    controller.roots.add(root);

    const scan = (node) => {
      if (!node) return;
      pauseElement(node);
      if (node.querySelectorAll) {
        for (const media of node.querySelectorAll('audio, video')) pauseElement(media);
        for (const element of node.querySelectorAll('*')) {
          if (element.shadowRoot) watchRoot(element.shadowRoot);
        }
        for (const frame of node.querySelectorAll('iframe')) watchFrame(frame);
      }
      if (node.shadowRoot) watchRoot(node.shadowRoot);
      if (node instanceof HTMLIFrameElement) watchFrame(node);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) scan(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    controller.observers.push(observer);
    scan(root);
  };

  function watchFrame(frame) {
    if (controller.frames.has(frame)) return;
    controller.frames.add(frame);
    const scanFrame = () => {
      try { watchRoot(frame.contentDocument); } catch {}
    };
    frame.addEventListener('load', scanFrame);
    controller.frameListeners.push([frame, scanFrame]);
    scanFrame();
  }

  const rescanTree = (root) => {
    if (!root?.querySelectorAll) return;
    for (const media of root.querySelectorAll('audio, video')) pauseElement(media);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        watchRoot(element.shadowRoot);
        rescanTree(element.shadowRoot);
      }
    }
    for (const frame of root.querySelectorAll('iframe')) watchFrame(frame);
  };

  controller.pauseEvent = (event) => pauseElement(event.target);
  document.addEventListener('play', controller.pauseEvent, true);
  document.addEventListener('loadedmetadata', controller.pauseEvent, true);
  globalThis[KEY] = controller;
  watchRoot(document);
  // Covers a ShadowRoot attached after its host was inserted, which produces
  // no child-list mutation on the surrounding document.
  controller.rescanInterval = setInterval(() => rescanTree(document), 1000);
}

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

async function setPauseMediaController(tabId, enabled) {
  return injectScriptAllFrames(tabId, PAUSE_MEDIA_CONTROLLER_SCRIPT, [enabled]);
}

async function syncPauseMediaControllerOnTab(tab) {
  const keywords = await getKeywords();
  const matches = tabMatchesKeywords(tab, keywords);
  const modeActive = await getScriptMute() || await getHideMode();
  const enabled = matches
    && modeActive
    && isPremium()
    && await getPauseOnMuteHide();
  await setPauseMediaController(tab.id, enabled);
}

async function syncAllPauseMediaControllers() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await syncPauseMediaControllerOnTab(tab);
  }
}

// ───────────────────────── native tab mute (test implementation) ─────────────────────────

// Session storage is intentional: tab ids are only unique within one browser
// session and may be reused after a restart. Each record tracks independent
// claims from Mute and Hide so releasing one feature cannot undo the other.
const NATIVE_MUTE_RECORDS_KEY = 'nativeMuteRecordsV1';
const NATIVE_MUTE_MIGRATION_KEY = 'nativeMuteMigrationV1';
let nativeMuteMemoryRecords = {};
let nativeMuteQueue = Promise.resolve();

function withNativeMuteLock(task) {
  const run = nativeMuteQueue.then(task, task);
  nativeMuteQueue = run.catch(() => {});
  return run;
}

async function readNativeMuteRecords() {
  if (!chrome.storage.session) return { ...nativeMuteMemoryRecords };
  try {
    const stored = await chrome.storage.session.get(NATIVE_MUTE_RECORDS_KEY);
    return stored[NATIVE_MUTE_RECORDS_KEY] || {};
  } catch {
    return { ...nativeMuteMemoryRecords };
  }
}

async function writeNativeMuteRecords(records) {
  nativeMuteMemoryRecords = records;
  if (!chrome.storage.session) return;
  try {
    await chrome.storage.session.set({ [NATIVE_MUTE_RECORDS_KEY]: records });
  } catch {
    // The in-memory copy remains usable if session storage is unavailable.
  }
}

function mutedByThisExtension(mutedInfo) {
  return !!mutedInfo?.muted
    && mutedInfo.reason === 'extension'
    && mutedInfo.extensionId === chrome.runtime.id;
}

async function acquireNativeMuteClaim(tabId, claim) {
  return withNativeMuteLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;

    const records = await readNativeMuteRecords();
    const key = String(tabId);
    const record = records[key] || {
      claims: [],
      mutedBySba: false,
      muteSuppressed: false,
    };

    // A manual unmute while Mute is ON suppresses re-enforcement until the
    // tab stops matching or the user explicitly toggles Mute off and on.
    if (claim === 'mute' && record.muteSuppressed) return false;

    if (!record.claims.includes(claim)) record.claims.push(claim);
    if (!tab.mutedInfo?.muted) {
      await chrome.tabs.update(tabId, { muted: true });
      record.mutedBySba = true;
    } else if (mutedByThisExtension(tab.mutedInfo)) {
      record.mutedBySba = true;
    }

    records[key] = record;
    await writeNativeMuteRecords(records);
    return true;
  });
}

async function releaseNativeMuteClaim(tabId, claim, { clearSuppression = false } = {}) {
  return withNativeMuteLock(async () => {
    const records = await readNativeMuteRecords();
    const key = String(tabId);
    const record = records[key];
    if (!record) return;

    record.claims = record.claims.filter((item) => item !== claim);
    if (clearSuppression) record.muteSuppressed = false;

    if (record.claims.length === 0) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      // Only undo a mute that is still attributed to SBA. A later user,
      // capture, or other-extension action always wins.
      if (record.mutedBySba && tab && mutedByThisExtension(tab.mutedInfo)) {
        await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
      }
      record.mutedBySba = false;
      if (record.muteSuppressed) records[key] = record;
      else delete records[key];
    } else {
      records[key] = record;
    }
    await writeNativeMuteRecords(records);
  });
}

async function clearNativeMuteSuppression(tabId) {
  return withNativeMuteLock(async () => {
    const records = await readNativeMuteRecords();
    const key = String(tabId);
    const record = records[key];
    if (!record?.muteSuppressed) return;
    record.muteSuppressed = false;
    if (record.claims.length === 0) delete records[key];
    else records[key] = record;
    await writeNativeMuteRecords(records);
  });
}

async function releaseAllNativeMuteClaims() {
  const records = await readNativeMuteRecords();
  for (const tabId of Object.keys(records).map(Number)) {
    await releaseNativeMuteClaim(tabId, 'mute', { clearSuppression: true });
  }
}

async function setNativeMuteMode(on) {
  await setState(STORAGE_KEYS.SCRIPT_MUTE, on);
  if (on) {
    // A fresh ON action is explicit permission to mute again after a previous
    // manual override.
    const records = await readNativeMuteRecords();
    for (const tabId of Object.keys(records).map(Number)) {
      await clearNativeMuteSuppression(tabId);
    }
    const tabs = await findMatchingTabs();
    for (const tab of tabs) {
      await acquireNativeMuteClaim(tab.id, 'mute');
    }
  } else {
    await releaseAllNativeMuteClaims();
  }
  await syncAllPauseMediaControllers();
  await updateBadge();
}

async function enforceNativeMuteOnTab(tab) {
  const keywords = await getKeywords();
  const matches = tabMatchesKeywords(tab, keywords);
  if (await getScriptMute() && matches) {
    await acquireNativeMuteClaim(tab.id, 'mute');
  } else {
    await releaseNativeMuteClaim(tab.id, 'mute', { clearSuppression: !matches });
  }
  await syncPauseMediaControllerOnTab(tab);
}

async function handleExternalNativeMuteChange(tabId, mutedInfo) {
  if (mutedInfo?.reason === 'extension'
      && mutedInfo.extensionId === chrome.runtime.id) return;

  await withNativeMuteLock(async () => {
    const records = await readNativeMuteRecords();
    const key = String(tabId);
    const record = records[key];
    if (!record) return;

    // A user/capture/other-extension change takes ownership away from SBA.
    // For ordinary Mute, remember a manual override so page updates do not
    // immediately mute the tab again.
    if (record.claims.includes('mute')) {
      record.claims = record.claims.filter((item) => item !== 'mute');
      record.muteSuppressed = true;
    }
    record.mutedBySba = false;

    // Hidden tabs must remain silent. This is the only hard invariant; users
    // can freely override Mute on visible tabs.
    if (record.claims.includes('hide') && !mutedInfo?.muted) {
      await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
      record.mutedBySba = true;
    }

    if (record.claims.length === 0 && !record.muteSuppressed) delete records[key];
    else records[key] = record;
    await writeNativeMuteRecords(records);
  });
}

async function forgetNativeMuteTab(tabId) {
  return withNativeMuteLock(async () => {
    const records = await readNativeMuteRecords();
    delete records[String(tabId)];
    await writeNativeMuteRecords(records);
  });
}

let nativeMuteInitializationPromise = null;

function initializeNativeMuteState() {
  if (nativeMuteInitializationPromise) return nativeMuteInitializationPromise;
  nativeMuteInitializationPromise = (async () => {
    const tabs = await chrome.tabs.query({});
    const liveTabIds = new Set(tabs.map((tab) => String(tab.id)));

    await withNativeMuteLock(async () => {
      const records = await readNativeMuteRecords();
      for (const tabId of Object.keys(records)) {
        if (!liveTabIds.has(tabId)) delete records[tabId];
      }
      await writeNativeMuteRecords(records);
    });

    const hidden = await getState(STORAGE_KEYS.HIDDEN);
    const hiddenIds = new Set(hidden.map((record) => record.tabId));
    for (const tab of tabs) {
      if (hiddenIds.has(tab.id)) await acquireNativeMuteClaim(tab.id, 'hide');
    }

    const migration = await chrome.storage.local.get(NATIVE_MUTE_MIGRATION_KEY);
    const cleanLegacyMediaState = !migration[NATIVE_MUTE_MIGRATION_KEY];
    if (await getScriptMute()) {
      const keywords = await getKeywords();
      for (const tab of tabs) {
        if (tabMatchesKeywords(tab, keywords)) {
          // Clean up media-element state left by the previous implementation
          // before transferring responsibility to native tab mute.
          if (cleanLegacyMediaState) await injectScript(tab.id, UNMUTE_SCRIPT);
          await acquireNativeMuteClaim(tab.id, 'mute');
        }
      }
    }
    if (cleanLegacyMediaState) {
      await chrome.storage.local.set({ [NATIVE_MUTE_MIGRATION_KEY]: true });
    }
  })().finally(() => {
    nativeMuteInitializationPromise = null;
  });
  return nativeMuteInitializationPromise;
}

// ───────────────────────── hide mode ─────────────────────────

/**
 * Apply the current hide mode to a single tab. No-op if hide mode is off.
 */
async function enforceHideOnTab(tab) {
  if (!(await getHideMode())) return;
  const keywords = await getKeywords();
  if (!tabMatchesKeywords(tab, keywords)) return;
  await syncPauseMediaControllerOnTab(tab);
  await hideTab(tab);
}

async function setHideMode(on) {
  await setState(STORAGE_KEYS.HIDE_MODE, on);
  if (on) {
    const tabs = await findMatchingTabs();
    for (const tab of tabs) {
      await syncPauseMediaControllerOnTab(tab);
      await hideTab(tab);
    }
  } else {
    await unhideAll();
    await syncAllPauseMediaControllers();
  }
  await updateBadge();
}

/**
 * Move a single tab into the stash window and record it. Skips tabs already hidden.
 */
async function hideTab(tab) {
  // Hide has its own native-mute claim. It composes with Mute and remembers
  // whether the tab was already muted by the user before SBA touched it.
  await acquireNativeMuteClaim(tab.id, 'hide');
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
 * Restore all hidden tabs to their original windows/positions. Releasing the
 * Hide claim only unmutes when no Mute claim or external owner remains.
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
      await releaseNativeMuteClaim(record.tabId, 'hide');
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
  newlyCreatedTabs.set(tab.id, Date.now());
  maybeApplyToTabLater(tab.id);
  reevaluateSensitiveSession().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.mutedInfo) {
    handleExternalNativeMuteChange(tabId, change.mutedInfo).catch(() => {});
  }
  if ('url' in change || 'title' in change || change.status === 'complete') {
    enforceNativeMuteOnTab(tab).catch(() => {});
    enforceHideOnTab(tab).catch(() => {});
    enforceFaviconOnTab(tab).catch(() => {});
    reevaluateSensitiveSession().catch(() => {});
    // Existing-tab navigation (including same-site links and back/forward)
    // deliberately does not flash. Only a newly created matching tab gets a
    // one-time load flash; switching tabs is handled by onActivated below.
    flashNewTabIfMatched(tab).catch(() => {});
  }
});

// ───────────────────────── match-hit feedback ─────────────────────────

const MATCH_FLASH_COOLDOWN_MS = 1500;
const NEW_TAB_FLASH_WINDOW_MS = 15_000;
const lastMatchFlashByTab = new Map();
const newlyCreatedTabs = new Map();

/** Flash once when a newly created active tab first resolves to a match. */
async function flashNewTabIfMatched(tab) {
  const createdAt = newlyCreatedTabs.get(tab.id);
  if (createdAt == null) return;
  if (Date.now() - createdAt > NEW_TAB_FLASH_WINDOW_MS) {
    newlyCreatedTabs.delete(tab.id);
    return;
  }
  if (!tab.active) return;
  const keywords = await getKeywords();
  if (!keywords.length || !tabMatchesKeywords(tab, keywords)) return;
  newlyCreatedTabs.delete(tab.id);
  await flashIfMatched(tab);
}

/**
 * Flash a red border on the tab if it matches a keyword and the feedback
 * setting is on. Only called for the active tab — flashing a background tab
 * would be invisible.
 */
async function flashIfMatched(tab) {
  if (!(await getRedBorderFlash())) return false;
  const keywords = await getKeywords();
  if (!keywords.length || !tabMatchesKeywords(tab, keywords)) return false;

  // Avoid double-flashes when new-tab loading and activation overlap within
  // a short window.
  const now = Date.now();
  if (now - (lastMatchFlashByTab.get(tab.id) || 0) < MATCH_FLASH_COOLDOWN_MS) return false;
  lastMatchFlashByTab.set(tab.id, now);

  return injectScript(tab.id, FLASH_RED_BORDER_SCRIPT);
}

// Switching to a matching tab (or a newly opened one that already matches).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    // Keep a brand-new blank tab pending until its URL/title resolves. Once
    // activation actually flashes a match, prevent a later load event from
    // flashing it a second time.
    if (await flashIfMatched(tab)) newlyCreatedTabs.delete(tabId);
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
  newlyCreatedTabs.delete(tabId);
  lastMatchFlashByTab.delete(tabId);
  forgetNativeMuteTab(tabId).catch(() => {});
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
    await releaseNativeMuteClaim(tabId, 'hide');
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
        await enforceNativeMuteOnTab(tab);
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
    await setNativeMuteMode(!(await getScriptMute()));
  } else if (command === 'toggle-hide') {
    await setHideMode(!(await getHideMode()));
  } else if (command === 'clean-sensitive-data') {
    await runCleanup();
  } else if (command === 'emergency-mode') {
    let action = await getEmergencyAction();
    if (action === 'closeMatchTabs' && !isPremium()) action = 'muteHide';
    if (action === 'closeMatchTabs') {
      const matching = await findMatchingTabs();
      for (const t of matching) {
        try { await chrome.tabs.remove(t.id); } catch {}
      }
    } else {
      await setNativeMuteMode(true);
      await setHideMode(true);
    }
  }
  await updateBadge();
});

// ───────────────────────── message bridge ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'set-mute-mode': {
        await setNativeMuteMode(!!msg.on);
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
      case 'refresh-license-state': {
        sendResponse({ ok: true, premium: await initializeLicenseState() });
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
  await initializeNativeMuteState();
  await initializeLicenseState();
  await syncAllPauseMediaControllers();
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

// One shared initialization/check-in prevents duplicate network requests when
// Service Worker startup and browser startup happen close together. This also
// runs at module startup, which is important when an extension is re-enabled:
// Chrome starts the worker but does not necessarily emit runtime.onStartup.
let licenseInitializationPromise = null;

function initializeLicenseState() {
  if (licenseInitializationPromise) return licenseInitializationPromise;
  licenseInitializationPromise = (async () => {
    await refreshPremiumState();
    await maybeCheckIn(); // skips the network while the signed state is fresh
    return refreshPremiumState();
  })().finally(() => {
    licenseInitializationPromise = null;
  });
  return licenseInitializationPromise;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LICENSE_CHECK_IN_ALARM) {
    initializeLicenseState().catch(() => {});
  }
});

// Keep the sync premium cache in step with activation from the options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.LICENSE]) {
    refreshPremiumState().then(() => syncAllPauseMediaControllers()).catch(() => {});
  } else if (changes[STORAGE_KEYS.PAUSE_ON_MUTE_HIDE]
      || changes[STORAGE_KEYS.KEYWORDS]) {
    syncAllPauseMediaControllers().catch(() => {});
  }
});

// Restore and, when necessary, revalidate Premium on every Service Worker
// start—including extension re-enable, where runtime.onStartup may not fire.
initializeLicenseState()
  .then(() => syncAllPauseMediaControllers())
  .catch(() => {});
scheduleLicenseCheckIn();

async function rehydrateStashWindowIds() {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  hidden.forEach((r) => STASH_WINDOW_IDS.add(r.windowId));
}
rehydrateStashWindowIds();
initializeNativeMuteState().catch(() => {});
