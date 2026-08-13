function isProfileHidden(screenName) {
  const handle = cleanScreenName(screenName)?.toLowerCase();
  if (!handle) return false;
  const override = profileVisibilityOverrides.get(handle);
  return override === 'hide' || (override !== 'show' && filteredAccounts.has(handle));
}

function updateManualFilterButton(button) {
  const handle = cleanScreenName(button?.dataset?.tfHandle);
  if (!handle) return;
  const excluded = profileVisibilityOverrides.get(handle.toLowerCase()) === 'show';
  const hidden = isProfileHidden(handle);
  const busy = button.dataset.tfBusy === 'true';
  button.disabled = busy;
  button.setAttribute('aria-disabled', String(busy));
  button.setAttribute('aria-pressed', String(hidden || excluded));
  button.setAttribute('aria-label', hidden
    ? `Unhide @${handle} in the feed`
    : excluded
      ? `Excluded from country filtering. Restore filtering for @${handle}`
      : `Hide @${handle} from the feed`);
  if (busy) return;
  button.textContent = hidden ? 'Unhide' : excluded ? 'Excluded' : 'Hide';
  button.classList.toggle('is-filtered', hidden);
  button.classList.toggle('is-excluded', excluded);
}

function updateManualFilterButtonStates() {
  document.querySelectorAll('.tf-filter-profile-btn').forEach(updateManualFilterButton);
}

function isFollowButton(button) {
  if (!button || button.classList.contains('tf-filter-profile-btn')) return false;
  const testId = String(button.getAttribute('data-testid') || '');
  const label = String(button.getAttribute('aria-label') || '').trim();
  const text = String(button.textContent || '').trim();
  return /(^|-)un?follow$/i.test(testId) ||
    /^(follow(?: back)?|following|requested|unfollow|blocked)$/i.test(label) ||
    /^(follow(?: back)?|following|requested|unfollow|blocked)$/i.test(text);
}

function findFollowButton(scope) {
  if (!scope) return null;
  return Array.from(scope.querySelectorAll('button, [role="button"]')).find(isFollowButton) || null;
}

function findProfileHandleIn(scope) {
  if (!scope) return null;
  for (const link of scope.querySelectorAll('a[href^="/"]')) {
    const href = String(link.getAttribute('href') || '');
    const match = href.match(/^\/([^/?#]+)\/?$/);
    if (!match) continue;
    let decoded = '';
    try { decoded = decodeURIComponent(match[1]); } catch (_) { continue; }
    const handle = cleanScreenName(decoded);
    if (!handle || RESERVED_ROUTES.has(handle.toLowerCase())) continue;
    if (String(scope.textContent || '').toLowerCase().includes(`@${handle.toLowerCase()}`)) return handle;
  }
  const textMatch = String(scope.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
  return textMatch ? cleanScreenName(textMatch[1]) : null;
}

function getHoverCardRoots() {
  const roots = new Set();
  document.querySelectorAll('[data-testid*="hovercard" i]').forEach(node => roots.add(node));
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (dialog.getAttribute('aria-modal') === 'true' || dialog.closest('[data-testid="primaryColumn"]')) continue;
    const rect = dialog.getBoundingClientRect();
    if (rect.width > 0 && rect.width <= 720 && rect.height > 0 && rect.height <= 850 && findFollowButton(dialog) && findProfileHandleIn(dialog)) {
      roots.add(dialog);
    }
  }
  const candidates = Array.from(roots);
  // X can expose one hover card through both an outer dialog and an inner
  // HoverCard node. Keep only the innermost candidate so one card gets one control.
  return candidates.filter(root => !candidates.some(other => other !== root && root.contains(other)));
}

async function getManualFilterProfileData(screenName, cacheOnly = false) {
  const handle = cleanScreenName(screenName);
  if (!handle) return null;
  const key = handle.toLowerCase();
  const saved = filteredAccounts.get(key);
  const savedLocation = String(saved?.location || saved?.country || '');
  if (saved && (cacheOnly || isSupportedOrigin(savedLocation))) {
    const cached = dataMap.get(key);
    return {
      screenName: handle,
      location: String(saved.location || ''),
      country: String(saved.country || saved.location || ''),
      verified: saved.verified === true,
      timezone: cached?.timezone || null,
      isRegion: cached?.isRegion === true
    };
  }

  const data = await fetchLocation(handle, cacheOnly);
  const location = typeof data?.location === 'string' ? data.location : '';
  return {
    screenName: handle,
    location,
    country: resolveCountryName(location) || location,
    verified: data?.verified === true,
    timezone: data?.timezone || null,
    isRegion: data?.isRegion === true,
    paused: data?.paused === true,
    retryable: data?.retryable === true,
    failure: typeof data?.failure === 'string' ? data.failure : ''
  };
}

function scheduleHoverCardFlagRetry(root, profile, attempt) {
  const existing = hoverCardRetryTimers.get(root);
  if (existing) clearTimeout(existing);
  const delay = Math.min(10_000, Math.max(1_000, retryDelayFor(profile, attempt)));
  root.dataset.tfHoverRetryAt = String(Date.now() + delay);
  const timer = setTimeout(() => {
    hoverCardRetryTimers.delete(root);
    if (!document.contains(root) || root.getBoundingClientRect().width <= 0) return;
    delete root.dataset.tfHoverRetryAt;
    scheduleProfileControlScan(0);
  }, delay);
  hoverCardRetryTimers.set(root, timer);
}

function addHoverCardLocationBadge(root, identity, profile) {
  if (!root || !profile) return;
  const excluded = profileVisibilityOverrides.get(profile.screenName.toLowerCase()) === 'show';
  const existingBadge = root.querySelector('.tf-hover-profile-flag') || identity?.querySelector('.tf-flag');
  if (existingBadge) {
    syncExcludedFlagMarker(existingBadge, excluded);
    return;
  }
  const origin = profile.location || profile.country;
  const flagCode = getCountryFlag(origin);
  const regional = isRegionalAggregate(origin) || (profile.isRegion && !flagCode);
  if (!flagCode && !regional) return;

  const badge = document.createElement('span');
  badge.className = 'tf-flag tf-hover-profile-flag';
  badge.setAttribute('data-tf-tip', profile.location || profile.country);
  const flag = regional
    ? createRegionalAggregateIcon(`${origin} regional aggregate`)
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
      fallback.textContent = getCountryFlagEmoji(origin);
      fallback.setAttribute('aria-hidden', 'true');
      flag.replaceWith(fallback);
    }, { once: true });
  }
  badge.appendChild(flag);
  syncExcludedFlagMarker(badge, excluded);
  if (profile.timezone) {
    badge.dataset.tfLocation = profile.location || profile.country;
    badge.dataset.tfTz = profile.timezone;
  }
  if (profile.isRegion) {
    badge.dataset.tfApproximate = 'true';
  }

  const handleText = `@${profile.screenName.toLowerCase()}`;
  const searchRoot = identity || root;
  const leaf = Array.from(searchRoot.querySelectorAll('*'))
    .find(node => node.children.length === 0 && String(node.textContent || '').toLowerCase().includes(handleText));
  const handleLink = Array.from(root.querySelectorAll('a[href^="/"]')).find(link => {
    const href = String(link.getAttribute('href') || '').replace(/\/$/, '').toLowerCase();
    return href === `/${profile.screenName.toLowerCase()}` && String(link.textContent || '').toLowerCase().includes(handleText);
  });
  const anchor = leaf || handleLink;
  if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', badge);
  else (identity || root).appendChild(badge);
}

function createManualFilterButton(profile, context) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tf-filter-profile-btn tf-filter-profile-btn--${context}`;
  button.dataset.tfHandle = profile.screenName.toLowerCase();
  updateManualFilterButton(button);
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    const key = profile.screenName.toLowerCase();
    const currentOverride = profileVisibilityOverrides.get(key);
    const followedExclusion = currentOverride === 'show' && filteredAccounts.get(key)?.following === true;
    const nextVisibility = isProfileHidden(key)
      ? 'show'
      : currentOverride === 'show'
        ? (followedExclusion ? 'hide' : 'default')
        : 'hide';
    button.dataset.tfBusy = 'true';
    button.disabled = true;
    button.textContent = nextVisibility === 'show' ? 'Unhiding…' : nextVisibility === 'default' ? 'Restoring…' : 'Hiding…';
    const updated = await setProfileVisibility(profile, nextVisibility, {
      exclusionReason: nextVisibility === 'show' ? 'manual' : '',
      following: getFollowingState(profile.screenName)
    });
    delete button.dataset.tfBusy;
    if (updated) {
      if (nextVisibility === 'default') profileVisibilityOverrides.delete(key);
      else profileVisibilityOverrides.set(key, nextVisibility);
      filteredAccounts.set(key, { ...profile, lastSeen: Date.now(), blocked: filteredAccounts.get(key)?.blocked === true });
      if (nextVisibility === 'show') {
        clearHiddenArticlesForHandle(key);
      }
      updateManualFilterButtonStates();
      debugLog('profile-visibility-override', { screenName: profile.screenName, visibility: nextVisibility, context });
    } else {
      button.disabled = false;
      button.textContent = 'Try again';
      setTimeout(() => {
        if (document.contains(button)) updateManualFilterButton(button);
      }, 2500);
    }
  });
  return button;
}

async function ensureProfilePageControl() {
  const handle = getProfilePageHandle();
  if (!handle) return;
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return;
  const existing = primary.querySelector('.tf-filter-profile-btn--profile');
  if (existing) {
    if (existing.dataset.tfHandle === handle.toLowerCase()) updateManualFilterButton(existing);
    else existing.remove();
    if (existing.dataset.tfHandle === handle.toLowerCase()) return;
  }
  const identity = primary.querySelector('[data-testid="UserName"]');
  if (!identity) return;
  const identityTop = identity.getBoundingClientRect().top;
  const followButton = Array.from(primary.querySelectorAll('button, [role="button"]'))
    .filter(isFollowButton)
    .find(button => {
      if (!Number.isFinite(identityTop) || identityTop <= 0) return false;
      const rect = button.getBoundingClientRect();
      return rect.bottom <= identityTop + 24 && rect.top >= identityTop - 260;
    }) || null;
  if (!followButton) return;
  // The visibility control is handle-based and must remain available even
  // when the location quota is exhausted, so it only reads cached metadata.
  const profile = await getManualFilterProfileData(handle, true);
  if (!profile || getProfilePageHandle()?.toLowerCase() !== handle.toLowerCase() || !document.contains(followButton)) return;
  const button = createManualFilterButton(profile, 'profile');
  const group = document.createElement('div');
  group.className = 'tf-profile-action-group';
  followButton.insertAdjacentElement('beforebegin', group);
  group.append(followButton, button);
}

async function ensureHoverCardControl(root) {
  if (!root || !document.contains(root)) return;
  const handle = findProfileHandleIn(root);
  if (!handle || !findFollowButton(root)) return;
  const handleKey = handle.toLowerCase();
  if (root.dataset.tfHoverHandle !== handleKey) {
    root.dataset.tfHoverHandle = handleKey;
    root.dataset.tfHoverAttempts = '0';
    delete root.dataset.tfHoverLookupComplete;
    delete root.dataset.tfHoverRetryAt;
  }
  const existingButton = root.querySelector('.tf-filter-profile-btn--hover');
  const existingFlag = root.querySelector('.tf-hover-profile-flag');
  // X reuses the outer hover-card container after its inner content is
  // unmounted. A missing injected button therefore marks a new card session,
  // even when the handle is unchanged.
  if (!existingButton) {
    const staleRetry = hoverCardRetryTimers.get(root);
    if (staleRetry) clearTimeout(staleRetry);
    hoverCardRetryTimers.delete(root);
    root.dataset.tfHoverAttempts = '0';
    delete root.dataset.tfHoverLookupComplete;
    delete root.dataset.tfHoverRetryAt;
  }
  if (existingButton && existingFlag) return;
  if (root.dataset.tfHoverLookupWorking === 'true') return;
  const retryAt = Number(root.dataset.tfHoverRetryAt) || 0;
  if (existingButton && !existingFlag && (root.dataset.tfHoverLookupComplete === 'true' || retryAt > Date.now())) return;
  root.dataset.tfHoverLookupWorking = 'true';
  // Wait for the hover card to remain open before spending a paced lookup.
  // The followers list itself stays passive; only an opened card is checked.
  try {
    if (!existingButton) await new Promise(resolve => setTimeout(resolve, 250));
    if (!document.contains(root) || findProfileHandleIn(root)?.toLowerCase() !== handleKey) return;
    const releaseLookupDemand = registerDirectLookupDemand(handle, root);
    let profile;
    try {
      profile = await getManualFilterProfileData(handle, Boolean(existingFlag));
    } finally {
      releaseLookupDemand();
    }
    if (!profile || !document.contains(root) || findProfileHandleIn(root)?.toLowerCase() !== handleKey) return;
    const identity = root.querySelector('[data-testid="UserName"], [data-testid="User-Name"], [data-testid="User-Names"]');
    addHoverCardLocationBadge(root, identity, profile);
    if (!existingButton && !root.querySelector('.tf-filter-profile-btn--hover')) {
      let surface = identity || root.firstElementChild || root;
      while (surface.parentElement && surface.parentElement !== root) surface = surface.parentElement;
      const slot = document.createElement('div');
      slot.className = 'tf-filter-profile-slot';
      const hasProfileSummaryControl = Array.from(surface.querySelectorAll('button, [role="button"]'))
        .some(control => String(control.textContent || '').trim().toLowerCase().includes('profile summary'));
      if (hasProfileSummaryControl) slot.classList.add('tf-filter-profile-slot--after-summary');
      slot.appendChild(createManualFilterButton(profile, 'hover'));
      surface.appendChild(slot);
    }

    if (root.querySelector('.tf-hover-profile-flag')) {
      root.dataset.tfHoverLookupComplete = 'true';
      delete root.dataset.tfHoverRetryAt;
      root.dataset.tfHoverAttempts = '0';
    } else if (profile.paused || profile.retryable) {
      const attempt = (Number.parseInt(root.dataset.tfHoverAttempts || '0', 10) || 0) + 1;
      root.dataset.tfHoverAttempts = String(attempt);
      if (attempt <= MAX_VISIBLE_RETRIES) {
        debugLog('hover-card-flag-retry', { screenName: handle, attempt, paused: profile.paused, failure: profile.failure || 'temporary' });
        scheduleHoverCardFlagRetry(root, profile, attempt);
      } else {
        root.dataset.tfHoverLookupComplete = 'true';
        debugLog('hover-card-flag-unavailable', { screenName: handle, reason: profile.failure || (profile.paused ? 'paused' : 'retry-limit') });
      }
    } else {
      root.dataset.tfHoverLookupComplete = 'true';
      debugLog('hover-card-flag-unavailable', { screenName: handle, reason: profile.location ? 'unsupported-location' : 'no-location' });
    }
  } finally {
    delete root.dataset.tfHoverLookupWorking;
  }
}

async function scanProfileControls() {
  if (!enabled || gone()) return;
  if (profileControlScanRunning) {
    profileControlScanAgain = true;
    return;
  }
  profileControlScanRunning = true;
  try {
    const tasks = [ensureProfilePageControl(), ...getHoverCardRoots().map(ensureHoverCardControl)];
    await Promise.allSettled(tasks);
  } finally {
    profileControlScanRunning = false;
    if (profileControlScanAgain) {
      profileControlScanAgain = false;
      scheduleProfileControlScan(60);
    }
  }
}

function scheduleProfileControlScan(delay = 80) {
  if (profileControlScanTimer || !enabled) return;
  profileControlScanTimer = setTimeout(() => {
    profileControlScanTimer = null;
    scanProfileControls();
  }, delay);
}

function resetProfileControls() {
  removeProfileActionGroups();
  document.querySelectorAll('.tf-filter-profile-btn, .tf-filter-profile-slot').forEach(node => node.remove());
  scheduleProfileControlScan(0);
}
