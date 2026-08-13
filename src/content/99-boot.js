// ─────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────
async function boot() {
  await waitForBody();
  // 1. Settings
  try {
    const cfg = await new Promise(r => {
      if (gone()) return r({});
      chrome.runtime.sendMessage({ type: 'getSettings' }, resp => {
        if (chrome.runtime.lastError) r({}); else r(resp || {});
      });
    });
    enabled      = cfg.extension_enabled ?? true;
    onlyVerified = cfg.verified_only_mode ?? false;
    autoFilter   = cfg.auto_block_mode ?? false;
    alwaysLoadComments = cfg.always_load_comments ?? false;
    toastNotificationsEnabled = cfg.toast_notifications ?? true;
    hideAnimationEnabled = cfg.hide_animation ?? true;
    if (cfg.blocked_countries) parseRegions(cfg.blocked_countries);
    refreshLookupToastSchedule();
  } catch (_) {}

  await refreshFilteredAccounts();

  // 2. Cache
  // Hydration only warms IndexedDB; individual lookups already read cold entries.
  // Do not hold up the observer and first visible flags while scanning the cache.
  hydrate();
  if (!enabled) return;

  // 3. Styles
  if (!document.getElementById('tf-style')) {
    const s = document.createElement('style');
    s.id = 'tf-style';
    s.textContent = `
      .tf-flag { contain: layout style; margin: 0 4px; display: inline-flex; align-items: center; vertical-align: middle; height: 1.2em; gap: 3px; cursor: help; flex-shrink: 0; }
      .tf-flag-image { display: block; width: 1.35em; height: 1.0125em; border-radius: 3px; object-fit: cover; pointer-events: none; }
      .tf-flag-emoji { font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; font-size: 1.15em; line-height: 1; pointer-events: none; }
      .tf-region-glyph { display: inline-grid; width: auto; min-width: 2.25em; height: 1.45em; place-items: center; padding: 0 .32em; border-radius: 3px; background: #faefe2; color: #000; font: 800 .62em/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: .03em; pointer-events: none; }
      .tf-excluded-marker { color: #43d691; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: 0 0 14px; pointer-events: none; }
      .tf-excluded-marker svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
      .tf-filter-profile-btn {
        appearance: none; border: 1px solid rgba(250, 239, 226, .28); border-radius: 999px;
        background: #000; color: #faefe2; padding: 8px 14px;
        font: 700 13px/1.15 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        display: inline-flex; align-items: center; justify-content: center; text-align: center;
        white-space: nowrap; cursor: pointer; transition: background .16s ease, border-color .16s ease, color .16s ease;
      }
      .tf-filter-profile-btn:hover:not(:disabled) { background: #000; border-color: #faefe2; color: #faefe2; }
      .tf-filter-profile-btn:focus-visible { outline: 2px solid #ff3d57; outline-offset: 2px; }
      .tf-profile-action-group { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 8px; }
      .tf-filter-profile-btn--profile { min-width: 68px; min-height: 36px; padding: 0 16px; }
      .tf-filter-profile-slot { padding: 12px 16px 16px; }
      .tf-filter-profile-slot--after-summary { margin-top: -2px; padding-top: 0; }
      .tf-filter-profile-btn--hover { width: 100%; padding: 10px 14px; }
      .tf-filter-profile-btn.is-filtered { border-color: #5c0e17; background: #000; color: #ef233c; }
      .tf-filter-profile-btn.is-filtered:hover:not(:disabled) { background: #000; border-color: #ef233c; color: #ef233c; }
      .tf-filter-profile-btn.is-excluded { border-color: rgba(200, 155, 82, .72); background: rgba(200, 155, 82, .14); color: #e0b66e; }
      .tf-filter-profile-btn.is-excluded:hover:not(:disabled) { border-color: #e0b66e; background: rgba(200, 155, 82, .2); color: #f2c978; }
      .tf-hide-sparks { position: relative; z-index: 2147483646; left: 50%; display: block; width: 0; height: 0; pointer-events: none; transform-origin: center; }
      .tf-hide-sparks--fixed { position: fixed; left: 0; width: 0; height: 0; overflow: visible !important; }
      .tf-smash-spark { position: absolute; top: 50%; left: 50%; width: 18px; height: 2px; border-radius: 99px; background: linear-gradient(90deg, #fff, #ffd4dc 30%, #ff4869 68%, transparent); box-shadow: 0 0 8px rgba(255,76,108,.95); transform-origin: left center; }
      .tf-smash-spark:nth-of-type(3n) { width: 9px; }
      .tf-smash-spark:nth-of-type(2n) { width: 21px; }
      .tf-smash-debris { position: absolute; top: 50%; left: 50%; width: 9px; height: 7px; border: 1px solid #aa4157; border-radius: 2px; background: linear-gradient(135deg, #502c35, #151013); box-shadow: 0 0 7px rgba(255,53,91,.34), 0 2px 5px rgba(0,0,0,.6); }
      .tf-smash-debris:nth-of-type(2n) { width: 6px; height: 10px; border-color: #74303f; background: #2b191e; }
      .tf-smash-wave { position: absolute; top: 0; left: 0; height: 1px; pointer-events: none; transform-origin: center; }
      .tf-smash-wave--glow { background: rgba(255,48,91,.72); box-shadow: 0 0 5px rgba(255,45,88,.86), 0 0 12px rgba(255,35,82,.44); }
      .tf-smash-wave--core { background: linear-gradient(90deg, rgba(255,255,255,0), #ffdbe2 12%, #fff 50%, #ffdbe2 88%, rgba(255,255,255,0)); box-shadow: 0 0 3px rgba(255,255,255,.72); }
      .tf-smash-bird { position: absolute; top: 0; left: 0; width: 96px; height: 89px; overflow: hidden; pointer-events: none; filter: drop-shadow(2px 3px 0 rgba(0,0,0,.76)); }
      .tf-smash-bird-sprite { position: absolute; inset: 0 auto 0 0; width: 300%; height: 100%; background-repeat: no-repeat; background-position: 0 0; background-size: 100% 100%; image-rendering: pixelated; will-change: transform; }
      .tf-filter-profile-btn:disabled { opacity: .68; cursor: wait; }
      #tf-tooltip {
        position: fixed; z-index: 100000;
        background: #faefe2; color: #000;
        border: 1px solid #000;
        padding: 8px 10px; border-radius: 3px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px; font-weight: 600;
        letter-spacing: -0.1px;
        pointer-events: none;
        box-shadow: none;
        opacity: 0; transition: opacity 0.15s;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // 4. Keep profile-page mode current and sweep expired negative results.
  updateProfilePageMode();
  scheduleProfileControlScan(0);
  setInterval(updateProfilePageMode, 750);
  setInterval(() => {
    if (document.hidden) return;
    // Sweep expired negative-cache entries and enforce cap
    const now = Date.now();
    for (const [k, exp] of negativeMap) { if (exp <= now) negativeMap.delete(k); }
    if (negativeMap.size > NEGATIVE_MAP_CAP) {
      let drop = negativeMap.size - Math.floor(NEGATIVE_MAP_CAP / 2);
      for (const k of negativeMap.keys()) { if (drop-- <= 0) break; negativeMap.delete(k); }
    }
  }, CLOCK_TICK_MS);

  // 5. The page-context adapter is injected by manifest.json in the MAIN world.

  // 6. Delegated tooltip
  attachTooltip();

  // 8. Targeted MutationObserver — addedNodes only, micro-batched
  let pending = new Set();
  let drainTimer = null;
  const IGNORED_TAGS = new Set(['IMG', 'SPAN', 'SVG', 'PATH', 'BUTTON', 'CANVAS', 'STYLE', 'SCRIPT', 'LINK', 'BR', 'HR', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'A', 'I', 'B', 'EM', 'STRONG', 'LABEL']);
  const flush = () => {
    if (pending.size === 0) return;
    const nodes = Array.from(pending);
    pending = new Set();
    for (const n of nodes) trackElement(n);
  };
  const scheduleFlush = () => { if (!drainTimer) drainTimer = setTimeout(() => { drainTimer = null; flush(); }, DRAIN_INTERVAL); };

  watcherRef = new MutationObserver(mutations => {
    if (!enabled) return;
    for (const mu of mutations) {
      for (const node of mu.removedNodes) {
        if (node.nodeType !== 1) continue;
        const tracked = [];
        if (node.dataset?.tfWatch) tracked.push(node);
        if (node.querySelectorAll) tracked.push(...node.querySelectorAll('[data-tf-watch]'));
        for (const element of tracked) {
          const timer = lazyTimers.get(element);
          if (timer) clearTimeout(timer);
          lazyTimers.delete(element);
          cancelRetryTimer(element);
          visibleElements.delete(element);
          viewport.unobserve(element);
          const pendingArticle = element.matches?.('article[data-testid="tweet"]')
            ? element
            : element.closest?.('article[data-testid="tweet"]');
          if (pendingArticle) cancelPendingArticleHide(pendingArticle);
          watched.delete(element);
          delete element.dataset.tfWatch;
        }
      }
      for (const node of mu.addedNodes) {
        if (node.nodeType !== 1) continue;

        // Fast test-id pre-filter: Skip subtree query if no data-testid attributes exist anywhere in the hierarchy
        const hasTestId = node.hasAttribute('data-testid') || (node.querySelector && node.querySelector('[data-testid]'));
        if (!hasTestId) continue;

        const touchesProfileControls = node.matches?.('[data-testid*="hovercard" i], [data-testid="primaryColumn"], [data-testid="UserName"], [data-testid$="-follow"], [data-testid$="-unfollow"], [role="dialog"]') ||
          node.querySelector?.('[data-testid*="hovercard" i], [data-testid="primaryColumn"], [data-testid="UserName"], [data-testid$="-follow"], [data-testid$="-unfollow"], [role="dialog"]');
        if (touchesProfileControls) scheduleProfileControlScan();

        // X recycles an on-screen article by replacing its identity subtree.
        // IntersectionObserver does not fire again when the same article node
        // stays visible, so explicitly reconcile it when a new User-Name lands.
        const touchesIdentity = node.matches?.('[data-testid="User-Name"], [data-testid="User-Names"]') ||
          node.querySelector?.('[data-testid="User-Name"], [data-testid="User-Names"]');
        if (touchesIdentity) {
          const trackedParent = node.closest?.('article[data-testid="tweet"][data-tf-watch], [data-testid="UserCell"][data-tf-watch]');
          if (trackedParent && visibleElements.has(trackedParent)) scheduleNodeAttempt(trackedParent, DRAIN_INTERVAL);
        }

        if (node.matches?.(ELEMENT_SELECTORS) && !node.dataset.tfWatch) pending.add(node);
        if (!IGNORED_TAGS.has(node.tagName) && node.querySelectorAll) {
          for (const c of node.querySelectorAll(ELEMENT_SELECTORS)) {
            if (!c.dataset.tfWatch) pending.add(c);
          }
        }
      }
    }
    if (pending.size > 0) scheduleFlush();
  });
  watcherRef.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[FILTERED_ACCOUNTS_KEY] && !changes[PROFILE_VISIBILITY_OVERRIDES_KEY] && !changes[BLOCKED_COUNTRIES_KEY])) return;
    if (changes[FILTERED_ACCOUNTS_KEY]) filteredAccounts = parseFilteredAccounts(changes[FILTERED_ACCOUNTS_KEY].newValue);
    if (changes[PROFILE_VISIBILITY_OVERRIDES_KEY]) {
      profileVisibilityOverrides = parseProfileVisibilityOverrides(changes[PROFILE_VISIBILITY_OVERRIDES_KEY].newValue);
      reprocessVisibleElements();
    }
    if (changes[BLOCKED_COUNTRIES_KEY]) {
      parseRegions(changes[BLOCKED_COUNTRIES_KEY].newValue || []);
      reprocessVisibleElements();
      resetProfileControls();
    }
    updateManualFilterButtonStates();
    scheduleProfileControlScan(0);
  });

  // 9. Passive data from pageScript.js over the private MessageChannel.
  const handlePageData = data => {
    if (data?.type === '__debugLog') {
      try {
        const result = chrome.runtime.sendMessage({ type: 'debugLog', source: data.source || 'page', event: data.event || 'event', details: data.details });
        result?.catch?.(() => {});
      } catch (_) {}
      return;
    }
    if (data?.type === '__accountActionResult') {
      finishAccountAction(data);
      return;
    }
    if (data?.type === '__passiveData' && Array.isArray(data.users)) {
      for (const u of data.users.slice(0, 500)) {
        rememberFollowingState(u?.screen_name, u?.following);
        // A timeline response may expose verification without exposing the
        // About Account location. Do not turn that partial response into a
        // persistent "no location" result that suppresses the real lookup.
        if (u?.screen_name && u.location) {
          record(u.screen_name, u.location, u.verified, null, u.is_region);
        }
      }
      return;
    }
    if (data?.type === '__rateLimitInfo') {
      const limit = Number.isFinite(data.limit) ? data.limit : null;
      const remaining = Number.isFinite(data.remaining) ? data.remaining : null;
      const resetAt = Number.isFinite(data.resetTime) ? data.resetTime * 1000 : null;
      if ((data.rateLimited === true || (remaining !== null && remaining <= LOOKUP_TOAST_THRESHOLD)) && resetAt) {
        if (data.rateLimited !== true && limit !== null && remaining !== null) {
          showThrottleToast(limit, remaining, resetAt);
        }
        scheduleLookupResetToast(resetAt);
      }
      if (limit !== null && remaining !== null) {
        try {
          const result = chrome.runtime.sendMessage({
            type: 'rateLimitStatus',
            limit,
            remaining: data.rateLimited === true ? 0 : remaining,
            reportedRemaining: remaining,
            resetAt,
            rateLimited: data.rateLimited === true
          });
          result?.catch?.(() => {});
        } catch (_) {}
      }
      if (data.rateLimited) {
        rateLimitUntil = Math.max(rateLimitUntil, Number.isFinite(data.resetTime) ? data.resetTime : Math.floor(Date.now() / 1000) + 60);
        debugLog('rate-limit', {
          resetTime: rateLimitUntil,
          queueLength: twitterPending.length,
          limit,
          reportedRemaining: remaining
        });
        cancelPendingTwitterLookups('rate-limit');
        try {
          const result = chrome.runtime.sendMessage({
            type: 'rateLimitStatus',
            limit: limit ?? undefined,
            remaining: 0,
            reportedRemaining: remaining ?? undefined,
            resetAt: rateLimitUntil * 1000,
            rateLimited: true
          });
          result?.catch?.(() => {});
        } catch (_) {}
      }
    }
  };
  pageBridgeListeners.add(handlePageData);

  // 10. Chrome runtime messages
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender?.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
    if (msg.type === 'extensionToggle') {
      enabled = msg.enabled;
      if (enabled) {
        setTimeout(initialSweep, 500);
        scheduleProfileControlScan(0);
        if (watcherRef) watcherRef.observe(document.body, { childList: true, subtree: true });
      } else {
        dropQueuedAutoActions('extension-disabled');
        document.querySelectorAll('.tf-flag').forEach(f => f.remove());
        removeProfileActionGroups();
        document.querySelectorAll('.tf-filter-profile-btn, .tf-filter-profile-slot').forEach(node => node.remove());
        clearHiddenArticles();
        viewport.disconnect();
        visibleElements.clear();
        watched = new WeakSet();
        document.querySelectorAll('[data-tf-watch]').forEach(el => {
          const lazyTimer = lazyTimers.get(el);
          if (lazyTimer) clearTimeout(lazyTimer);
          lazyTimers.delete(el);
          cancelRetryTimer(el);
          delete el.dataset.tfWatch;
          delete el.dataset.tfDone;
          delete el.dataset.tfHandle;
          delete el.dataset.tfRetryCount;
        });
        if (watcherRef) watcherRef.disconnect();
      }
    } else if (msg.type === 'settingsUpdate') {
      const s = msg.settings;
      enabled      = s.extension_enabled ?? enabled;
      onlyVerified = s.verified_only_mode ?? onlyVerified;
      autoFilter   = s.auto_block_mode ?? autoFilter;
      if (!enabled || !autoFilter) dropQueuedAutoActions(!enabled ? 'extension-disabled' : 'auto-block-disabled');
      alwaysLoadComments = s.always_load_comments ?? alwaysLoadComments;
      toastNotificationsEnabled = s.toast_notifications ?? toastNotificationsEnabled;
      hideAnimationEnabled = s.hide_animation ?? hideAnimationEnabled;
      if (!hideAnimationEnabled) flushPendingArticleHides();
      if (toastNotificationsEnabled) refreshLookupToastSchedule();
      else {
        hideWarningToast();
        clearTimeout(lookupResetToastTimer);
        lookupResetToastTimer = null;
      }
      if (s.blocked_countries) {
        parseRegions(s.blocked_countries);
        reprocessVisibleElements();
        resetProfileControls();
      }
    } else if (msg.type === 'alwaysLoadCommentsUpdate') {
      alwaysLoadComments = msg.enabled;
    } else if (msg.type === 'toastNotificationsUpdate') {
      toastNotificationsEnabled = msg.enabled !== false;
      if (toastNotificationsEnabled) refreshLookupToastSchedule();
      else {
        hideWarningToast();
        clearTimeout(lookupResetToastTimer);
        lookupResetToastTimer = null;
      }
    } else if (msg.type === 'hideAnimationUpdate') {
      hideAnimationEnabled = msg.enabled !== false;
      if (!hideAnimationEnabled) flushPendingArticleHides();
    } else if (msg.type === 'blockedCountriesUpdate') {
      parseRegions(msg.countries);
      reprocessVisibleElements();
    } else if (msg.type === 'verifiedOnlyUpdate') {
      onlyVerified = msg.enabled;
      reprocessVisibleElements();
    } else if (msg.type === 'autoBlockUpdate') {
      autoFilter = msg.enabled;
      if (!autoFilter) dropQueuedAutoActions('auto-block-disabled');
    } else if (msg.type === 'accountAction') {
      const screenName = cleanScreenName(msg.screenName);
      if (!screenName) {
        respond({ queued: false, error: 'invalid-screen-name' });
        return false;
      }
      respond(enqueueAccountAction(screenName, msg.action, 'manual'));
      return false;
    } else if (msg.type === 'getStatus') {
      const now = Math.floor(Date.now() / 1000);
      const localReset = Math.ceil(lookupBudgetResetAt / 1000);
      respond({ rateLimited: rateLimitUntil > now || lookupBudgetResetAt > Date.now(), resetTime: Math.max(rateLimitUntil, localReset), queueLength: twitterPending.length });
    } else if (msg.type === 'cacheCleared') {
      dataMap.clear();
      negativeMap.clear();
      dbClear();
      initialSweep();
    } else if (msg.type === 'exportLocationCache') {
      dbExportAll()
        .then(entries => respond({ ok: true, entries }))
        .catch(error => respond({ ok: false, error: error?.message || String(error) }));
      return true;
    } else if (msg.type === 'importLocationCache') {
      dbReplaceAll(msg.entries)
        .then(count => {
          initialSweep();
          respond({ ok: true, count });
        })
        .catch(error => respond({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  // 11. Initial sweep
  initialSweep();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
