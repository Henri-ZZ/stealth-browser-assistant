import {
  STORAGE_KEYS, getKeywords, setState, getEmergencyAction, getPauseOnMuteHide,
  getRedBorderFlash, getTabIconOverride, getCleanupTypes, setCleanupType, CLEANUP_TYPE_KEYS,
  getAutoCleanupState, setAutoCleanupState,
  resolveLocale, tFor, getLangPref, SUPPORTED_LOCALES,
  isPremium, getKeywordLimit, refreshPremiumState,
} from './shared.js';
import { activateLicense } from './license.js';

const $ = (id) => document.getElementById(id);

let LOCALE = 'en';

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
  list.innerHTML = '';
  $('hint').style.display = keywords.length ? 'none' : 'block';
  updateKeywordsCount(keywords.length);

  keywords.forEach((kw, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="kw-chip">${escapeHtml(kw)}</span>
      <button class="kw-remove" title="${t('remove')}" data-i="${i}">×</button>`;
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
    ['kbdToggleEmergency', 'emergency-mode'],
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

const PREMIUM_URL = 'https://stealthba.henri.ren/';

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
  let emergencyAction = await getEmergencyAction();
  if (!isPremium() && emergencyAction === 'closeMatchTabs') {
    await setState(STORAGE_KEYS.EMERGENCY_ACTION, 'muteHide');
    emergencyAction = 'muteHide';
  }
  if (!isPremium() && await getPauseOnMuteHide()) {
    await setState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE, false);
  }

  // Emergency action radios
  document.querySelectorAll('input[name="emergencyAction"]').forEach((input) => {
    input.checked = input.value === emergencyAction;
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      await setState(STORAGE_KEYS.EMERGENCY_ACTION, input.value);
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

  // Clean sensitive data: one checkbox per type, all premium-locked
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

  // Open chrome://extensions/shortcuts
  $('openShortcutsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  await applyShortcuts();
  // Re-fetch when the user returns from chrome://extensions/shortcuts.
  window.addEventListener('focus', () => { applyShortcuts(); });

  setupPremiumTriggers();

  setupPremiumCard();
});

/**
 * Apply premium status to the page: toggle the body class (which drives the
 * header badge, lock icons, and card visibility) and enable/disable the
 * premium-only inputs.
 */
function applyPremiumState() {
  const premium = isPremium();
  document.body.classList.toggle('is-premium', premium);
  document.querySelectorAll('input[name="emergencyAction"]').forEach((input) => {
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
  if (/Macintosh|Mac OS X/.test(ua)) return 'Chrome on macOS';
  if (/Windows/.test(ua)) return 'Chrome on Windows';
  if (/Android/.test(ua)) return 'Chrome on Android';
  if (/Linux/.test(ua)) return 'Chrome on Linux';
  return 'Chrome';
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
      setTimeout(() => applyPremiumState(), 1000);
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