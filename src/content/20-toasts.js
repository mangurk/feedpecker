function noteLookupDiagnostic(reason) {
  const key = String(reason || 'unknown').slice(0, 80);
  lookupDiagnosticCounts.set(key, (lookupDiagnosticCounts.get(key) || 0) + 1);
  if (lookupDiagnosticTimer) return;
  lookupDiagnosticTimer = setTimeout(() => {
    lookupDiagnosticTimer = null;
    const outcomes = Object.fromEntries(lookupDiagnosticCounts);
    lookupDiagnosticCounts.clear();
    debugLog('lookup-outcomes', outcomes);
  }, LOOKUP_DIAGNOSTIC_FLUSH_MS);
}

function toastIsVisible(toast) {
  return Boolean(toast?.isConnected && toast.style.visibility !== 'hidden' && toast.style.pointerEvents !== 'none' && toast.style.opacity !== '0');
}

function toastEventDetails(toast, extra = {}) {
  return {
    kind: toast?.dataset.toastKind || 'unknown',
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    ageMs: warningToastShownAt ? Math.max(0, Date.now() - warningToastShownAt) : 0,
    ...extra
  };
}

function dismissWarningToast(toast, reason = 'dismissed') {
  const wasVisible = toastIsVisible(toast);
  clearTimeout(warningToastTimer);
  warningToastTimer = null;
  toast.style.animation = 'none';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(-8px)';
  toast.style.pointerEvents = 'none';
  toast.style.visibility = 'hidden';
  if (wasVisible) debugLog('toast-dismissed', toastEventDetails(toast, { reason }));
}

function scheduleWarningToastDismiss(toast, delay = TOAST_VISIBLE_MS) {
  clearTimeout(warningToastTimer);
  warningToastTimer = setTimeout(() => {
    // Read the element's real hover state instead of relying on mouseleave.
    // X can replace DOM beneath the pointer, and extension reloads can leave
    // stale event state behind. Rechecking guarantees eventual dismissal.
    if (toast.matches(':hover')) {
      debugLog('toast-dismiss-deferred', toastEventDetails(toast, { reason: 'hovered' }));
      scheduleWarningToastDismiss(toast, TOAST_LEAVE_GRACE_MS);
      return;
    }
    dismissWarningToast(toast, 'timer');
  }, delay);
}

function ensureWarningToastStyles() {
  if (document.getElementById('tf-lookup-toast-style')) return;
  const style = document.createElement('style');
  style.id = 'tf-lookup-toast-style';
  style.textContent = `
    @keyframes tf-lookup-toast-expire {
      0%, 92% { opacity: 1; transform: translateY(0); visibility: visible; pointer-events: auto; }
      100% { opacity: 0; transform: translateY(-8px); visibility: hidden; pointer-events: none; }
    }
    #tf-lookup-toast:hover { animation-play-state: paused !important; }
    #tf-lookup-toast .tf-toast-message { flex: 1; min-width: 0; }
    #tf-lookup-toast .tf-toast-close {
      appearance: none; display: grid; place-items: center; width: 24px; height: 24px; flex: 0 0 24px;
      margin: -2px -3px -2px 0; padding: 0; border: 0; border-radius: 3px;
      background: transparent; color: currentColor; font: 500 20px/1 system-ui, sans-serif; cursor: pointer; opacity: .72;
    }
    #tf-lookup-toast .tf-toast-close:hover { background: #111; color: #ef233c; opacity: 1; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function showWarningToast(message, tone = 'warning', kind = 'notice') {
  if (gone() || !toastNotificationsEnabled) return;
  if (document.visibilityState !== 'visible') {
    debugLog('toast-skipped-hidden', { kind, visibility: document.visibilityState });
    return;
  }
  ensureWarningToastStyles();
  let toast = document.getElementById('tf-lookup-toast');
  // A content-script reload can leave the old toast node in the page while
  // its event handlers belong to a dead extension instance. Replace it so
  // every visible toast is controlled by this instance.
  if (toast && toast !== warningToastElement) {
    toast.remove();
    toast = null;
  }
  if (!toast) {
    toast = document.createElement('div');
    warningToastElement = toast;
    toast.id = 'tf-lookup-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = 'position:fixed;z-index:2147483647;top:18px;right:18px;display:flex;align-items:flex-start;gap:12px;max-width:360px;padding:12px 12px 12px 15px;border:1px solid rgba(250,239,226,.24);border-radius:3px;color:#faefe2;background:#050505;box-shadow:0 14px 34px rgba(0,0,0,.5);font:600 13px/1.4 system-ui,sans-serif;opacity:0;transform:translateY(-8px);transition:opacity .18s ease,transform .18s ease;pointer-events:none;visibility:hidden';
    toast.addEventListener('animationend', event => {
      if (event.animationName === 'tf-lookup-toast-expire') dismissWarningToast(toast, 'css-animation');
    });
    document.documentElement.appendChild(toast);
  }
  // Assign these on every display so a reused node can never retain stale
  // interaction behavior. Stopping pointerdown also prevents click-through.
  toast.onpointerdown = event => event.stopPropagation();
  toast.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    dismissWarningToast(toast, 'element-click');
  };
  const messageNode = document.createElement('span');
  messageNode.className = 'tf-toast-message';
  messageNode.textContent = message;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'tf-toast-close';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.textContent = '×';
  toast.replaceChildren(messageNode, closeButton);
  toast.dataset.toastKind = kind;
  const isSuccess = tone === 'success';
  toast.style.borderColor = isSuccess ? 'rgba(73,213,160,.45)' : 'rgba(250,239,226,.24)';
  toast.style.color = '#faefe2';
  toast.style.background = '#050505';
  toast.style.pointerEvents = 'auto';
  toast.style.visibility = 'visible';
  toast.style.cursor = 'pointer';
  toast.title = 'Click to dismiss';
  warningToastShownAt = Date.now();
  debugLog('toast-shown', toastEventDetails(toast, { tone }));
  toast.style.animation = 'none';
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    toast.style.animation = `tf-lookup-toast-expire ${TOAST_VISIBLE_MS}ms linear forwards`;
  });
  scheduleWarningToastDismiss(toast);
}

function hideWarningToast() {
  clearTimeout(warningToastTimer);
  warningToastTimer = null;
  const toast = warningToastElement || document.getElementById('tf-lookup-toast');
  if (toast) dismissWarningToast(toast, 'notifications-disabled');
}

// X installs global interaction handlers of its own. Capture clicks before
// the page can consume them so clicking anywhere on the toast always wins.
window.addEventListener('pointerup', event => {
  const toast = warningToastElement;
  if (!toastIsVisible(toast) || !event.composedPath().includes(toast)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  warningToastClickGuardUntil = Date.now() + 400;
  dismissWarningToast(toast, 'captured-pointerup');
}, true);

window.addEventListener('click', event => {
  const toast = warningToastElement;
  const isToastClick = toastIsVisible(toast) && event.composedPath().includes(toast);
  if (!isToastClick && Date.now() >= warningToastClickGuardUntil) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (isToastClick) dismissWarningToast(toast, 'captured-click');
}, true);

document.addEventListener('visibilitychange', () => {
  const toast = warningToastElement;
  if (toastIsVisible(toast)) {
    debugLog('toast-visibility-changed', toastEventDetails(toast));
    if (document.visibilityState === 'visible') {
      const remainingMs = TOAST_VISIBLE_MS - (Date.now() - warningToastShownAt);
      if (remainingMs <= 0) dismissWarningToast(toast, 'expired-in-background');
      else scheduleWarningToastDismiss(toast, remainingMs);
    }
  }
  if (document.visibilityState === 'visible') refreshLookupToastSchedule();
});

function claimLookupToast(kind, resetAt) {
  return new Promise(resolve => {
    if (gone() || !toastNotificationsEnabled) return resolve(false);
    try {
      chrome.runtime.sendMessage({ type: 'claimLookupToast', kind, resetAt }, response => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(response?.allowed === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function showThrottleToast(limit, remaining, resetAt) {
  if (!toastNotificationsEnabled || !Number.isFinite(resetAt) || resetAt <= Date.now()) return;
  if (document.visibilityState !== 'visible') {
    debugLog('toast-skipped-hidden', { kind: 'throttled', visibility: document.visibilityState });
    return;
  }
  if (!await claimLookupToast('throttled', resetAt)) return;
  const used = Math.max(0, limit - remaining);
  const reserveLabel = remaining === 1 ? 'lookup is' : 'lookups are';
  showWarningToast(remaining <= 3
    ? `You've used ${used} of ${limit} location lookups in the current X quota window. The final ${remaining} ${reserveLabel} being kept in reserve, so new location checks are paused until reset.`
    : `You've used ${used} of ${limit} location lookups in the current X quota window. New lookups will be paced until reset.`, 'warning', 'throttled');
}

async function showResetSoonToast(resetAt) {
  lookupResetToastTimer = null;
  if (!toastNotificationsEnabled || !Number.isFinite(resetAt) || resetAt <= Date.now()) return;
  if (document.visibilityState !== 'visible') {
    debugLog('toast-skipped-hidden', { kind: 'reset-soon', visibility: document.visibilityState });
    return;
  }
  if (!await claimLookupToast('reset-soon', resetAt)) return;
  showWarningToast('Your X lookup quota resets in about a minute. Normal lookup speed will resume automatically.', 'success', 'reset-soon');
}

function scheduleLookupResetToast(resetAt) {
  clearTimeout(lookupResetToastTimer);
  lookupResetToastTimer = null;
  if (!toastNotificationsEnabled || !Number.isFinite(resetAt) || resetAt <= Date.now()) return;
  const delay = Math.max(0, resetAt - Date.now() - LOOKUP_RESET_WARNING_MS);
  lookupResetToastTimer = setTimeout(() => showResetSoonToast(resetAt), delay);
}

function updateLookupToastSchedule(status) {
  const server = status?.server;
  const resetAt = Number(server?.resetAt);
  const remaining = Number(server?.remaining);
  const limit = Number(server?.limit);
  const needsProtection = server?.rateLimited === true || (Number.isFinite(remaining) && remaining <= LOOKUP_TOAST_THRESHOLD);
  if (!toastNotificationsEnabled || !needsProtection || !Number.isFinite(resetAt) || resetAt <= Date.now()) {
    clearTimeout(lookupResetToastTimer);
    lookupResetToastTimer = null;
    return;
  }
  if (server?.rateLimited !== true && Number.isFinite(limit) && Number.isFinite(remaining)) {
    showThrottleToast(limit, remaining, resetAt);
  }
  scheduleLookupResetToast(resetAt);
}

function refreshLookupToastSchedule() {
  if (gone() || !toastNotificationsEnabled) return;
  try {
    chrome.runtime.sendMessage({ type: 'getLookupStatus' }, status => {
      if (!chrome.runtime.lastError) updateLookupToastSchedule(status || {});
    });
  } catch (_) {}
}

const extensionStorage = globalThis.feedpeckerWebExt.storage;
const disk = {
  read: async (keys) => gone() ? {} : extensionStorage.get(keys),
  write: async (obj) => { if (!gone()) await extensionStorage.set(obj); }
};
