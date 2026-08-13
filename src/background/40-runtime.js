async function loadRuntimeState() {
  const saved = await store.get([...settingNames, Keys.stats]);
  state.settings = {
    extension_enabled: saved.extension_enabled ?? true,
    blocked_countries: Array.isArray(saved.blocked_countries) ? saved.blocked_countries : [],
    verified_only_mode: saved.verified_only_mode ?? false,
    auto_block_mode: saved.auto_block_mode ?? false,
    always_load_comments: saved.always_load_comments ?? false,
    toast_notifications: saved.toast_notifications ?? true,
    hide_animation: saved.hide_animation ?? true
  };
  state.stats = emptyStats(saved[Keys.stats]);
  note('ready', { settings: state.settings, stats: state.stats });
}

const ready = loadRuntimeState();

function sendAsync(work, sendResponse, fallback) {
  ready.then(work).then(sendResponse).catch(() => sendResponse(fallback));
  return true;
}

const messageHandlers = {
  debugLog(request) {
    recordLog({ source: request.source || 'extension', event: request.event || 'event', details: request.details }).catch(() => {});
    return false;
  },
  checkForUpdates(request, _sender, respond) {
    return sendAsync(() => fetchUpdateStatus(request.force === true), respond, null);
  },
  filteredAccount(request, sender, respond) {
    return xPageSender(sender) && sendAsync(() => rememberFilteredProfile(request), respond, { ok: false });
  },
  setProfileVisibility(request, _sender, respond) {
    return sendAsync(() => setProfileVisibility(request), respond, { ok: false });
  },
  profileRelationship(request, sender, respond) {
    return xPageSender(sender) && sendAsync(() => rememberRelationship(request), respond, { ok: false });
  },
  accountActionResult(request, sender) {
    if (!xPageSender(sender)) return false;
    ready.then(() => Promise.all([recordAccountAction(request), updateActionBudget(request)])).catch(() => {});
    return false;
  },
  reserveAccountAction(request, sender, respond) {
    return xPageSender(sender) && sendAsync(() => reserveAccountAction(request), respond, { allowed: false, reason: 'unavailable', retryAt: Date.now() + Limits.normalActionDelay });
  },
  reserveLookupBudget(request, sender, respond) {
    return xPageSender(sender) && sendAsync(() => reserveLookup(request), respond, { allowed: true, unavailable: true });
  },
  rateLimitStatus(request, sender) {
    if (!xPageSender(sender)) return false;
    ready.then(() => mergeLookupStatus('server', {
      limit: Number.isFinite(request.limit) ? request.limit : undefined,
      remaining: request.rateLimited === true ? 0 : (Number.isFinite(request.remaining) ? request.remaining : undefined),
      reportedRemaining: Number.isFinite(request.reportedRemaining) ? request.reportedRemaining : undefined,
      resetAt: Number.isFinite(request.resetAt) ? request.resetAt : undefined,
      rateLimited: request.rateLimited === true
    })).catch(() => {});
    return false;
  },
  getLookupStatus(_request, _sender, respond) {
    return sendAsync(currentLookupStatus, respond, {});
  },
  claimLookupToast(request, sender, respond) {
    return xPageSender(sender) && sendAsync(() => claimLookupNotice(request), respond, { allowed: false });
  },
  getSettings(_request, _sender, respond) {
    return sendAsync(() => state.settings, respond, null);
  },
  countrySpotted(request, sender) {
    if (!xPageSender(sender)) return false;
    ready.then(() => {
      const country = boundedText(request.country, 100);
      if (!country || ['__proto__', 'prototype', 'constructor'].includes(country)) return;
      state.stats.seenCountries[country] = (state.stats.seenCountries[country] || 0) + 1;
      state.stats.totalScanned += 1;
      const today = dayStamp();
      state.stats.scannedByDay[today] = (state.stats.scannedByDay[today] || 0) + 1;
      state.stats.scannedByDay = recentDays(state.stats.scannedByDay);
      saveStatsSoon();
    });
    return false;
  },
  incrementStat(request, sender) {
    if (!xPageSender(sender)) return false;
    ready.then(() => {
      const today = dayStamp();
      if (request.statType === 'hidden') {
        state.stats.hiddenPosts += 1;
        state.stats.hiddenByDay[today] = (state.stats.hiddenByDay[today] || 0) + 1;
        state.stats.hiddenByDay = recentDays(state.stats.hiddenByDay);
      } else if (request.statType === 'blocked') {
        state.stats.blockedAccounts += 1;
        state.stats.blockedByDay[today] = (state.stats.blockedByDay[today] || 0) + 1;
        state.stats.blockedByDay = recentDays(state.stats.blockedByDay);
      }
      saveStatsSoon();
    });
    return false;
  }
};

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!ownExtensionSender(sender) || !request || typeof request !== 'object') return false;
  const handler = messageHandlers[request.type];
  return typeof handler === 'function' ? Boolean(handler(request, sender, respond)) : false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  ready.then(() => {
    for (const key of settingNames) if (changes[key]) state.settings[key] = changes[key].newValue;
    if (changes[Keys.stats]) state.stats = emptyStats(changes[Keys.stats].newValue);
    if (!settingNames.some(key => changes[key])) return;
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, tabs => {
      for (const tab of tabs) tabApi.sendMessage(tab.id, { type: 'settingsUpdate', settings: state.settings }).catch(() => {});
    });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setIcon({ path: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' } });
  fetchUpdateStatus(true);
});
chrome.runtime.onStartup?.addListener(() => fetchUpdateStatus(true));
fetchUpdateStatus();

chrome.runtime.onSuspend.addListener(() => {
  clearTimeout(state.statsTimer);
  state.statsTimer = null;
  if (state.stats) store.set({ [Keys.stats]: state.stats }).catch(() => {});
});
