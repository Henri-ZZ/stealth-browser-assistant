import {
  STORAGE_KEYS, getState, getKeywords, setState, getPanicButtonAction, getPauseOnMuteHide,
  getRedBorderFlash, getTabIconOverride, getCleanupTypes, setCleanupType, CLEANUP_TYPE_KEYS,
  requestCleanupPermissions, hasCleanupPermissions,
  getAutoCleanupState, setAutoCleanupState,
  resolveLocale, tFor, getLangPref, SUPPORTED_LOCALES,
  isPremium, getKeywordLimit, refreshPremiumState,
} from './shared.js';
import { activateLicense } from './license.js';
import { PREMIUM_URL, CONTACT_URL, getStoreReviewUrl } from './config.js';

const $ = (id) => document.getElementById(id);

let LOCALE = 'en';

function ensureLicenseState() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'refresh-license-state' }, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

function t(key, subs) {
  return tFor(LOCALE, key, subs);
}

async function applyI18n() {
  LOCALE = await resolveLocale();
  document.documentElement.lang = LOCALE;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.title = t('optionsPageTitle');
  // Re-render keyword chips so their Remove tooltips re-localize.
  await renderKeywords();
}

function updateKeywordsCount(count) {
  const el = $('keywordsCount');
  if (!el) return;
  const limit = getKeywordLimit();
  el.textContent = limit === Infinity ? `${count} / ∞` : `${count} / ${limit}`;
  el.classList.toggle('is-full', limit !== Infinity && count >= limit);
}

async function renderKeywords() {
  const keywords = await getKeywords();
  const list = $('keywordList');
  list.replaceChildren();
  $('hint').style.display = keywords.length ? 'none' : 'block';
  updateKeywordsCount(keywords.length);

  keywords.forEach((kw, i) => {
    const li = document.createElement('li');

    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.textContent = kw; // textContent auto-escapes — no innerHTML needed.

    const remove = document.createElement('button');
    remove.className = 'kw-remove';
    remove.title = t('remove');
    remove.dataset.i = String(i);
    remove.textContent = '\u00d7';

    li.append(chip, remove);
    list.appendChild(li);
  });

  list.querySelectorAll('.kw-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.i);
      const all = await getKeywords();
      all.splice(idx, 1);
      await setState(STORAGE_KEYS.KEYWORDS, all);
      renderKeywords();
    });
  });
}

/**
 * Replace each <kbd id="kbdXxx"> with the shortcut the user actually has bound
 * (Chrome's chrome.commands API). Falls back to the rendered fallback text in
 * the HTML when the API is unavailable or the user cleared the shortcut.
 */
async function applyShortcuts() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    return; // no commands permission — keep the HTML defaults
  }
  // Chrome's commands API reports the suggested key as "Alt" even on macOS
  // (where it actually maps to the Option key) — spell it out for Mac users.
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
  const displayShortcut = (s) =>
    isMac ? String(s).replace(/\bAlt\+/g, 'Option+') : s;

  const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut || '']));
  const map = [
    ['kbdToggleMute', 'toggle-mute'],
    ['kbdToggleHide', 'toggle-hide'],
    ['kbdPanicButton', 'panic-button'],
    ['kbdCleanSensitive', 'clean-sensitive-data'],
  ];
  for (const [id, csName] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = byName[csName];
    if (value) {
      el.textContent = displayShortcut(value);
    } else {
      el.textContent = t('shortcutDisabled');
    }
  }
}

function showPopover(trigger, text) {
  const popover = $('premiumPopover');
  const ctaEl = $('premiumPopoverCta');
  if (!popover || !ctaEl) return;

  ctaEl.textContent = text;
  popover.hidden = false;

  const rect = trigger.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const padding = 8;
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  left = Math.max(padding, Math.min(left, window.innerWidth - popRect.width - padding));
  let top = rect.top - popRect.height - 6;
  if (top < padding) {
    top = rect.bottom + 6;
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function hidePopover() {
  const popover = $('premiumPopover');
  if (popover) popover.hidden = true;
}

function setupPremiumTriggers() {
  if (isPremium()) return;

  const pill = $('keywordsCount');
  const pauseOption = document.querySelector('label.checkbox-option:has(#pauseOnMuteHide)');
  const closeOption = document.querySelector('label.radio-option:has(input[value="closeMatchTabs"])');
  const cleanupOptions = [...document.querySelectorAll('label.cleanup-option')];
  const autoCleanupOption = document.querySelector('label.auto-cleanup-option');
  const popover = $('premiumPopover');

  const triggers = [
    { el: pill, key: 'premiumUnlockUnlimited', needsFull: true },
    { el: pauseOption, key: 'premiumUnlockFeature' },
    { el: closeOption, key: 'premiumUnlockFeature' },
    ...cleanupOptions.map((el) => ({ el, key: 'premiumUnlockFeature' })),
    { el: autoCleanupOption, key: 'premiumUnlockFeature' },
  ].filter((tr) => tr.el);

  let leaveTimer = null;

  const showFor = (trigger) => {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    showPopover(trigger.el, t(trigger.key));
  };

  const scheduleHide = () => {
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      hidePopover();
      leaveTimer = null;
    }, 150);
  };

  triggers.forEach((trigger) => {
    trigger.el.addEventListener('mouseenter', () => {
      // Re-check on every hover: if the user upgraded mid-session the cache is
      // already true (refreshPremiumState runs right after activation).
      if (isPremium()) return;
      if (trigger.needsFull && !trigger.el.classList.contains('is-full')) return;
      showFor(trigger);
    });
    trigger.el.addEventListener('mouseleave', scheduleHide);
  });

  if (popover) {
    popover.addEventListener('mouseenter', () => {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    });
    popover.addEventListener('mouseleave', scheduleHide);
  }

  const cta = $('premiumPopoverCta');
  if (cta) {
    cta.addEventListener('click', () => {
      chrome.tabs.create({ url: PREMIUM_URL });
      hidePopover();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePopover();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await applyI18n();
  // Wait for the background's de-duplicated startup check-in before rendering
  // or downgrading Premium-only settings. This is especially important after
  // the extension has been disabled and re-enabled.
  await ensureLicenseState();
  await refreshPremiumState();

  // Language dropdown
  const langSelect = $('langSelect');
  const pref = await getLangPref();
  langSelect.value = SUPPORTED_LOCALES.includes(pref) ? pref : '';
  langSelect.addEventListener('change', async () => {
    await setState(STORAGE_KEYS.LANG_PREF, langSelect.value);
    await applyI18n();
    if (typeof renderAutoCleanup === 'function') renderAutoCleanup();
  });

  applyPremiumState();

  // Downgrade stale premium-only settings for free users so the UI matches
  // what the extension will actually do.
  let panicButtonAction = await getPanicButtonAction();
  if (!isPremium() && panicButtonAction === 'closeMatchTabs') {
    await setState(STORAGE_KEYS.PANIC_BUTTON_ACTION, 'muteHide');
    panicButtonAction = 'muteHide';
  }
  if (!isPremium() && await getPauseOnMuteHide()) {
    await setState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE, false);
  }

  // Panic Button action radios
  document.querySelectorAll('input[name="panicButtonAction"]').forEach((input) => {
    input.checked = input.value === panicButtonAction;
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      await setState(STORAGE_KEYS.PANIC_BUTTON_ACTION, input.value);
    });
  });

  // Pause-on-mute/hide checkbox
  const pauseCheckbox = $('pauseOnMuteHide');
  if (pauseCheckbox) {
    pauseCheckbox.checked = await getPauseOnMuteHide();
    pauseCheckbox.addEventListener('change', async () => {
      await setState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE, pauseCheckbox.checked);
    });
  }

  // Match-hit feedback: red border flash
  const redBorderFlash = $('redBorderFlash');
  if (redBorderFlash) {
    redBorderFlash.checked = await getRedBorderFlash();
    redBorderFlash.addEventListener('change', async () => {
      await setState(STORAGE_KEYS.RED_BORDER_FLASH, redBorderFlash.checked);
    });
  }

  // Match-hit feedback: replace tab icon
  const tabIconOverride = $('tabIconOverride');
  if (tabIconOverride) {
    tabIconOverride.checked = await getTabIconOverride();
    tabIconOverride.addEventListener('change', async () => {
      await setState(STORAGE_KEYS.TAB_ICON_OVERRIDE, tabIconOverride.checked);
    });
  }

  // Clean sensitive data: one checkbox per type, all premium-locked. Each type
  // maps to an optional permission — requesting it here (inside the user's
  // change gesture) avoids install-time warnings. On denial, revert the
  // checkbox so the UI never claims a feature that won't work.
  const cleanupInputs = {
    history: 'cleanHistory',
    cookies: 'cleanCookies',
    downloads: 'cleanDownloads',
  };
  const cleanupState = await getCleanupTypes();
  for (const type of CLEANUP_TYPE_KEYS) {
    const el = $(cleanupInputs[type]);
    if (!el) continue;
    el.checked = !!cleanupState[type];
    el.addEventListener('change', async () => {
      if (el.checked) {
        const granted = await requestCleanupPermissions([type]);
        if (!granted) {
          el.checked = false; // revert — feature can't work without permission
          await setCleanupType(type, false);
          showPermissionNotice();
          return;
        }
      }
      await setCleanupType(type, el.checked);
    });
  }

  // Auto cleanup: toggle + numeric delay (minutes), premium-locked
  const autoState = await getAutoCleanupState();
  const autoToggle = $('autoCleanupToggle');
  const autoDelayRow = $('autoCleanupDelay');
  const autoMinutes = $('autoCleanupMinutes');
  const autoHelp = $('autoCleanupHelp');
  const renderAutoCleanup = () => {
    if (!autoToggle) return;
    autoToggle.checked = !!autoState.enabled;
    if (autoMinutes) autoMinutes.value = String(autoState.delayMinutes);
    if (autoDelayRow) autoDelayRow.hidden = !autoState.enabled;
    if (autoHelp && LOCALE) {
      autoHelp.textContent = tFor(LOCALE, 'autoCleanupHelp', [String(autoState.delayMinutes)]);
    }
  };
  if (autoToggle) {
    autoToggle.addEventListener('change', async () => {
      if (autoToggle.checked) {
        // Auto cleanup runs from background alarms, which have NO user gesture
        // — permission prompts are impossible there. Request every cleanup
        // permission up-front (Chrome silently grants ones already held, so
        // this only ever shows one prompt even for repeat enables). contains()
        // is probed first so we don't fall into the anti-nagging trap where
        // the user previously denied a request but later granted the same
        // permission via the browser's extension page. Deny → revert.
        const alreadyHave = await hasCleanupPermissions(CLEANUP_TYPE_KEYS);
        const granted = alreadyHave || await requestCleanupPermissions(CLEANUP_TYPE_KEYS);
        if (!granted) {
          autoToggle.checked = false;
          showPermissionNotice();
          renderAutoCleanup();
          return;
        }
      }
      autoState.enabled = autoToggle.checked;
      await setAutoCleanupState({ enabled: autoState.enabled });
      renderAutoCleanup();
    });
  }
  if (autoMinutes) {
    autoMinutes.addEventListener('input', async () => {
      // digits only, clamp to [1, 1440]
      const digits = autoMinutes.value.replace(/\D/g, '');
      const minutes = Math.min(1440, Math.max(1, parseInt(digits || '1', 10)));
      autoMinutes.value = String(minutes);
      autoState.delayMinutes = minutes;
      await setAutoCleanupState({ delayMinutes: minutes });
      renderAutoCleanup();
    });
  }
  renderAutoCleanup();

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('newKeyword');
    const value = input.value.trim();
    if (!value) return;
    const all = await getKeywords();
    if (!all.includes(value)) {
      const limit = getKeywordLimit();
      if (all.length >= limit) {
        input.value = '';
        return;
      }
      all.push(value);
      await setState(STORAGE_KEYS.KEYWORDS, all);
    }
    input.value = '';
    await renderKeywords();
  });

  await renderKeywords();

  // Open the browser's keyboard-shortcut settings. Firefox blocks extensions
  // from opening about:addons, so it gets a manual-path hint instead.
  $('openShortcutsLink').addEventListener('click', (e) => {
    e.preventDefault();
    if (isFirefox()) {
      showNavHint();
    } else {
      openBrowserPage('chrome://extensions/shortcuts');
    }
  });

  await applyShortcuts();
  // Re-fetch when the user returns from chrome://extensions/shortcuts.
  window.addEventListener('focus', () => { applyShortcuts(); });

  setupPremiumTriggers();

  setupPremiumCard();

  // Support links: route Leave Review to the current browser's store, while
  // Contact remains derived from the centralized website origin.
  const leaveReviewBtn = $('leaveReviewBtn');
  if (leaveReviewBtn) {
    leaveReviewBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: getStoreReviewUrl(navigator.userAgent || '') });
    });
  }
  const sendFeedbackBtn = $('sendFeedbackBtn');
  if (sendFeedbackBtn) {
    sendFeedbackBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: CONTACT_URL });
    });
  }

  // Permission-denied recovery: jumps to chrome://extensions (Chrome won't
  // re-prompt after a denial, so this is the only way back in).
  const permBtn = $('openPermissionBtn');
  if (permBtn) permBtn.addEventListener('click', openExtensionPermissions);

  // If the offline grace window (48h) ran out while Licentra was unreachable,
  // show an explicit error so the user knows it's a connectivity problem, not
  // a broken key. The license row is kept — the next successful check-in
  // recovers automatically.
  await showGraceExhaustedNotice();
});

/**
 * True on Firefox. Detection must NOT rely on chrome.* aliases: Firefox's
 * chrome.* namespace is incomplete — Firefox-only APIs like getBrowserInfo /
 * getPlatformInfo exist only under browser.*, so `typeof
 * chrome.runtime.getBrowserInfo` is 'undefined' even on Firefox. The `browser`
 * global itself is Firefox-specific: Chrome and Edge extension pages expose
 * only `chrome`. Used to branch on management-page URLs.
 */
function isFirefox() {
  return typeof browser !== 'undefined' && typeof browser.runtime?.getBrowserInfo === 'function';
}

/**
 * Open a browser-internal management page in a new tab (Chrome/Edge). Firefox
 * never reaches this helper — about:addons is blocked there and the nav-hint
 * path is used instead.
 */
function openBrowserPage(url) {
  chrome.tabs.create({ url }).catch((err) => {
    console.warn('Stealth Browser Assistant: could not open', url, err);
  });
}

/**
 * Show "permission denied" inline in the cleanup section, with a button that
 * jumps to the browser's extension management page. Auto-hides after a few
 * seconds. Chrome suppresses repeated permission prompts after a denial, so
 * the user's only recovery path is the management page — point them there.
 */
function showPermissionNotice() {
  const el = $('permissionNotice');
  if (!el) return;
  const textEl = $('permissionNoticeText');
  if (textEl) textEl.textContent = t('cleanupPermissionDenied');
  el.hidden = false;
  clearTimeout(showPermissionNotice._t);
  showPermissionNotice._t = setTimeout(() => { el.hidden = true; }, 8000);
}

// The permission page for this extension. Chrome suppresses re-prompts after
// a denial, so this is the reliable path for the user to re-grant. Firefox
// blocks extensions from opening about:addons, so it gets a manual-path hint.
function openExtensionPermissions() {
  if (isFirefox()) {
    showNavHint();
    return;
  }
  const id = chrome.runtime?.id ? chrome.runtime.id : '';
  openBrowserPage(`chrome://extensions/?id=${id}`);
}

/**
 * Firefox-only guidance toast: Firefox blocks extensions from opening
 * about:addons via any tabs/windows API, so these entries can't auto-jump.
 * Show the manual path instead. Auto-hides after a few seconds.
 */
function showNavHint() {
  const el = $('navHint');
  if (!el) return;
  el.textContent = t('firefoxManualNavHint');
  el.hidden = false;
  clearTimeout(showNavHint._t);
  showNavHint._t = setTimeout(() => { el.hidden = true; }, 10000);
}

/**
 * Show an explicit error hint in the premium card when both the signed
 * validUntil and the grace window have lapsed but the license row still
 * exists (i.e. the server never answered, not a revocation). Surfaces the
 * server's actual last error (e.g. "500 internal_server_error") when one was
 * recorded; falls back to the generic connectivity message otherwise.
 */
async function showGraceExhaustedNotice() {
  const lic = await getState(STORAGE_KEYS.LICENSE);
  if (!lic) return;
  const now = Date.now();
  const sigFresh = typeof lic.validUntil === 'number' && lic.validUntil > now;
  const graceFresh = typeof lic.graceUntil === 'number' && lic.graceUntil > now;
  if (sigFresh || graceFresh) return;
  const statusEl = $('premiumActivateStatus');
  if (!statusEl) return;

  const se = lic.lastServerError;
  if (se && typeof se === 'object' && se.status && se.error) {
    statusEl.textContent = `${se.status} ${se.error}`;
  } else {
    statusEl.textContent = t('premiumActivateError');
  }
}

/**
 * Apply premium status to the page: toggle the body class (which drives the
 * header badge, lock icons, and card visibility) and enable/disable the
 * premium-only inputs.
 */
function applyPremiumState() {
  const premium = isPremium();
  document.body.classList.toggle('is-premium', premium);
  document.querySelectorAll('input[name="panicButtonAction"]').forEach((input) => {
    if (input.value === 'closeMatchTabs') input.disabled = !premium;
  });
  const pauseCheckbox = $('pauseOnMuteHide');
  if (pauseCheckbox) pauseCheckbox.disabled = !premium;
  document.querySelectorAll('.cleanup-option input[type="checkbox"]').forEach((input) => {
    input.disabled = !premium;
  });
  const autoCleanupToggle = $('autoCleanupToggle');
  if (autoCleanupToggle) autoCleanupToggle.disabled = !premium;
}

/** A human-readable device label sent with activation (shown in Licentra). */
function deviceLabel() {
  const ua = navigator.userAgent || '';
  const os = /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown';
  // Edge ships a Chromium UA too — test it BEFORE the generic Chrome check.
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox/.test(ua) ? 'Firefox'
    : /Chrome|Chromium/.test(ua) ? 'Chrome'
    : 'Browser';
  return `${browser} on ${os}`;
}

function activateReasonMessage(reason) {
  switch (reason) {
    case 'invalid_format':
    case 'license_not_found':
      return t('premiumActivateInvalid');
    case 'license_revoked':
      return t('premiumActivateRevoked');
    case 'license_refunded':
      return t('premiumActivateRefunded');
    // Business-level expiry (payload.license_expires_at lapsed) or the
    // server's license_expired reason — the key itself is fine, the
    // subscription has ended. Reuse the invalid message until we add a
    // dedicated "expired" string to the language packs.
    case 'expired':
    case 'license_expired':
      return t('premiumActivateInvalid');
    default:
      return t('premiumActivateError');
  }
}

/**
 * "Premium" card — always expanded: a short intro, a "learn more" link, and a
 * code-activation field for users who already bought a license.
 */
function setupPremiumCard() {
  const learnBtn = $('premiumLearnBtn');
  if (learnBtn) {
    learnBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: PREMIUM_URL });
    });
  }

  const input = $('premiumCodeInput');
  const activateBtn = $('premiumActivateBtn');
  const status = $('premiumActivateStatus');

  const activate = async () => {
    if (!status) return;
    const code = (input ? input.value : '').trim();
    if (!code) {
      status.textContent = t('premiumActivateEmpty');
      status.hidden = false;
      return;
    }

    if (activateBtn) activateBtn.disabled = true;
    status.textContent = t('premiumActivating');
    status.hidden = false;

    const result = await activateLicense(code, deviceLabel());

    if (result.ok) {
      if (input) input.value = '';
      status.textContent = t('premiumActivateSuccess');
      status.hidden = false;
      await refreshPremiumState();
      hidePopover(); // no more upsell popovers once premium
      await renderKeywords(); // keyword counter → ∞ once premium
      // Let the success message read, then unlock premium features (the
      // is-premium class also hides this card and shows the header badge).
      // After the layout updates, scroll to the top so the user sees the
      // larger Premium badge instead of only noticing that the form vanished.
      setTimeout(() => {
        applyPremiumState();
        requestAnimationFrame(() => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }, 1000);
    } else {
      status.textContent = activateReasonMessage(result.reason);
      status.hidden = false;
      if (activateBtn) activateBtn.disabled = false;
    }
  };

  if (activateBtn) activateBtn.addEventListener('click', activate);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && activateBtn) activateBtn.click();
    });
    input.addEventListener('input', () => {
      if (status) status.hidden = true;
    });
  }
}
