import { resolveLocale, tFor, isPremium, refreshPremiumState, getCleanupTypes } from './shared.js';

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
  // Re-apply toggle ON/OFF labels once translation is ready.
  refreshStatus();
}

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function setToggleVisuals(btn, on) {
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('is-on', on);
  const stateEl = btn.querySelector('[data-state]');
  if (stateEl) stateEl.textContent = on ? t('stateOn') : t('stateOff');
}

async function refreshStatus() {
  const status = await send({ type: 'status' });
  if (!status || !status.ok) return;
  setToggleVisuals(document.getElementById('muteToggle'), status.scriptMute);
  setToggleVisuals(document.getElementById('hideToggle'), status.hideMode);
  document.getElementById('matchStatus').textContent =
    t('statusMatching', [String(status.matching)]);
  document.getElementById('hiddenStatus').textContent =
    status.hideMode || status.hidden > 0
      ? t('statusHidden', [String(status.hidden)])
      : t('statusMatching', [String(status.matching)]);
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshPremiumState();
  document.body.classList.toggle('is-premium', isPremium());
  await applyI18n();

  document.getElementById('muteToggle').addEventListener('click', async () => {
    const status = await send({ type: 'status' });
    if (!status || !status.ok) return;
    const btn = document.getElementById('muteToggle');
    btn.disabled = true;
    await send({ type: 'set-mute-mode', on: !status.scriptMute });
    btn.disabled = false;
    refreshStatus();
  });
  document.getElementById('hideToggle').addEventListener('click', async () => {
    const status = await send({ type: 'status' });
    if (!status || !status.ok) return;
    const btn = document.getElementById('hideToggle');
    btn.disabled = true;
    await send({ type: 'set-hide-mode', on: !status.hideMode });
    btn.disabled = false;
    refreshStatus();
  });

  // Clean sensitive data — fires a one-shot cleanup in the background. Greyed
  // out when nothing is selected to clean (or the user isn't premium) with a
  // hover hint to pick items in Settings.
  const cleanupBtn = document.getElementById('cleanupBtn');
  const cleanupStatus = document.getElementById('cleanupStatus');
  if (cleanupBtn) {
    const cleanupTypes = await getCleanupTypes();
    const noneSelected = !Object.values(cleanupTypes).some(Boolean);
    const premium = isPremium();
    cleanupBtn.disabled = !premium || noneSelected;
    if (cleanupBtn.disabled) {
      cleanupBtn.dataset.tip = t('popupCleanDisabled');
    }
    cleanupBtn.addEventListener('click', async () => {
      if (!cleanupStatus) return;
      cleanupBtn.disabled = true;
      const resp = await send({ type: 'run-cleanup' });
      if (resp && resp.ok) {
        cleanupStatus.textContent = t('popupCleanDone');
      } else if (resp && resp.reason === 'no_keywords') {
        cleanupStatus.textContent = t('popupCleanNoKeywords');
      } else if (resp && resp.reason === 'none_selected') {
        cleanupStatus.textContent = t('popupCleanNothing');
      } else {
        cleanupStatus.textContent = t('popupCleanError');
      }
      cleanupStatus.hidden = false;
      cleanupBtn.disabled = false;
      setTimeout(() => { cleanupStatus.hidden = true; }, 2000);
    });
  }

  document.getElementById('optionsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  await refreshStatus();
});