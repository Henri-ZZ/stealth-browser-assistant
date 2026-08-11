// Service worker for Stealth Tabs.
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
  tabMatchesKeywords,
} from './shared.js';

const STASH_WINDOW_STATE = 'minimized';

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
async function injectScript(tabId, func) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func });
    return true;
  } catch {
    return false;
  }
}

function MUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = true; }); }
function UNMUTE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { el.muted = false; }); }
function PAUSE_SCRIPT() { document.querySelectorAll('audio, video').forEach(el => { if (!el.paused) el.pause(); }); }

async function setScriptMute(on) {
  await setState(STORAGE_KEYS.SCRIPT_MUTE, on);
  const tabs = await findMatchingTabs();
  const func = on ? MUTE_SCRIPT : UNMUTE_SCRIPT;
  const shouldPause = on && await getPauseOnMuteHide();
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
  if (await getPauseOnMuteHide()) await injectScript(tab.id, PAUSE_SCRIPT);
}

// ───────────────────────── hide mode ─────────────────────────

/**
 * Apply the current hide mode to a single tab. No-op if hide mode is off.
 */
async function enforceHideOnTab(tab) {
  if (!(await getHideMode())) return;
  const keywords = await getKeywords();
  if (!tabMatchesKeywords(tab, keywords)) return;
  if (await getPauseOnMuteHide()) await injectScript(tab.id, PAUSE_SCRIPT);
  await hideTab(tab);
}

async function setHideMode(on) {
  await setState(STORAGE_KEYS.HIDE_MODE, on);
  if (on) {
    const tabs = await findMatchingTabs();
    const shouldPause = await getPauseOnMuteHide();
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
      console.warn('Stealth Tabs: failed to restore tab', record, err);
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
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ('url' in change || 'title' in change || change.status === 'complete') {
    enforceScriptMuteOnTab(tab).catch(() => {});
    enforceHideOnTab(tab).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
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
        return;
      }
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ───────────────────────── keyboard commands ─────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-mute') {
    await setScriptMute(!(await getScriptMute()));
  } else if (command === 'toggle-hide') {
    await setHideMode(!(await getHideMode()));
  } else if (command === 'emergency-mode') {
    const action = await getEmergencyAction();
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
  await updateBadge();
  if (await getHideMode()) {
    const tabs = await findMatchingTabs();
    for (const tab of tabs) await hideTab(tab);
  }
});

chrome.runtime.onInstalled.addListener(updateBadge);

async function rehydrateStashWindowIds() {
  const hidden = await getState(STORAGE_KEYS.HIDDEN);
  hidden.forEach((r) => STASH_WINDOW_IDS.add(r.windowId));
}
rehydrateStashWindowIds();