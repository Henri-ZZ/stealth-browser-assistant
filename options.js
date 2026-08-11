import {
  STORAGE_KEYS, getKeywords, setState, getEmergencyAction, getPauseOnMuteHide,
  resolveLocale, tFor, getLangPref, SUPPORTED_LOCALES,
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

async function renderKeywords() {
  const keywords = await getKeywords();
  const list = $('keywordList');
  list.innerHTML = '';
  $('hint').style.display = keywords.length ? 'none' : 'block';

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

  // Emergency action radios
  const emergencyAction = await getEmergencyAction();
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

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('newKeyword');
    const value = input.value.trim();
    if (!value) return;
    const all = await getKeywords();
    if (!all.includes(value)) {
      all.push(value);
      await setState(STORAGE_KEYS.KEYWORDS, all);
    }
    input.value = '';
    renderKeywords();
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
});