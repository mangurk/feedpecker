function accountActionKey(screenName, action) {
  return `${action}:${screenName.toLowerCase()}`;
}

function getFollowingState(screenNameValue) {
  const screenName = cleanScreenName(screenNameValue)?.toLowerCase();
  if (!screenName) return null;
  const state = followingStates.get(screenName);
  if (!state) return null;
  if (Date.now() - state.seenAt > FOLLOWING_STATE_TTL_MS) {
    followingStates.delete(screenName);
    return null;
  }
  return state.following;
}

function dropQueuedFollowedAutoBlock(screenNameValue) {
  const screenName = cleanScreenName(screenNameValue)?.toLowerCase();
  if (!screenName) return 0;
  let removed = 0;
  for (let index = accountActionQueue.length - 1; index >= 0; index -= 1) {
    const task = accountActionQueue[index];
    if (task.source !== 'auto' || task.action !== 'block' || task.screenName.toLowerCase() !== screenName) continue;
    accountActionQueue.splice(index, 1);
    accountActionKeys.delete(task.key);
    removed += 1;
  }
  if (removed) debugLog('account-action-skipped-following', { screenName, removed });
  return removed;
}

function rememberFollowingState(screenNameValue, following) {
  const screenName = cleanScreenName(screenNameValue)?.toLowerCase();
  if (!screenName || typeof following !== 'boolean') return;
  const now = Date.now();
  const previousState = followingStates.get(screenName);
  const profile = filteredAccounts.get(screenName);
  const relationshipChanged = !previousState || previousState.following !== following;
  const shouldPersist = Boolean(profile && (relationshipChanged || now - (previousState?.persistedAt || 0) >= FOLLOWING_STATE_TTL_MS));
  followingStates.set(screenName, {
    following,
    seenAt: now,
    persistedAt: shouldPersist ? now : (previousState?.persistedAt || 0)
  });
  if (followingStates.size > FOLLOWING_STATE_LIMIT) followingStates.delete(followingStates.keys().next().value);
  if (shouldPersist) {
    try {
      const result = chrome.runtime.sendMessage({ type: 'profileRelationship', screenName, following });
      result?.catch?.(() => {});
    } catch (_) {}
  }
  const override = profileVisibilityOverrides.get(screenName);
  if (!following) {
    if (profile?.exclusionReason === 'following' && override === 'show') {
      restoreAutomaticFollowingExclusion(profile, 'relationship-update').catch(() => {});
    }
    return;
  }
  dropQueuedFollowedAutoBlock(screenName);
  if (profile && !profile.blocked && override !== 'hide' && override !== 'show' && locationMatchesFilter(profile.location, profile.verified)) {
    excludeFollowedProfile(profile, 'relationship-update').catch(() => {});
  }
}

async function waitForFollowingState(screenNameValue) {
  const known = getFollowingState(screenNameValue);
  if (known !== null) return known;
  await new Promise(resolve => setTimeout(resolve, PASSIVE_WAIT_MS));
  return getFollowingState(screenNameValue);
}

function reportAccountActionResult(data, source) {
  try {
    const result = chrome.runtime.sendMessage({
      type: 'accountActionResult',
      actionId: data.actionId,
      screenName: data.screenName,
      action: data.action,
      source: source || data.source || 'unknown',
      ok: data.ok,
      status: data.status,
      rateLimitLimit: data.rateLimitLimit,
      rateLimitRemaining: data.rateLimitRemaining,
      rateLimitResetAt: data.rateLimitResetAt
    });
    result?.catch?.(() => {});
  } catch (_) {}
}

function reserveAccountActionSlot(task) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        type: 'reserveAccountAction',
        screenName: task.screenName,
        action: task.action,
        source: task.source
      }, response => {
        if (!chrome.runtime.lastError && response) {
          resolve(response);
          return;
        }
        const now = Date.now();
        if (accountActionFallbackNextAt > now) {
          resolve({ allowed: false, reason: 'local-pace', retryAt: accountActionFallbackNextAt });
          return;
        }
        accountActionFallbackNextAt = now + ACCOUNT_ACTION_NORMAL_DELAY_MS;
        resolve({ allowed: true, reason: 'local-fallback', delayMs: ACCOUNT_ACTION_NORMAL_DELAY_MS });
      });
    } catch (_) {
      const now = Date.now();
      if (accountActionFallbackNextAt > now) resolve({ allowed: false, reason: 'local-pace', retryAt: accountActionFallbackNextAt });
      else {
        accountActionFallbackNextAt = now + ACCOUNT_ACTION_NORMAL_DELAY_MS;
        resolve({ allowed: true, reason: 'local-fallback', delayMs: ACCOUNT_ACTION_NORMAL_DELAY_MS });
      }
    }
  });
}

function scheduleAccountActionPump(retryAt = Date.now()) {
  clearTimeout(accountActionWakeTimer);
  const delayMs = Math.max(0, Number(retryAt) - Date.now());
  accountActionWakeTimer = setTimeout(() => {
    accountActionWakeTimer = null;
    pumpAccountActionQueue();
  }, delayMs);
}

function finishAccountAction(data) {
  const task = currentAccountAction;
  const matchesCurrent = Boolean(task && (
    (data.actionId && data.actionId === task.actionId) ||
    (cleanScreenName(data.screenName)?.toLowerCase() === task.screenName.toLowerCase() && data.action === task.action)
  ));
  if (!matchesCurrent) {
    reportAccountActionResult(data, data.source);
    return;
  }

  clearTimeout(accountActionResultTimer);
  accountActionResultTimer = null;
  currentAccountAction = null;
  accountActionBusy = false;
  accountActionKeys.delete(task.key);
  reportAccountActionResult({ ...data, actionId: task.actionId }, task.source);
  const automaticBlock = task.source === 'auto' && task.action === 'block';
  if (task.action === 'block' && data.ok === true) bumpStat('blocked');
  debugLog('account-action-completed', {
    screenName: task.screenName,
    action: task.action,
    source: task.source,
    ok: data.ok,
    status: data.status,
    remaining: data.rateLimitRemaining
  });
  if (automaticBlock) {
    const origin = [task.flag, task.country].filter(Boolean).join(' ');
    const originSuffix = origin ? ` · ${origin}` : '';
    if (data.ok === true) {
      debugLog(`@${task.screenName} blocked automatically${originSuffix}`, undefined, 'block');
    } else {
      debugLog(`@${task.screenName} automatic block failed${originSuffix}`, {
        status: Number.isFinite(data.status) ? data.status : 0,
        remaining: Number.isFinite(data.rateLimitRemaining) ? data.rateLimitRemaining : undefined
      }, 'block');
    }
  }
  if (task.action === 'unblock') {
    if (data.ok === true) {
      debugLog(`@${task.screenName} unblocked`, undefined, 'block');
    } else {
      debugLog(`@${task.screenName} unblock failed`, {
        status: Number.isFinite(data.status) ? data.status : 0,
        remaining: Number.isFinite(data.rateLimitRemaining) ? data.rateLimitRemaining : undefined
      }, 'block');
    }
  }
  scheduleAccountActionPump();
}

async function pumpAccountActionQueue() {
  if (accountActionBusy || !accountActionQueue.length || gone()) return;
  accountActionBusy = true;
  const task = accountActionQueue[0];
  if (task.source === 'auto' && task.action === 'block' && getFollowingState(task.screenName) === true) {
    accountActionQueue.shift();
    accountActionKeys.delete(task.key);
    accountActionBusy = false;
    const key = task.screenName.toLowerCase();
    const profile = filteredAccounts.get(key) || {
      screenName: task.screenName,
      location: task.country,
      country: task.country,
      verified: false,
      blocked: false
    };
    if (profileVisibilityOverrides.get(key) !== 'hide') await excludeFollowedProfile(profile, 'action-preflight');
    debugLog('account-action-skipped-following', { screenName: task.screenName, stage: 'preflight' });
    scheduleAccountActionPump();
    return;
  }
  const reservation = await reserveAccountActionSlot(task);
  if (!reservation?.allowed) {
    accountActionBusy = false;
    const retryAt = Number(reservation?.retryAt) || (Date.now() + ACCOUNT_ACTION_NORMAL_DELAY_MS);
    debugLog('account-action-paused', {
      screenName: task.screenName,
      action: task.action,
      source: task.source,
      reason: reservation?.reason || 'pace',
      retryAt,
      remaining: reservation?.remaining
    });
    scheduleAccountActionPump(retryAt);
    return;
  }

  accountActionQueue.shift();
  currentAccountAction = task;
  debugLog('account-action-started', {
    screenName: task.screenName,
    action: task.action,
    source: task.source,
    queuedForMs: Date.now() - task.queuedAt
  });
  try {
    await sendToPage({
      type: task.action === 'unblock' ? '__unblockUser' : '__blockUser',
      screenName: task.screenName,
      actionId: task.actionId,
      source: task.source
    });
    accountActionResultTimer = setTimeout(() => {
      finishAccountAction({
        actionId: task.actionId,
        screenName: task.screenName,
        action: task.action,
        source: task.source,
        ok: false,
        status: 0
      });
    }, ACCOUNT_ACTION_RESULT_TIMEOUT_MS);
  } catch (_) {
    finishAccountAction({
      actionId: task.actionId,
      screenName: task.screenName,
      action: task.action,
      source: task.source,
      ok: false,
      status: 0
    });
  }
}

function enqueueAccountAction(screenNameValue, actionValue, source = 'auto', context = {}) {
  const screenName = cleanScreenName(screenNameValue);
  const action = actionValue === 'unblock' ? 'unblock' : actionValue === 'block' ? 'block' : '';
  if (!screenName || !action) return { queued: false, error: 'invalid-account-action' };
  const key = accountActionKey(screenName, action);
  if (accountActionKeys.has(key)) {
    return { queued: true, duplicate: true, queueLength: accountActionQueue.length + (currentAccountAction ? 1 : 0) };
  }
  if (accountActionQueue.length >= MAX_ACCOUNT_ACTION_QUEUE) {
    debugLog('account-action-dropped', { screenName, action, source, reason: 'queue-full' });
    return { queued: false, error: 'action-queue-full' };
  }

  const task = {
    actionId: `${Date.now().toString(36)}-${(++accountActionSequence).toString(36)}`,
    screenName,
    action,
    source: source === 'manual' ? 'manual' : 'auto',
    country: String(context.country || '').trim().slice(0, 80),
    flag: String(context.flag || '').trim().slice(0, 16),
    key,
    queuedAt: Date.now()
  };
  accountActionKeys.add(key);
  if (task.source === 'manual') {
    const firstAutoIndex = accountActionQueue.findIndex(item => item.source === 'auto');
    if (firstAutoIndex >= 0) accountActionQueue.splice(firstAutoIndex, 0, task);
    else accountActionQueue.push(task);
  } else {
    accountActionQueue.push(task);
  }
  debugLog('account-action-queued', {
    screenName,
    action,
    source: task.source,
    queueLength: accountActionQueue.length + (currentAccountAction ? 1 : 0)
  });
  scheduleAccountActionPump();
  return {
    queued: true,
    actionId: task.actionId,
    queueLength: accountActionQueue.length + (currentAccountAction ? 1 : 0),
    estimatedWaitMs: Math.max(0, accountActionQueue.indexOf(task) + (currentAccountAction ? 1 : 0)) * ACCOUNT_ACTION_NORMAL_DELAY_MS
  };
}

function dropQueuedAutoActions(reason) {
  let removed = 0;
  for (let index = accountActionQueue.length - 1; index >= 0; index -= 1) {
    const task = accountActionQueue[index];
    if (task.source !== 'auto') continue;
    accountActionQueue.splice(index, 1);
    accountActionKeys.delete(task.key);
    removed++;
  }
  if (removed) debugLog('account-action-auto-queue-cleared', { reason, removed });
}
