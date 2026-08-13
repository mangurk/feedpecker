function cancelRetryTimer(container) {
  const timer = retryTimers.get(container);
  if (timer) clearTimeout(timer);
  retryTimers.delete(container);
}

function scheduleNodeAttempt(container, delayMs = LAZY_DELAY_MS, retry = false) {
  const timers = retry ? retryTimers : lazyTimers;
  if (timers.has(container)) return;
  const timer = setTimeout(() => {
    timers.delete(container);
    if (!enabled || gone() || !document.contains(container) || !visibleElements.has(container)) return;
    const user = findHandle(container);
    if (user) processNode(container, user);
  }, Math.max(0, delayMs));
  timers.set(container, timer);
}

function retryDelayFor(data, attempt) {
  if (data?.paused) {
    const resetAt = Math.max(rateLimitUntil * 1000, lookupBudgetResetAt);
    return Math.max(1_000, resetAt - Date.now() + 350);
  }
  if (data?.failure === 'queue-full') return 750;
  if (data?.failure === 'retry-delay') return TRANSIENT_MISS_TTL + 250;
  return Math.min(10_000, TRANSIENT_MISS_TTL * Math.max(1, attempt));
}

async function processNode(container, screenName) {
  const currentHandle = container.dataset.tfHandle;
  if (currentHandle && currentHandle.toLowerCase() !== screenName.toLowerCase()) {
    // DOM Node Recycled! Clean up previous state to prevent visual leaks
    container.querySelectorAll('.tf-flag').forEach(el => el.remove());
    const article = container.closest('article[data-testid="tweet"]');
    if (article) restoreHiddenArticle(article);
    delete container.dataset.tfDone;
    delete container.dataset.tfRetryCount;
    cancelRetryTimer(container);
  }

  container.dataset.tfHandle = screenName;

  if (container.dataset.tfDone === '1' || container.dataset.tfDone === 'working') return;
  container.dataset.tfDone = 'working';
  const activeProfileHandle = updateProfilePageMode();
  const screenNameKey = screenName.toLowerCase();

  // Explicit Hide overrides do not need location data. Apply them before the
  // lookup pipeline so manually hidden profiles never spend the X quota.
  if (!activeProfileHandle && profileVisibilityOverrides.get(screenNameKey) === 'hide') {
    const article = container.closest('article[data-testid="tweet"]');
    if (article) {
      container.dataset.tfDone = '1';
      hideArticle(article, screenNameKey);
      return;
    }
  }

  try {
    const isStatusPage = window.location.pathname.includes('/status/');
    const isMainAuthor = isStatusPage && window.location.pathname.toLowerCase().startsWith('/' + screenName.toLowerCase() + '/status/');
    const cacheOnly = isStatusPage && !isMainAuthor && !alwaysLoadComments;

    const data = await fetchLocation(screenName, cacheOnly);

    // Ensure the node hasn't been recycled while fetch was in-flight
    if (container.dataset.tfHandle !== screenName) return;

    if (data?.paused || data?.retryable) {
      noteLookupDiagnostic(data.paused ? 'paused' : (data.failure || 'temporary-failure'));
      container.dataset.tfDone = 'retry';
      const attempts = Number.parseInt(container.dataset.tfRetryCount || '0', 10) || 0;
      if (data.paused || attempts < MAX_VISIBLE_RETRIES) {
        if (!data.paused) container.dataset.tfRetryCount = String(attempts + 1);
        scheduleNodeAttempt(container, retryDelayFor(data, attempts + 1), true);
      }
      return;
    }

    delete container.dataset.tfRetryCount;
    cancelRetryTimer(container);

    const loc  = data?.location;
    const ver  = data?.verified ?? false;
    const tz   = data?.timezone ?? null;
    const reg  = data?.isRegion ?? false;
    const profileHandle = updateProfilePageMode();
    const isProfileOwner = Boolean(profileHandle && profileHandle.toLowerCase() === screenName.toLowerCase());
    const resolvedCountry = resolveCountryName(loc) || loc;
    let visibilityOverride = profileVisibilityOverrides.get(screenNameKey);
    const countryFilterMatch = locationMatchesFilter(loc, ver);
    let followingState = typeof data?.following === 'boolean' ? data.following : getFollowingState(screenName);
    if (countryFilterMatch && followingState === null) {
      followingState = await waitForFollowingState(screenName);
    }
    if (countryFilterMatch && followingState === false && visibilityOverride === 'show' && filteredAccounts.get(screenNameKey)?.exclusionReason === 'following') {
      const restored = await restoreAutomaticFollowingExclusion(filteredAccounts.get(screenNameKey), 'feed-detection');
      if (restored) visibilityOverride = undefined;
    }
    const followingAccount = followingState === true;
    if (countryFilterMatch && followingAccount && visibilityOverride !== 'hide' && visibilityOverride !== 'show') {
      const excluded = await excludeFollowedProfile({
        screenName,
        location: loc,
        country: resolvedCountry,
        verified: ver
      }, 'feed-detection');
      if (excluded) visibilityOverride = 'show';
    }
    const doFilter = visibilityOverride === 'hide' || (visibilityOverride !== 'show' && countryFilterMatch);
    if (doFilter) scheduleProfileControlScan(0);

    if (isProfileOwner && countryFilterMatch && visibilityOverride !== 'show') {
      const noticeKey = `${profileHandle.toLowerCase()}:${loc.toLowerCase()}`;
      if (profileNoticeKey !== noticeKey) {
        profileNoticeKey = noticeKey;
        showWarningToast('This profile matches your blocked-country filter. Its timeline remains visible while you browse the profile.', 'warning', 'profile-filter');
        debugLog('profile-filter-notice', { screenName, location: loc });
      }
    }

    // Blocked-region filter
    if (!profileHandle && doFilter) {
        const article = container.closest('article[data-testid="tweet"]');
        if (article) {
          recordFilteredAccount(screenName, loc, resolvedCountry, ver, false, followingState);
          container.dataset.tfDone = '1';
          hideArticle(article, screenNameKey);
          if (autoFilter && !followingAccount) {
            const knownAccount = filteredAccounts.get(screenNameKey);
            if (knownAccount?.blocked !== true) {
              enqueueAccountAction(screenName, 'block', 'auto', {
                country: resolvedCountry,
                flag: getCountryFlag(resolvedCountry)
              });
            }
          }
          return;
        }
    }

    const flagCode = getCountryFlag(loc);
    const regional = isRegionalAggregate(loc) || (reg && !flagCode);
    if (!flagCode && !regional) {
      noteLookupDiagnostic(loc ? 'unsupported-location' : (data?.cacheOnlyMiss ? 'cache-only-miss' : 'confirmed-no-location'));
      container.dataset.tfDone = 'miss';
      return;
    }

    // Track country for dashboard
    try {
      const cName = resolveCountryName(loc) || (regional ? loc : null);
      if (cName) spotCountry(cName, flagCode || '');
    } catch (_) {}

    const nameWrap = container.querySelector('[data-testid="User-Name"]');
    const existingBadge = nameWrap?.querySelector('.tf-flag');
    if (!nameWrap || existingBadge) {
      if (existingBadge) syncExcludedFlagMarker(existingBadge, visibilityOverride === 'show');
      container.dataset.tfDone = '1';
      return;
    }

    const badge = document.createElement('span');
    badge.className = 'tf-flag';
    badge.setAttribute('data-tf-tip', loc);

    const flag = regional
      ? createRegionalAggregateIcon(`${loc} regional aggregate`)
      : document.createElement('img');
    if (regional) {
      flag.classList.add('tf-region-glyph');
    } else {
      flag.className = 'tf-flag-image';
      flag.src = getFlagAssetUrl(flagCode);
      flag.alt = '';
      flag.setAttribute('aria-hidden', 'true');
      flag.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'tf-flag-emoji';
        fallback.textContent = getCountryFlagEmoji(loc);
        fallback.setAttribute('aria-hidden', 'true');
        flag.replaceWith(fallback);
        debugLog('flag-asset-fallback', { screenName, location: loc, flagCode });
      }, { once: true });
    }
    badge.appendChild(flag);
    syncExcludedFlagMarker(badge, visibilityOverride === 'show');

    if (tz) {
      badge.dataset.tfLocation = loc;
      badge.dataset.tfTz = tz;
    }

    if (reg) {
      badge.dataset.tfApproximate = 'true';
    }

    // Find insertion point — next to the @handle (as a sibling to the handle container to prevent truncation)
    let anchor = null;
    const handle = `@${screenName.toLowerCase()}`;
    for (const leaf of nameWrap.querySelectorAll('*')) {
      if (leaf.children.length === 0 && leaf.textContent.toLowerCase().includes(handle)) {
        let curr = leaf;
        while (curr && curr.parentElement && curr.parentElement !== nameWrap) {
          curr = curr.parentElement;
        }
        if (curr && curr.parentElement === nameWrap) {
          anchor = curr;
        } else {
          anchor = leaf.parentElement || nameWrap;
        }
        break;
      }
    }
    if (anchor && anchor !== nameWrap && anchor.parentElement === nameWrap) {
      anchor.insertAdjacentElement('afterend', badge);
    } else {
      (anchor || nameWrap).appendChild(badge);
    }
    debugLog('flag-rendered', { screenName, location: loc, renderer: regional ? 'region' : 'svg' });
    container.dataset.tfDone = '1';
  } catch (error) {
    noteLookupDiagnostic('process-error');
    debugLog('process-error', { message: String(error?.message || error).slice(0, 240) });
    container.dataset.tfDone = 'retry';
    const attempts = Number.parseInt(container.dataset.tfRetryCount || '0', 10) || 0;
    if (attempts < MAX_VISIBLE_RETRIES) {
      container.dataset.tfRetryCount = String(attempts + 1);
      scheduleNodeAttempt(container, TRANSIENT_MISS_TTL * (attempts + 1), true);
    }
  }
}
