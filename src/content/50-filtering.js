// ─────────────────────────────────────────────────────────────
//  Renderer — flag injection, sync path, pending queue
// ─────────────────────────────────────────────────────────────
function findHandle(container) {
  const nameWrap = container.querySelector('[data-testid="User-Name"]');
  if (!nameWrap) return null;
  for (const a of nameWrap.querySelectorAll('a[href^="/"]')) {
    const m = a.getAttribute('href').match(/^\/([^\/\?]+)$/);
    if (m && !['home','explore','notifications','messages','search'].includes(m[1])) return m[1];
  }
  // Fallback: search for text containing "@username"
  const text = nameWrap.textContent;
  const match = text.match(/@([a-zA-Z0-9_]{1,15})/);
  if (match) return match[1];
  return null;
}

const PROFILE_TABS = new Set(['with_replies', 'media', 'likes', 'followers', 'following']);
const RESERVED_ROUTES = new Set([
  'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose',
  'i', 'jobs', 'lists', 'bookmarks', 'communities', 'premium', 'account', 'login',
  'signup', 'intent', 'hashtag', 'status', 'help', 'privacy', 'tos'
]);
let profileRouteKey = '';
let profileNoticeKey = '';
let lastBirdFlightDirection = 0;
let sameDirectionFlightCount = 0;
const pendingArticleHides = new Map();
let pendingHideViewport = null;
const HIDE_SCROLL_SETTLE_MS = 160;
let lastTimelineScrollAt = 0;
let hideScrollSettleTimer = null;

function chooseBirdFlightDirection() {
  let direction = Math.random() < .5 ? -1 : 1;
  if (direction === lastBirdFlightDirection && sameDirectionFlightCount >= 2) direction *= -1;
  if (direction === lastBirdFlightDirection) {
    sameDirectionFlightCount += 1;
  } else {
    lastBirdFlightDirection = direction;
    sameDirectionFlightCount = 1;
  }
  return direction;
}

function cancelPendingArticleHide(article) {
  if (!article) return false;
  const wasPending = pendingArticleHides.has(article);
  pendingHideViewport?.unobserve(article);
  pendingArticleHides.delete(article);
  if (pendingArticleHides.size === 0) {
    clearTimeout(hideScrollSettleTimer);
    hideScrollSettleTimer = null;
  }
  delete article.dataset.tfHidePending;
  if (article.dataset.locationHidden !== 'true') delete article.dataset.tfHiddenHandle;
  return wasPending;
}

function tryRunPendingArticleHide(article) {
  const pendingHide = pendingArticleHides.get(article);
  if (!pendingHide) return;
  if (!document.contains(article)) {
    cancelPendingArticleHide(article);
    return;
  }
  const rect = article.getBoundingClientRect();
  const visible = document.visibilityState === 'visible' && rect.bottom > 0 && rect.top < window.innerHeight;
  const scrolling = Date.now() - lastTimelineScrollAt < HIDE_SCROLL_SETTLE_MS;
  if (!pendingHide.enteredViewport || !visible || scrolling) return;
  cancelPendingArticleHide(article);
  hideArticle(article, pendingHide.screenNameKey);
}

function finishPendingHideAfterFastScroll(article) {
  const pendingHide = pendingArticleHides.get(article);
  if (!pendingHide) return;
  cancelPendingArticleHide(article);
  if (!document.contains(article)) return;
  debugLog('hide-animation-fast-scroll', { screenName: pendingHide.screenNameKey }, 'animation');
  hideArticle(article, pendingHide.screenNameKey, { skipAnimation: true });
}

function runPendingHidesAfterScrollSettles() {
  hideScrollSettleTimer = null;
  const remaining = HIDE_SCROLL_SETTLE_MS - (Date.now() - lastTimelineScrollAt);
  if (remaining > 0) {
    hideScrollSettleTimer = setTimeout(runPendingHidesAfterScrollSettles, remaining + 16);
    return;
  }
  for (const article of Array.from(pendingArticleHides.keys())) tryRunPendingArticleHide(article);
}

function noteTimelineScroll() {
  lastTimelineScrollAt = Date.now();
  clearTimeout(hideScrollSettleTimer);
  hideScrollSettleTimer = setTimeout(runPendingHidesAfterScrollSettles, HIDE_SCROLL_SETTLE_MS + 16);
}

function ensurePendingHideViewport() {
  if (pendingHideViewport || typeof IntersectionObserver !== 'function') return pendingHideViewport;
  pendingHideViewport = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const pendingHide = pendingArticleHides.get(entry.target);
      if (!pendingHide) continue;
      if (entry.isIntersecting) {
        pendingHide.enteredViewport = true;
        tryRunPendingArticleHide(entry.target);
      } else if (pendingHide.enteredViewport) {
        finishPendingHideAfterFastScroll(entry.target);
      }
    }
  }, { root: null, rootMargin: '0px', threshold: 0 });
  return pendingHideViewport;
}

function queueArticleHideForViewport(article, screenNameKey) {
  const observer = ensurePendingHideViewport();
  if (!observer) return false;
  const currentPending = pendingArticleHides.get(article);
  if (currentPending?.screenNameKey === screenNameKey) return true;
  if (currentPending) cancelPendingArticleHide(article);
  pendingArticleHides.set(article, { screenNameKey, enteredViewport: false });
  article.dataset.tfHidePending = 'true';
  article.dataset.tfHiddenHandle = screenNameKey;
  observer.observe(article);
  debugLog('hide-animation-pending', { screenName: screenNameKey }, 'animation');
  return true;
}

function flushPendingArticleHides() {
  for (const [article, pendingHide] of Array.from(pendingArticleHides)) {
    cancelPendingArticleHide(article);
    if (document.contains(article)) hideArticle(article, pendingHide.screenNameKey);
  }
}

document.addEventListener('scroll', noteTimelineScroll, { passive: true, capture: true });
window.addEventListener('scroll', noteTimelineScroll, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  for (const article of Array.from(pendingArticleHides.keys())) tryRunPendingArticleHide(article);
});

function getProfilePageHandle() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  let first = '';
  try { first = decodeURIComponent(parts[0]); } catch (_) { return null; }
  if (!first || RESERVED_ROUTES.has(first.toLowerCase())) return null;
  if (parts.length === 1) return first;
  if (parts.length === 2 && PROFILE_TABS.has(parts[1].toLowerCase())) return first;
  return null;
}

function clearHiddenArticles() {
  const articles = new Set([
    ...document.querySelectorAll('[data-location-hidden]'),
    ...pendingArticleHides.keys()
  ]);
  articles.forEach(article => restoreHiddenArticle(article));
}

function clearHiddenArticlesForHandle(screenName) {
  const handle = cleanScreenName(screenName)?.toLowerCase();
  if (!handle) return;
  const articles = new Set([
    ...document.querySelectorAll('[data-location-hidden]'),
    ...pendingArticleHides.keys()
  ]);
  articles.forEach(article => {
    if (article.dataset.tfHiddenHandle === handle || pendingArticleHides.get(article)?.screenNameKey === handle) restoreHiddenArticle(article);
  });
}

function restoreHiddenArticle(article) {
  if (!article) return;
  const wasPending = cancelPendingArticleHide(article);
  const state = hiddenArticleStates.get(article);
  state?.articleAnimation?.cancel();
  state?.recoilAnimations?.forEach(animation => animation.cancel());
  state?.sparkAnimations?.forEach(animation => animation.cancel());
  state?.sparkLayer?.remove();

  if (state?.styles) {
    for (const [property, value] of Object.entries(state.styles)) article.style[property] = value;
  } else if (!wasPending) {
    article.style.display = '';
    article.style.height = '';
    article.style.minHeight = '';
    article.style.overflow = '';
    article.style.opacity = '';
    article.style.transform = '';
    article.style.filter = '';
    article.style.clipPath = '';
    article.style.position = '';
    article.style.pointerEvents = '';
    article.style.willChange = '';
  }

  hiddenArticleStates.delete(article);
  delete article.dataset.locationHidden;
  delete article.dataset.tfHiddenHandle;
  delete article.dataset.tfHiding;
}

function getHideRecoilTargets(article, targetRect) {
  const timelineArticles = Array.from(new Set(
    document.querySelectorAll('article[data-testid="tweet"], article[role="article"]')
  ))
    .filter(candidate => candidate !== article && !candidate.parentElement?.closest('article'))
    .filter(candidate => candidate.dataset.locationHidden !== 'true')
    .map(candidate => ({ candidate, rect: candidate.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height >= 24 && rect.bottom > 0 && rect.top < window.innerHeight);

  const above = timelineArticles
    .filter(({ rect }) => rect.top < targetRect.top)
    .sort((left, right) => right.rect.top - left.rect.top)[0]?.candidate;
  const below = timelineArticles
    .filter(({ rect }) => rect.top > targetRect.top)
    .sort((left, right) => left.rect.top - right.rect.top)[0]?.candidate;

  return [
    above && { element: above, direction: -1 },
    below && { element: below, direction: 1 }
  ].filter(Boolean);
}

function finishArticleHide(article, screenNameKey, state) {
  if (hiddenArticleStates.get(article) !== state || article.dataset.tfHiddenHandle !== screenNameKey) return;
  state.articleAnimation?.cancel();
  article.style.display = 'none';
  article.style.height = state.styles.height;
  article.style.minHeight = state.styles.minHeight;
  article.style.overflow = state.styles.overflow;
  article.style.opacity = state.styles.opacity;
  article.style.transform = state.styles.transform;
  article.style.filter = state.styles.filter;
  article.style.clipPath = state.styles.clipPath;
  article.style.position = state.styles.position;
  article.style.pointerEvents = state.styles.pointerEvents;
  article.style.willChange = state.styles.willChange;
  delete article.dataset.tfHiding;
  state.articleAnimation = null;
}

function hideArticle(article, screenNameKey, options = {}) {
  if (!article || article.dataset.locationHidden === 'true') return false;

  const skipAnimation = options.skipAnimation === true;
  const rect = article.getBoundingClientRect();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  const visible = document.visibilityState === 'visible' && inViewport;
  const canAnimate = !skipAnimation && hideAnimationEnabled && !reducedMotion && rect.height >= 24 && typeof article.animate === 'function';
  if (canAnimate && !visible && queueArticleHideForViewport(article, screenNameKey)) return true;
  cancelPendingArticleHide(article);

  const styles = {
    display: article.style.display,
    height: article.style.height,
    minHeight: article.style.minHeight,
    overflow: article.style.overflow,
    opacity: article.style.opacity,
    transform: article.style.transform,
    filter: article.style.filter,
    clipPath: article.style.clipPath,
    position: article.style.position,
    pointerEvents: article.style.pointerEvents,
    willChange: article.style.willChange
  };
  const state = { styles, articleAnimation: null, recoilAnimations: [], sparkLayer: null, sparkAnimations: [] };
  hiddenArticleStates.set(article, state);
  article.dataset.locationHidden = 'true';
  article.dataset.tfHiddenHandle = screenNameKey;

  const motionBlocked = reducedMotion;
  const visibilityBlocked = !visible;
  if (skipAnimation || !hideAnimationEnabled || motionBlocked || visibilityBlocked || rect.height < 24 || typeof article.animate !== 'function') {
    debugLog('hide-animation-skipped', {
      screenName: screenNameKey,
      reason: skipAnimation ? 'fast-scroll'
        : !hideAnimationEnabled ? 'disabled'
        : motionBlocked ? 'reduced-motion'
        : visibilityBlocked ? 'offscreen'
        : rect.height < 24 ? 'short-element'
        : 'unsupported'
    }, 'animation');
    finishArticleHide(article, screenNameKey, state);
    return false;
  }

  debugLog('hide-animation-start', {
    screenName: screenNameKey,
    height: Math.round(rect.height),
    viewportTop: Math.round(rect.top),
    viewportBottom: Math.round(rect.bottom)
  }, 'animation');

  article.dataset.tfHiding = 'true';
  article.style.height = `${rect.height}px`;
  article.style.minHeight = '0';
  article.style.overflow = 'hidden';
  article.style.pointerEvents = 'none';
  article.style.willChange = 'height, opacity, transform, filter';
  if (getComputedStyle(article).position === 'static') article.style.position = 'relative';

  const collapseDuration = 250;
  const impactDelay = collapseDuration;
  const sparkLayer = document.createElement('span');
  sparkLayer.className = 'tf-hide-sparks tf-hide-sparks--fixed';
  sparkLayer.setAttribute('aria-hidden', 'true');
  sparkLayer.style.left = `${rect.left + rect.width / 2}px`;
  sparkLayer.style.top = `${rect.top}px`;
  document.documentElement.appendChild(sparkLayer);
  state.sparkLayer = sparkLayer;

  const waveWidth = Math.max(120, Math.min(rect.width * .94, 720));
  const glowWave = document.createElement('span');
  glowWave.className = 'tf-smash-wave tf-smash-wave--glow';
  glowWave.style.width = `${waveWidth}px`;
  sparkLayer.appendChild(glowWave);
  state.sparkAnimations.push(glowWave.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(0)' },
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(.02)', offset: .08 },
    { opacity: .68, transform: 'translate(-50%, -50%) scaleX(.16)', offset: .2 },
    { opacity: .58, transform: 'translate(-50%, -50%) scaleX(1.07)', offset: .62 },
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(1.12)' }
  ], { duration: 230, delay: impactDelay - 2, easing: 'cubic-bezier(.08,.72,.16,1)', fill: 'both' }));

  const coreWave = document.createElement('span');
  coreWave.className = 'tf-smash-wave tf-smash-wave--core';
  coreWave.style.width = `${waveWidth}px`;
  sparkLayer.appendChild(coreWave);
  state.sparkAnimations.push(coreWave.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(0)' },
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(.02)', offset: .05 },
    { opacity: 1, transform: 'translate(-50%, -50%) scaleX(.09)', offset: .13 },
    { opacity: .96, transform: 'translate(-50%, -50%) scaleX(1.04)', offset: .52 },
    { opacity: .42, transform: 'translate(-50%, -50%) scaleX(.98)', offset: .7 },
    { opacity: 0, transform: 'translate(-50%, -50%) scaleX(1.08)' }
  ], { duration: 180, delay: impactDelay, easing: 'cubic-bezier(.06,.78,.12,1)', fill: 'both' }));

  const bird = document.createElement('span');
  bird.className = 'tf-smash-bird';
  const birdDirection = chooseBirdFlightDirection();
  bird.dataset.flightDirection = birdDirection < 0 ? 'left' : 'right';
  const birdSprite = document.createElement('span');
  birdSprite.className = 'tf-smash-bird-sprite';
  birdSprite.style.backgroundImage = `url("${chrome.runtime.getURL('sprites/feedpecker-flight.png')}")`;
  bird.appendChild(birdSprite);
  sparkLayer.appendChild(bird);
  state.sparkAnimations.push(bird.animate([
    { opacity: 0, transform: `translate(-50%, -50%) scale(.62) scaleX(${birdDirection}) rotate(-2deg)` },
    { opacity: 1, transform: `translate(calc(-50% + ${birdDirection}px), calc(-50% - 5px)) scale(.92) scaleX(${birdDirection}) rotate(-4deg)`, offset: .06 },
    { opacity: 1, transform: `translate(calc(-50% + ${birdDirection * 14}px), calc(-50% - 22px)) scale(1.06) scaleX(${birdDirection}) rotate(-6deg)`, offset: .18 },
    { opacity: 1, transform: `translate(calc(-50% + ${birdDirection * 48}px), calc(-50% - 69px)) scale(1.05) scaleX(${birdDirection}) rotate(-8deg)`, offset: .55 },
    { opacity: 1, transform: `translate(calc(-50% + ${birdDirection * 76}px), calc(-50% - 108px)) scale(.99) scaleX(${birdDirection}) rotate(-9deg)`, offset: .82 },
    { opacity: .66, transform: `translate(calc(-50% + ${birdDirection * 88}px), calc(-50% - 125px)) scale(.95) scaleX(${birdDirection}) rotate(-10deg)`, offset: .92 },
    { opacity: 0, transform: `translate(calc(-50% + ${birdDirection * 98}px), calc(-50% - 138px)) scale(.9) scaleX(${birdDirection}) rotate(-11deg)` }
  ], { duration: 860, delay: impactDelay, easing: 'cubic-bezier(.16,.58,.18,1)', fill: 'both' }));
  state.sparkAnimations.push(birdSprite.animate([
    { transform: 'translateX(0)', offset: 0, easing: 'steps(1, end)' },
    { transform: 'translateX(-33.3333%)', offset: 1 / 3, easing: 'steps(1, end)' },
    { transform: 'translateX(-66.6667%)', offset: 2 / 3, easing: 'steps(1, end)' },
    { transform: 'translateX(0)', offset: 1 }
  ], { duration: 215, delay: impactDelay, iterations: 4, easing: 'linear', fill: 'both' }));

  const sparkVectors = [[-162,-8],[-148,-28],[-128,18],[-108,-44],[-84,34],[-58,-18],[62,-22],[88,36],[112,-42],[132,20],[152,-26],[172,8]];
  sparkVectors.forEach(([x, y], index) => {
    const spark = document.createElement('i');
    spark.className = 'tf-smash-spark';
    sparkLayer.appendChild(spark);
    state.sparkAnimations.push(spark.animate([
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.2)' },
      { opacity: 0, transform: `translate(calc(-50% + ${x * .1}px), calc(-50% + ${y * .1}px)) scale(.45)`, offset: .1 },
      { opacity: 1, transform: `translate(calc(-50% + ${x * .18}px), calc(-50% + ${y * .18}px)) scale(1.15)`, offset: .14 },
      { opacity: 1, transform: `translate(calc(-50% + ${x * .45}px), calc(-50% + ${y * .45}px)) scaleX(.8) rotate(${index % 2 ? -12 : 12}deg)`, offset: .45 },
      { opacity: 0, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scaleX(.3) rotate(${index % 2 ? -22 : 22}deg)` }
    ], { duration: 540, delay: impactDelay + index * 4, easing: 'cubic-bezier(.08,.68,.12,1)', fill: 'both' }));
  });

  const debrisVectors = [[-92,-26,-12],[-76,42,18],[-48,-58,-24],[-22,52,12],[34,-64,26],[58,48,-16],[86,-30,22],[106,34,-20]];
  debrisVectors.forEach(([x, y, rotation], index) => {
    const debris = document.createElement('b');
    debris.className = 'tf-smash-debris';
    sparkLayer.appendChild(debris);
    state.sparkAnimations.push(debris.animate([
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.4) rotate(0)' },
      { opacity: 0, transform: `translate(calc(-50% + ${x * .1}px), calc(-50% + ${y * .08}px)) scale(.55) rotate(${rotation * .5}deg)`, offset: .1 },
      { opacity: .95, transform: `translate(calc(-50% + ${x * .18}px), calc(-50% + ${y * .14}px)) scale(1) rotate(${rotation}deg)`, offset: .15 },
      { opacity: .9, transform: `translate(calc(-50% + ${x * .5}px), calc(-50% + ${y * .35}px)) scale(.85) rotate(${rotation * 3}deg)`, offset: .48 },
      { opacity: 0, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y + 28}px)) scale(.5) rotate(${rotation * 8}deg)` }
    ], { duration: 700, delay: impactDelay + 2 + index * 7, easing: 'cubic-bezier(.1,.6,.18,1)', fill: 'both' }));
  });

  state.sparkAnimations.push(sparkLayer.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1160 }));
  const finalSparkAnimation = state.sparkAnimations.at(-1);
  finalSparkAnimation.addEventListener('finish', () => {
    if (hiddenArticleStates.get(article) !== state) return;
    state.sparkLayer?.remove();
    state.sparkLayer = null;
    state.sparkAnimations = [];
  }, { once: true });

  state.articleAnimation = article.animate([
    { height: `${rect.height}px`, opacity: 1, transform: 'scaleX(1) scaleY(1)', filter: 'brightness(1) contrast(1)', offset: 0 },
    { height: `${rect.height * .82}px`, opacity: 1, transform: 'scaleX(1.005) scaleY(.92)', filter: 'brightness(.92) contrast(1.08)', offset: .42 },
    { height: `${rect.height * .38}px`, opacity: .42, transform: 'scaleX(1.03) scaleY(.48)', filter: 'brightness(.72) saturate(.55)', offset: .7 },
    { height: '3px', opacity: .04, transform: 'scaleX(1.12) scaleY(.018)', filter: 'brightness(.9) saturate(.2)', offset: .9 },
    { height: '0px', opacity: 0, transform: 'scaleX(1.15) scaleY(0)', filter: 'brightness(.9) saturate(.2)', offset: 1 }
  ], { duration: collapseDuration, easing: 'cubic-bezier(.72,0,1,.3)', fill: 'forwards' });
  getHideRecoilTargets(article, rect).forEach(({ element, direction }) => {
    if (!element.animate) return;
    state.recoilAnimations.push(element.animate([
      { transform: 'translateY(0)', offset: 0 },
      { transform: `translateY(${direction * 7}px)`, offset: .12 },
      { transform: `translateY(${direction * -4}px)`, offset: .36 },
      { transform: `translateY(${direction * 2.5}px)`, offset: .59 },
      { transform: `translateY(${direction * -1}px)`, offset: .8 },
      { transform: 'translateY(0)', offset: 1 }
    ], { duration: 220, delay: impactDelay - 16, easing: 'linear' }));
  });
  state.articleAnimation.addEventListener('finish', () => {
    debugLog('hide-animation-finish', { screenName: screenNameKey }, 'animation');
    finishArticleHide(article, screenNameKey, state);
  }, { once: true });
  return true;
}

function removeProfileActionGroups() {
  document.querySelectorAll('.tf-profile-action-group').forEach(group => {
    const followButton = Array.from(group.querySelectorAll('button, [role="button"]')).find(isFollowButton);
    if (followButton && group.parentElement) group.parentElement.insertBefore(followButton, group);
    group.remove();
  });
}

function updateProfilePageMode() {
  const handle = getProfilePageHandle();
  const nextKey = handle?.toLowerCase() || '';
  if (nextKey !== profileRouteKey) {
    profileRouteKey = nextKey;
    profileNoticeKey = '';
    removeProfileActionGroups();
    document.querySelectorAll('.tf-filter-profile-btn--profile').forEach(button => button.remove());
    if (handle) clearHiddenArticles();
    scheduleProfileControlScan(80);
  }
  return handle;
}

function locationMatchesFilter(location, verified) {
  return originIsBlocked(location, verified, filteredRegions, onlyVerified);
}

function syncExcludedFlagMarker(badge, excluded) {
  if (!badge) return;
  const existing = badge.querySelector('.tf-excluded-marker');
  if (!excluded) {
    existing?.remove();
    delete badge.dataset.tfExcluded;
    return;
  }
  badge.dataset.tfExcluded = 'true';
  if (existing) return;

  const marker = document.createElement('span');
  marker.className = 'tf-excluded-marker';
  marker.setAttribute('aria-label', 'Excluded from country filtering');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  check.setAttribute('d', 'M4.5 12.5 9.5 17.5 19.5 6.5');
  svg.appendChild(check);
  marker.appendChild(svg);
  const flagImage = badge.querySelector('.tf-flag-image');
  if (flagImage?.nextSibling) badge.insertBefore(marker, flagImage.nextSibling);
  else badge.appendChild(marker);
}

function excludeFollowedProfile(profile, context = 'auto-block') {
  const screenName = cleanScreenName(profile?.screenName);
  if (!screenName) return Promise.resolve(false);
  const key = screenName.toLowerCase();
  const currentOverride = profileVisibilityOverrides.get(key);
  if (currentOverride === 'show') return Promise.resolve(true);
  if (currentOverride === 'hide') return Promise.resolve(false);
  if (followingExclusionPromises.has(key)) return followingExclusionPromises.get(key);

  const normalizedProfile = {
    screenName,
    location: String(profile.location || ''),
    country: String(profile.country || resolveCountryName(profile.location) || profile.location || ''),
    verified: profile.verified === true
  };
  const operation = setProfileVisibility(normalizedProfile, 'show', {
    exclusionReason: 'following',
    following: true
  }).then(updated => {
    if (!updated) {
      debugLog('followed-profile-exclusion-failed', { screenName, context });
      return false;
    }
    profileVisibilityOverrides.set(key, 'show');
    filteredAccounts.set(key, {
      ...normalizedProfile,
      lastSeen: Date.now(),
      blocked: filteredAccounts.get(key)?.blocked === true,
      following: true,
      relationshipObservedAt: Date.now(),
      exclusionReason: 'following'
    });
    clearHiddenArticlesForHandle(key);
    updateManualFilterButtonStates();
    const flag = getCountryFlag(normalizedProfile.country);
    const origin = [flag, normalizedProfile.country].filter(Boolean).join(' ');
    debugLog(`@${screenName} excluded from country filtering because you follow this account${origin ? ` · ${origin}` : ''}`, undefined, 'filter');
    return true;
  }).finally(() => followingExclusionPromises.delete(key));
  followingExclusionPromises.set(key, operation);
  return operation;
}

function restoreAutomaticFollowingExclusion(profile, context = 'relationship-update') {
  const screenName = cleanScreenName(profile?.screenName);
  if (!screenName) return Promise.resolve(false);
  const key = screenName.toLowerCase();
  if (profileVisibilityOverrides.get(key) !== 'show' || filteredAccounts.get(key)?.exclusionReason !== 'following') {
    return Promise.resolve(false);
  }
  if (followingRestorePromises.has(key)) return followingRestorePromises.get(key);

  const normalizedProfile = {
    screenName,
    location: String(profile.location || ''),
    country: String(profile.country || resolveCountryName(profile.location) || profile.location || ''),
    verified: profile.verified === true
  };
  const operation = setProfileVisibility(normalizedProfile, 'default', { following: false }).then(updated => {
    if (!updated) {
      debugLog('followed-profile-filter-restore-failed', { screenName, context });
      return false;
    }
    profileVisibilityOverrides.delete(key);
    const current = filteredAccounts.get(key) || normalizedProfile;
    const { exclusionReason: _removedReason, ...rest } = current;
    filteredAccounts.set(key, {
      ...rest,
      following: false,
      relationshipObservedAt: Date.now()
    });
    updateManualFilterButtonStates();
    debugLog(`@${screenName} returned to country filtering after you unfollowed this account`, undefined, 'filter');
    return true;
  }).finally(() => followingRestorePromises.delete(key));
  followingRestorePromises.set(key, operation);
  return operation;
}

function parseFilteredAccounts(raw) {
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  return new Map(entries
    .filter(([key, account]) => cleanScreenName(key) && account && typeof account === 'object')
    .map(([key, account]) => [key.toLowerCase(), account]));
}

function parseProfileVisibilityOverrides(raw) {
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  return new Map(entries
    .filter(([key, value]) => cleanScreenName(key) && (value === 'hide' || value === 'show'))
    .map(([key, value]) => [key.toLowerCase(), value]));
}

async function refreshFilteredAccounts() {
  try {
    const result = await disk.read([FILTERED_ACCOUNTS_KEY, PROFILE_VISIBILITY_OVERRIDES_KEY]);
    filteredAccounts = parseFilteredAccounts(result[FILTERED_ACCOUNTS_KEY]);
    profileVisibilityOverrides = parseProfileVisibilityOverrides(result[PROFILE_VISIBILITY_OVERRIDES_KEY]);
    updateManualFilterButtonStates();
  } catch (_) {}
}
