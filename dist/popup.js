const TOGGLE_KEY = 'extension_enabled';
const BLOCKED_COUNTRIES_KEY = 'blocked_countries';
const VERIFIED_ONLY_KEY = 'verified_only_mode';
const AUTO_BLOCK_KEY = 'auto_block_mode';
const ALWAYS_LOAD_COMMENTS_KEY = 'always_load_comments';
const TOAST_NOTIFICATIONS_KEY = 'toast_notifications';
const HIDE_ANIMATION_KEY = 'hide_animation';
const STATS_KEY = 'extension_stats';
const LOOKUP_STATUS_KEY = 'lookup_status';
const extensionTabs = globalThis.feedpeckerWebExt.tabs;

let els = {};
let blockedCountries = [];
let lastStatus = null;

function debugLog(event, details) {
  console.info('[Feedpecker][popup]', event, details ?? '');
  try {
    const result = chrome.runtime.sendMessage({ type: 'debugLog', source: 'popup', event, details });
    result?.catch?.(() => {});
  } catch (_) {}
}

function isXTab(tab) {
  return Boolean(tab?.url && (tab.url.startsWith('https://x.com/') || tab.url.startsWith('https://twitter.com/')));
}

function sendToActiveXTab(message, onResult) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (isXTab(tab)) {
      debugLog('send-to-feed', message.type);
      extensionTabs.sendMessage(tab.id, message)
        .then(response => onResult?.(response))
        .catch(error => {
          debugLog('send-failed', error?.message || error);
          onResult?.({ ok: false, error: 'content-script-unavailable' });
        });
    } else {
      debugLog('feed-not-active', tab?.url || 'no active tab');
      onResult?.({ ok: false, error: 'open-x-tab' });
    }
  });
}

function setSwitch(element, enabled) {
  element.classList.toggle('enabled', enabled);
  element.setAttribute('aria-checked', String(enabled));
}

function updateStatusUI(type, resetTime = 0) {
  els.status.className = 'lookup-status';
  const text = els.status.querySelector('.status-text');
  let message = 'Checking X status';

  if (type === 'good') {
    els.status.classList.add('green');
    message = 'X lookup ready';
  } else if (type === 'limited') {
    els.status.classList.add('red');
    const minutes = Math.max(1, Math.ceil((resetTime - Date.now() / 1000) / 60));
    message = `X lookup paused · ${minutes}m remaining`;
  } else if (type === 'cooldown') {
    els.status.classList.add('amber');
    const minutes = Math.max(1, Math.ceil((resetTime - Date.now() / 1000) / 60));
    message = `Lookup safety cooldown · ${minutes}m remaining`;
  } else if (type === 'inactive') {
    message = 'Open X to activate lookups';
  }
  text.textContent = message;
  els.status.title = message;
  els.status.setAttribute('aria-label', message);

  const statusKey = `${type}:${resetTime}`;
  if (statusKey !== lastStatus) {
    lastStatus = statusKey;
    debugLog('status', { type, resetTime });
  }
}

function checkRateLimitStatus() {
  updateStatusUI('checking');
  chrome.runtime.sendMessage({ type: 'getLookupStatus' }, status => {
    if (chrome.runtime.lastError) status = {};
    renderQuotaMeter(status);
    const now = Date.now();
    const serverPaused = status?.server?.rateLimited === true && status.server.resetAt > now;
    const safetyReserve = status?.server?.rateLimited !== true
      && status?.server?.remaining <= 3
      && status?.server?.resetAt > now;
    const fallbackPaused = status?.local?.reason === 'fallback-reserve' && status.local.resetAt > now;
    const resetAt = Math.max(
      serverPaused || safetyReserve ? status.server.resetAt : 0,
      fallbackPaused ? status.local.resetAt : 0
    );
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, tabs => {
      if (serverPaused) updateStatusUI('limited', Math.ceil(resetAt / 1000));
      else if (safetyReserve || fallbackPaused) updateStatusUI('cooldown', Math.ceil(resetAt / 1000));
      else updateStatusUI(tabs.length ? 'good' : 'inactive');
    });
  });
}

function formatQuotaReset(resetAt) {
  if (!resetAt) return 'Reset time unavailable';
  const remainingMs = resetAt - Date.now();
  if (remainingMs <= 0) return 'Resetting now';
  const minutes = Math.ceil(remainingMs / 60_000);
  return `resets in ${minutes}m`;
}

function renderQuotaMeter(status) {
  if (!els.quotaMeter) return;
  const server = status?.server;
  const fallbackPaused = status?.local?.reason === 'fallback-reserve' && status.local.resetAt > Date.now();
  const resetAt = fallbackPaused ? Math.max(server?.resetAt || 0, status.local.resetAt) : server?.resetAt;
  const paused = server?.rateLimited === true;
  const hasServerQuota = server?.limit > 0 && server?.remaining >= 0;
  if (!resetAt || resetAt <= Date.now() || (!paused && !hasServerQuota && !fallbackPaused)) {
    els.quotaMeter.hidden = false;
    els.quotaMeter.classList.add('idle');
    els.quotaMeter.classList.remove('critical', 'paused');
    els.quotaMeterLabel.textContent = 'Ready for X lookups';
    els.quotaMeterReset.textContent = 'Window starts on first lookup';
    els.quotaMeterFill.style.width = '0%';
    return;
  }

  const limit = hasServerQuota
    ? server.limit
    : (status?.local?.limit > 0 ? status.local.limit : (server?.limit > 0 ? server.limit : 1));
  const remaining = paused ? 0 : Math.max(0, Math.min(limit, hasServerQuota ? server.remaining : status.local.remaining));
  const safetyReserve = !paused && remaining <= 3;
  const percentage = Math.max(0, Math.min(100, (remaining / limit) * 100));
  els.quotaMeter.hidden = false;
  els.quotaMeter.classList.remove('idle');
  els.quotaMeter.classList.toggle('critical', paused);
  els.quotaMeter.classList.toggle('paused', paused);
  els.quotaMeterLabel.textContent = paused
    ? 'Paused by X'
    : safetyReserve
      ? `Safety reserve · ${remaining} of ${limit} held`
      : fallbackPaused
        ? `Safety reserve · ${remaining} of ${limit} held`
        : `${remaining} of ${limit} lookups left`;
  els.quotaMeterReset.textContent = formatQuotaReset(resetAt);
  els.quotaMeterFill.style.width = `${percentage}%`;
}

async function loadQuotaStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'getLookupStatus' }, status => {
      if (chrome.runtime.lastError) renderQuotaMeter(null);
      else renderQuotaMeter(status);
      resolve();
    });
  });
}

function renderBlockedList() {
  const count = blockedCountries.length;
  els.blockedRuleSummary.textContent = count === 0
    ? 'No hidden origins'
    : `${count} hidden ${count === 1 ? 'origin' : 'origins'}`;
  if (count === 0) {
    els.blockedRulePreview.textContent = 'Add countries or regions in the dashboard';
    return;
  }
  const visible = blockedCountries.slice(0, 3);
  const remainder = count - visible.length;
  els.blockedRulePreview.textContent = `${visible.join(' · ')}${remainder > 0 ? ` · +${remainder}` : ''}`;
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderTodayStats(stats = {}) {
  const today = localDayKey();
  els.todayDate.textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  els.scannedToday.textContent = (stats.scannedByDay?.[today] || 0).toLocaleString();
  els.hiddenToday.textContent = (stats.hiddenByDay?.[today] || 0).toLocaleString();
  els.blockedToday.textContent = (stats.blockedByDay?.[today] || 0).toLocaleString();
}

function setStoredToggle(key, element, enabled, message) {
  setSwitch(element, enabled);
  chrome.storage.local.set({ [key]: enabled }, () => {
    if (message) sendToActiveXTab(message);
  });
}

function init() {
  els = {
    status: document.getElementById('apiStatus'),
    quotaMeter: document.getElementById('quotaMeter'),
    quotaMeterLabel: document.getElementById('quotaMeterLabel'),
    quotaMeterReset: document.getElementById('quotaMeterReset'),
    quotaMeterFill: document.getElementById('quotaMeterFill'),
    toggle: document.getElementById('toggleSwitch'),
    blockedRuleSummary: document.getElementById('blockedRuleSummary'),
    blockedRulePreview: document.getElementById('blockedRulePreview'),
    todayDate: document.getElementById('todayDate'),
    scannedToday: document.getElementById('scannedTodayCount'),
    hiddenToday: document.getElementById('hiddenTodayCount'),
    blockedToday: document.getElementById('blockedTodayCount'),
    verifiedOnly: document.getElementById('verifiedOnlyToggle'),
    autoBlock: document.getElementById('autoBlockToggle'),
    alwaysLoadComments: document.getElementById('alwaysLoadCommentsToggle'),
    toastNotifications: document.getElementById('toastNotificationsToggle'),
    hideAnimation: document.getElementById('hideAnimationToggle')
  };

  chrome.storage.local.get([
    TOGGLE_KEY,
    BLOCKED_COUNTRIES_KEY,
    VERIFIED_ONLY_KEY,
    AUTO_BLOCK_KEY,
    ALWAYS_LOAD_COMMENTS_KEY,
    TOAST_NOTIFICATIONS_KEY,
    HIDE_ANIMATION_KEY,
    STATS_KEY
  ], result => {
    const enabled = result[TOGGLE_KEY] !== false;
    blockedCountries = Array.isArray(result[BLOCKED_COUNTRIES_KEY]) ? result[BLOCKED_COUNTRIES_KEY] : [];
    setSwitch(els.toggle, enabled);
    setSwitch(els.verifiedOnly, result[VERIFIED_ONLY_KEY] === true);
    setSwitch(els.autoBlock, result[AUTO_BLOCK_KEY] === true);
    setSwitch(els.alwaysLoadComments, result[ALWAYS_LOAD_COMMENTS_KEY] === true);
    setSwitch(els.toastNotifications, result[TOAST_NOTIFICATIONS_KEY] !== false);
    setSwitch(els.hideAnimation, result[HIDE_ANIMATION_KEY] !== false);
    renderBlockedList();

    const stats = result[STATS_KEY] || {};
    renderTodayStats(stats);
    debugLog('settings-loaded', { enabled, blockedCountries: blockedCountries.length, stats });
  });

  els.toggle.addEventListener('click', () => {
    const enabled = !els.toggle.classList.contains('enabled');
    setStoredToggle(TOGGLE_KEY, els.toggle, enabled, { type: 'extensionToggle', enabled });
  });

  els.verifiedOnly.addEventListener('click', () => {
    const enabled = !els.verifiedOnly.classList.contains('enabled');
    setStoredToggle(VERIFIED_ONLY_KEY, els.verifiedOnly, enabled, { type: 'verifiedOnlyUpdate', enabled });
  });

  els.autoBlock.addEventListener('click', () => {
    const enabled = !els.autoBlock.classList.contains('enabled');
    if (enabled && !window.confirm('Auto-block will block matching accounts on X. Continue?')) return;
    setStoredToggle(AUTO_BLOCK_KEY, els.autoBlock, enabled, { type: 'autoBlockUpdate', enabled });
  });

  els.alwaysLoadComments.addEventListener('click', () => {
    const enabled = !els.alwaysLoadComments.classList.contains('enabled');
    setStoredToggle(ALWAYS_LOAD_COMMENTS_KEY, els.alwaysLoadComments, enabled, { type: 'alwaysLoadCommentsUpdate', enabled });
  });

  els.toastNotifications.addEventListener('click', () => {
    const enabled = !els.toastNotifications.classList.contains('enabled');
    setStoredToggle(TOAST_NOTIFICATIONS_KEY, els.toastNotifications, enabled, { type: 'toastNotificationsUpdate', enabled });
  });

  els.hideAnimation.addEventListener('click', () => {
    const enabled = !els.hideAnimation.classList.contains('enabled');
    setStoredToggle(HIDE_ANIMATION_KEY, els.hideAnimation, enabled, { type: 'hideAnimationUpdate', enabled });
  });

  document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  document.getElementById('manageCountries').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#countries') });
  });

  document.getElementById('openFiltered').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('filtered.html') });
  });

  checkRateLimitStatus();
  loadQuotaStatus();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LOOKUP_STATUS_KEY]) checkRateLimitStatus();
    if (changes[BLOCKED_COUNTRIES_KEY]) {
      blockedCountries = Array.isArray(changes[BLOCKED_COUNTRIES_KEY].newValue)
        ? changes[BLOCKED_COUNTRIES_KEY].newValue
        : [];
      renderBlockedList();
    }
    if (changes[STATS_KEY]) {
      renderTodayStats(changes[STATS_KEY].newValue || {});
    }
    if (changes[TOAST_NOTIFICATIONS_KEY]) {
      setSwitch(els.toastNotifications, changes[TOAST_NOTIFICATIONS_KEY].newValue !== false);
    }
    if (changes[HIDE_ANIMATION_KEY]) {
      setSwitch(els.hideAnimation, changes[HIDE_ANIMATION_KEY].newValue !== false);
    }
  });
  setInterval(() => {
    checkRateLimitStatus();
    loadQuotaStatus();
  }, 15_000);
}

document.addEventListener('DOMContentLoaded', init);
