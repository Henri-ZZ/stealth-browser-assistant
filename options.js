import {
  STORAGE_KEYS, getKeywords, setState,
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
});