// ─────────────────────────────────────────────────────────────
//  FetchPipeline — local cache first, then X, with promise sharing
// ─────────────────────────────────────────────────────────────
async function fetchLocation(screenName, cacheOnly = false) {
  const normalizedScreenName = cleanScreenName(screenName);
  if (!normalizedScreenName) {
    return { location: null, verified: false, timezone: null, failure: 'invalid-screen-name' };
  }
  const userKey = normalizedScreenName.toLowerCase();

  // Hot cache hit
  const hot = dataMap.get(userKey);
  if (hot && Date.now() < hot.expiry) {
    if (hot.location === null && hot.resultVersion !== LOCATION_RESULT_VERSION) {
      dataMap.delete(userKey);
      dbDeleteBatch([userKey]);
    } else if (hot.location && !isSupportedOrigin(hot.location)) {
      // Bypass invalid manual location in hot cache
    } else {
      return { location: hot.location, verified: hot.verified ?? false, timezone: hot.timezone ?? null, isRegion: hot.isRegion ?? false, source: 'cache' };
    }
  }
  if (hot) dataMap.delete(userKey);

  if (cacheOnly) {
    const dbVal = await dbGet(userKey);
    if (dbVal && Date.now() < dbVal.expiry) {
      if (dbVal.location === null && dbVal.resultVersion !== LOCATION_RESULT_VERSION) {
        dbDeleteBatch([userKey]);
      } else if (dbVal.location && !isSupportedOrigin(dbVal.location)) {
        // Bypass invalid manual location in cold cache
      } else {
        if (!dbVal.timezone && dbVal.location) {
          dbVal.timezone = resolveTimezone(dbVal.location);
        }
        dataMap.set(userKey, dbVal);
        if (dataMap.size > MEMORY_CACHE_LIMIT) {
          dataMap.delete(dataMap.keys().next().value);
        }
        return { location: dbVal.location, verified: dbVal.verified ?? false, timezone: dbVal.timezone ?? null, isRegion: dbVal.isRegion ?? false, source: 'cache' };
      }
    }
    return { location: null, verified: false, timezone: null, cacheOnlyMiss: true };
  }

  // Cold IndexedDB cache hit
  const dbVal = await dbGet(userKey);
  if (dbVal && Date.now() < dbVal.expiry) {
    if (dbVal.location === null && dbVal.resultVersion !== LOCATION_RESULT_VERSION) {
      dbDeleteBatch([userKey]);
    } else if (dbVal.location && !isSupportedOrigin(dbVal.location)) {
      // Bypass invalid manual location in cold cache
    } else {
      if (!dbVal.timezone && dbVal.location) {
        dbVal.timezone = resolveTimezone(dbVal.location);
      }
      dataMap.set(userKey, dbVal);
      if (dataMap.size > MEMORY_CACHE_LIMIT) {
        dataMap.delete(dataMap.keys().next().value);
      }
      return { location: dbVal.location, verified: dbVal.verified ?? false, timezone: dbVal.timezone ?? null, isRegion: dbVal.isRegion ?? false, source: 'cache' };
    }
  }

  // Negative guard
  const neg = negativeMap.get(userKey);
  if (neg && Date.now() < neg) return { location: null, verified: false, timezone: null, retryable: true, failure: 'retry-delay' };

  // Dedup – piggyback on in-flight request
  if (flightMap.has(userKey)) return flightMap.get(userKey);
  if (flightMap.size >= MAX_LOOKUP_QUEUE) {
    return { location: null, verified: false, retryable: true, failure: 'queue-full' };
  }

  const ticket = (async () => {
    // Snoop-first: give X's own timeline JSON a chance to provide location for free.
    await new Promise(r => setTimeout(r, PASSIVE_WAIT_MS));
    const snoopHot = dataMap.get(userKey);
    if (snoopHot && Date.now() < snoopHot.expiry && snoopHot.location && isSupportedOrigin(snoopHot.location)) {
      return { location: snoopHot.location, verified: snoopHot.verified ?? false, timezone: snoopHot.timezone ?? null, isRegion: snoopHot.isRegion ?? false, source: 'cache' };
    }
    const negAfter = negativeMap.get(userKey);
    if (negAfter && Date.now() < negAfter) return { location: null, verified: false, timezone: null, retryable: true, failure: 'retry-delay' };
    const nowSec = Math.floor(Date.now() / 1000);
    if (rateLimitUntil > nowSec || lookupBudgetResetAt > Date.now()) return { location: null, verified: false, paused: true };
    return new Promise((resolve, reject) => {
      twitterPending.push({ screenName: userKey, resolve, reject });
      drainTwitter();
    });
  })().then(result => {
    if (!result?.location && result?.retryable) {
      negativeMap.set(userKey, Date.now() + TRANSIENT_MISS_TTL);
    }
    flightMap.delete(userKey);
    return result;
  });

  flightMap.set(userKey, ticket);
  return ticket;
}

function reserveLookupBudget(count) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'reserveLookupBudget', count }, response => {
        if (chrome.runtime.lastError || !response) resolve({ allowed: true, unavailable: true });
        else resolve(response);
      });
    } catch (_) {
      resolve({ allowed: true, unavailable: true });
    }
  });
}

function cancelPendingTwitterLookups(reason = 'rate-limit') {
  const pending = twitterPending.splice(0);
  for (const request of pending) {
    flightMap.delete(request.screenName);
    request.resolve({ location: null, verified: false, paused: true });
  }
  if (pending.length) debugLog('drop-queued-lookups', { reason, count: pending.length });
}

function registerDirectLookupDemand(screenNameValue, surface) {
  const screenName = cleanScreenName(screenNameValue)?.toLowerCase();
  if (!screenName || !surface) return () => {};
  let surfaces = directLookupDemand.get(screenName);
  if (!surfaces) {
    surfaces = new Set();
    directLookupDemand.set(screenName, surfaces);
  }
  surfaces.add(surface);
  return () => {
    const current = directLookupDemand.get(screenName);
    if (!current) return;
    current.delete(surface);
    if (current.size === 0) directLookupDemand.delete(screenName);
  };
}

function hasDirectLookupDemand(screenName) {
  const surfaces = directLookupDemand.get(screenName);
  if (!surfaces) return false;
  for (const surface of Array.from(surfaces)) {
    if (!document.contains(surface) || surface.getBoundingClientRect().width <= 0) surfaces.delete(surface);
  }
  if (surfaces.size === 0) {
    directLookupDemand.delete(screenName);
    return false;
  }
  return true;
}

function hasVisibleDemand(screenName) {
  const target = String(screenName || '').toLowerCase();
  if (hasDirectLookupDemand(target)) return true;
  for (const element of visibleElements) {
    if (document.contains(element) && String(findHandle(element) || '').toLowerCase() === target) return true;
  }
  return false;
}

function pruneStaleTwitterLookups() {
  let dropped = 0;
  for (let index = twitterPending.length - 1; index >= 0; index -= 1) {
    const request = twitterPending[index];
    if (hasVisibleDemand(request.screenName)) continue;
    twitterPending.splice(index, 1);
    flightMap.delete(request.screenName);
    request.resolve({ location: null, verified: false, cancelled: true });
    dropped += 1;
  }
  if (dropped) debugLog('drop-stale-lookups', { count: dropped });
}

async function drainTwitter() {
  if (twitterBusy || twitterPending.length === 0 || gone()) return;
  pruneStaleTwitterLookups();
  if (twitterPending.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  if (rateLimitUntil > now) {
    cancelPendingTwitterLookups('rate-limit');
    return;
  }
  twitterBusy = true;
  const budget = await reserveLookupBudget(Math.min(TWITTER_PARALLEL, twitterPending.length));
  if (!budget.allowed) {
    if (budget.reason === 'pace') {
      twitterBusy = false;
      const waitMs = Math.max(50, (budget.retryAt || Date.now() + 250) - Date.now());
      setTimeout(drainTwitter, waitMs);
      return;
    }
    if (budget.reason === 'server-rate-limit') {
      rateLimitUntil = Math.max(rateLimitUntil, Math.ceil((budget.resetAt || Date.now() + 60_000) / 1000));
      twitterBusy = false;
      cancelPendingTwitterLookups('shared-rate-limit');
      return;
    }
    lookupBudgetResetAt = budget.resetAt || Date.now() + 60_000;
    debugLog('lookup-safety-reserve', {
      reason: budget.reason,
      remaining: budget.remaining,
      limit: budget.limit,
      resetAt: lookupBudgetResetAt
    });
    twitterBusy = false;
    cancelPendingTwitterLookups('lookup-safety-reserve');
    return;
  }
  lookupBudgetResetAt = 0;
  const nextLookupAt = Number.isFinite(budget.nextAt)
    ? budget.nextAt
    : Date.now() + (Number.isFinite(budget.spacingMs) ? budget.spacingMs : TWITTER_STAGGER_MS);
  const batch = twitterPending.splice(0, TWITTER_PARALLEL);
  if (batch.length === 0) { twitterBusy = false; return; }

  const fetchOne = (req) => new Promise(done => {
    // Re-check cache (passive data may have arrived while queued)
    const fresh = dataMap.get(req.screenName);
    if (fresh && fresh.expiry > Date.now()) {
      if (fresh.location === null && fresh.resultVersion !== LOCATION_RESULT_VERSION) {
        dataMap.delete(req.screenName);
        dbDeleteBatch([req.screenName]);
      } else if (fresh.location && !isSupportedOrigin(fresh.location)) {
        // Bypass invalid manual location in re-check
      } else {
        req.resolve({ location: fresh.location, verified: fresh.verified, timezone: fresh.timezone ?? null, isRegion: fresh.isRegion ?? false, source: 'cache' });
        flightMap.delete(req.screenName);
        return done();
      }
    }
    const rid = crypto.randomUUID();
    let settled = false;
    const onReply = (data) => {
      if (data?.type !== '__userDataResponse' || data.requestId !== rid) return;
      pageBridgeListeners.delete(onReply);
      if (settled) return;
      settled = true;
      rememberFollowingState(req.screenName, data.following);
      if (data.confirmed === true) record(req.screenName, data.location, data.verified, null, data.is_region, true);
      const tz = dataMap.get(req.screenName)?.timezone ?? null;
      const paused = Boolean(data.isRateLimited);
      const result = {
        location: data.location,
        verified: data.verified ?? false,
        timezone: tz,
        isRegion: data.is_region,
        source: 'twitter',
        paused,
        retryable: data.retryable === true,
        following: getFollowingState(req.screenName),
        failure: typeof data.failure === 'string' ? data.failure : null
      };
      req.resolve(result);
      flightMap.delete(req.screenName);
      if (paused) cancelPendingTwitterLookups('rate-limit');
      done();
    };
    pageBridgeReady.then(port => {
      if (settled) return;
      pageBridgeListeners.add(onReply);
      port.postMessage({ type: '__fetchUserData', screenName: req.screenName, requestId: rid });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      pageBridgeListeners.delete(onReply);
      flightMap.delete(req.screenName);
      req.resolve({ location: null, verified: false, retryable: true, failure: 'bridge-timeout' });
      done();
    }, LOOKUP_RESPONSE_TIMEOUT_MS);
  });

  try {
    await Promise.all(batch.map(fetchOne));
    const waitMs = Math.max(50, nextLookupAt - Date.now());
    setTimeout(() => { twitterBusy = false; if (twitterPending.length && rateLimitUntil <= Math.floor(Date.now() / 1000)) drainTwitter(); }, waitMs);
  } catch (_) {
    twitterBusy = false;
    if (twitterPending.length && rateLimitUntil <= Math.floor(Date.now() / 1000)) {
      setTimeout(drainTwitter, Math.max(50, nextLookupAt - Date.now()));
    }
  }
}
