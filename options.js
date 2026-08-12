import {
  STORAGE_KEYS, getKeywords, setState, getEmergencyAction, getPauseOnMuteHide,
  resolveLocale, tFor, getLangPref, SUPPORTED_LOCALES,
  isPremium, getKeywordLimit,
} from './shared.js';

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
  const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut || '']));
  const map = [
    ['kbdToggleMute', 'toggle-mute'],
    ['kbdToggleHide', 'toggle-hide'],
    ['kbdToggleEmergency', 'emergency-mode'],
  ];
  for (const [id, csName] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = byName[csName];
    if (value) {
      el.textContent = value;
    } else {
      el.textContent = t('shortcutDisabled');
    }
  }
}

const PREMIUM_URL = 'https://example.com/premium'; // TODO: real product URL

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
  const popover = $('premiumPopover');

  const triggers = [
    { el: pill, key: 'premiumUnlockUnlimited', needsFull: true },
    { el: pauseOption, key: 'premiumUnlockFeature' },
    { el: closeOption, key: 'premiumUnlockFeature' },
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

  // Language dropdown
  const langSelect = $('langSelect');
  const pref = await getLangPref();
  langSelect.value = SUPPORTED_LOCALES.includes(pref) ? pref : '';
  langSelect.addEventListener('change', async () => {
    await setState(STORAGE_KEYS.LANG_PREF, langSelect.value);
    await applyI18n();
  });

  const premium = isPremium();
  document.body.classList.toggle('is-premium', premium);

  // Downgrade stale premium-only settings for free users so the UI matches
  // what the extension will actually do.
  let emergencyAction = await getEmergencyAction();
  if (!premium && emergencyAction === 'closeMatchTabs') {
    await setState(STORAGE_KEYS.EMERGENCY_ACTION, 'muteHide');
    emergencyAction = 'muteHide';
  }
  if (!premium && await getPauseOnMuteHide()) {
    await setState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE, false);
  }

  // Emergency action radios
  document.querySelectorAll('input[name="emergencyAction"]').forEach((input) => {
    input.checked = input.value === emergencyAction;
    if (input.value === 'closeMatchTabs') input.disabled = !premium;
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      await setState(STORAGE_KEYS.EMERGENCY_ACTION, input.value);
    });
  });

  // Pause-on-mute/hide checkbox
  const pauseCheckbox = $('pauseOnMuteHide');
  if (pauseCheckbox) {
    pauseCheckbox.checked = await getPauseOnMuteHide();
    pauseCheckbox.disabled = !premium;
    pauseCheckbox.addEventListener('change', async () => {
      await setState(STORAGE_KEYS.PAUSE_ON_MUTE_HIDE, pauseCheckbox.checked);
    });
  }

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

  // Persistent upgrade CTA at the bottom — opens the same premium URL as the popover.
  const upgradeBtn = $('premiumUpgradeCta');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: PREMIUM_URL });
    });
  }
});