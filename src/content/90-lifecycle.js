// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
//  Lifecycle — MutationObserver, IntersectionObserver, messages
// ─────────────────────────────────────────────────────────────
function onVisible(entries) {
  for (const e of entries) {
    if (e.isIntersecting) {
      visibleElements.add(e.target);
      // Schedule a lazy fetch — if the user scrolls past within LAZY_DELAY_MS, it's cancelled
      scheduleNodeAttempt(e.target);
    } else {
      visibleElements.delete(e.target);
      // Element left the viewport before the lazy timer fired — cancel
      const tid = lazyTimers.get(e.target);
      if (tid) { clearTimeout(tid); lazyTimers.delete(e.target); }
      cancelRetryTimer(e.target);
      delete e.target.dataset.tfRetryCount;
    }
  }
}

function trackElement(el) {
  const container = el.closest?.('article[data-testid="tweet"]')
    || el.closest?.('[data-testid="UserCell"]')
    || el;
  if (container.dataset.tfWatch) return;
  container.dataset.tfWatch = '1';
  watched.add(container);
  viewport.observe(container);
}

function initialSweep() {
  if (!enabled || gone()) return;
  for (const el of document.querySelectorAll(ELEMENT_SELECTORS)) {
    if (!el.dataset.tfWatch) trackElement(el);
  }
}

function reprocessVisibleElements() {
  clearHiddenArticles();
  for (const element of visibleElements) {
    if (!document.contains(element)) {
      visibleElements.delete(element);
      continue;
    }
    delete element.dataset.tfDone;
    delete element.dataset.tfRetryCount;
    cancelRetryTimer(element);
    scheduleNodeAttempt(element, 0);
  }
  initialSweep();
}

function parseRegions(input) {
  filteredRegions = normalizeOriginRules(input);
}

function waitForBody() {
  if (document.body) return Promise.resolve();

  return new Promise(resolve => {
    const root = document.documentElement || document;
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}

// Stats / tracking helpers
function bumpStat(kind) { if (!gone()) chrome.runtime.sendMessage({ type: 'incrementStat', statType: kind }); }
function spotCountry(name, flag = '') { if (!name || gone()) return; chrome.runtime.sendMessage({ type: 'countrySpotted', country: name, flag }); }
function recordFilteredAccount(screenName, location, country, verified, manual = false, following = null) {
  return new Promise(resolve => {
    if (!screenName || gone()) return resolve(false);
    try {
      chrome.runtime.sendMessage({
        type: 'filteredAccount',
        screenName,
        location,
        country,
        verified: verified === true,
        manual,
        following: typeof following === 'boolean' ? following : undefined
      }, response => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(response?.ok === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function setProfileVisibility(profile, visibility, options = {}) {
  return new Promise(resolve => {
    const screenName = cleanScreenName(profile?.screenName);
    if (!screenName || !['hide', 'show', 'default'].includes(visibility) || gone()) return resolve(false);
    try {
      chrome.runtime.sendMessage({
        type: 'setProfileVisibility',
        visibility,
        screenName,
        location: profile.location,
        country: profile.country,
        verified: profile.verified === true,
        exclusionReason: options.exclusionReason === 'following' ? 'following' : options.exclusionReason === 'manual' ? 'manual' : '',
        following: typeof options.following === 'boolean' ? options.following : undefined
      }, response => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(response?.ok === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}
