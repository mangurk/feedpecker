function pacedActionDelay(remaining, resetAt, now = Date.now()) {
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt) || resetAt <= now || remaining > Limits.actionPaceAt) return Limits.normalActionDelay;
  const spendable = remaining - Limits.actionReserve;
  return spendable <= 0
    ? Math.max(Limits.normalActionDelay, resetAt - now)
    : Math.max(Limits.normalActionDelay, Math.ceil((resetAt - now) / (spendable + 1)));
}

function reserveAccountAction(request) {
  return queues.actions(async () => {
    const screenName = screenNameFrom(request.screenName);
    const action = ['block', 'unblock'].includes(request.action) ? request.action : '';
    if (!screenName || !action) return { allowed: false, reason: 'invalid' };
    const now = Date.now();
    const saved = await store.get(Keys.actionBudget);
    let budget = saved[Keys.actionBudget] && typeof saved[Keys.actionBudget] === 'object' ? saved[Keys.actionBudget] : {};
    if (Number(budget.resetAt) <= now) budget = { nextAt: Math.min(Number(budget.nextAt) || 0, now) };
    const remaining = Number.isFinite(budget.estimatedRemaining) ? budget.estimatedRemaining
      : Number.isFinite(budget.remaining) ? budget.remaining : null;
    const resetAt = Number.isFinite(budget.resetAt) ? budget.resetAt : null;
    if (budget.rateLimited === true && resetAt > now) return { allowed: false, reason: 'rate-limit', retryAt: resetAt, remaining: 0, resetAt };
    if (remaining !== null && resetAt > now && remaining <= Limits.actionReserve) return { allowed: false, reason: 'safety-reserve', retryAt: resetAt, remaining, resetAt };
    if (Number(budget.nextAt) > now) return { allowed: false, reason: 'pace', retryAt: budget.nextAt, remaining, resetAt };
    const delayMs = pacedActionDelay(remaining, resetAt, now);
    budget = { ...budget, nextAt: now + delayMs, estimatedRemaining: remaining === null ? null : Math.max(0, remaining - 1), lastReservedAt: now, lastScreenName: screenName, lastAction: action };
    await store.set({ [Keys.actionBudget]: budget });
    return { allowed: true, delayMs, remaining, resetAt };
  }).catch(error => {
    note('account-action-reservation-failed', { message: error?.message || String(error) });
    return { allowed: false, reason: 'unavailable', retryAt: Date.now() + Limits.normalActionDelay };
  });
}

function updateActionBudget(request) {
  return queues.actions(async () => {
    const now = Date.now();
    const saved = await store.get(Keys.actionBudget);
    const old = saved[Keys.actionBudget] && typeof saved[Keys.actionBudget] === 'object' ? saved[Keys.actionBudget] : {};
    const limit = Number.isFinite(request.rateLimitLimit) ? request.rateLimitLimit : null;
    const remaining = Number.isFinite(request.rateLimitRemaining) ? request.rateLimitRemaining : null;
    const rateLimited = request.status === 429;
    const reportedReset = Number(request.rateLimitResetAt) > now ? Number(request.rateLimitResetAt) : null;
    const resetAt = reportedReset || (rateLimited ? (Number(old.resetAt) > now ? Number(old.resetAt) : now + Limits.actionCooldown) : null);
    const effectiveRemaining = remaining ?? (Number.isFinite(old.estimatedRemaining) ? old.estimatedRemaining : Number.isFinite(old.remaining) ? old.remaining : null);
    const effectiveReset = resetAt ?? (Number(old.resetAt) > now ? Number(old.resetAt) : null);
    const delay = rateLimited && resetAt ? resetAt - now : pacedActionDelay(effectiveRemaining, effectiveReset, now);
    const budget = {
      ...old,
      limit: limit ?? old.limit ?? null,
      remaining: remaining ?? old.remaining ?? null,
      estimatedRemaining: remaining ?? old.estimatedRemaining ?? null,
      resetAt: effectiveReset,
      rateLimited,
      nextAt: Math.max(Number(old.nextAt) || 0, now + delay),
      updatedAt: now
    };
    await store.set({ [Keys.actionBudget]: budget });
    note('account-action-budget', { status: request.status, limit: budget.limit, remaining: budget.remaining, resetAt: budget.resetAt, nextDelay: delay });
  }).catch(() => {});
}

function mergeLookupStatus(source, patch) {
  return queues.lookupStatus(async () => {
    const saved = await store.get(Keys.lookupStatus);
    const status = saved[Keys.lookupStatus] && typeof saved[Keys.lookupStatus] === 'object' ? saved[Keys.lookupStatus] : {};
    const defined = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== null && value !== undefined));
    status[source] = { ...(status[source] || {}), ...defined, updatedAt: Date.now() };
    if (source === 'server' && status.local?.reason === 'fallback-reserve') delete status.local;
    await store.set({ [Keys.lookupStatus]: status });
  });
}

async function currentLookupStatus() {
  const saved = await store.get(Keys.lookupStatus);
  const status = saved[Keys.lookupStatus] && typeof saved[Keys.lookupStatus] === 'object' ? { ...saved[Keys.lookupStatus] } : {};
  const now = Date.now();
  let expired = false;
  for (const source of ['server', 'local']) {
    if (status[source]?.resetAt && status[source].resetAt <= now) { delete status[source]; expired = true; }
  }
  if (expired) await store.set({ [Keys.lookupStatus]: status });
  return status;
}

function claimLookupNotice(request) {
  return queues.toasts(async () => {
    if (state.settings?.toast_notifications === false) return { allowed: false, reason: 'disabled' };
    const kind = request.kind === 'reset-soon' ? 'resetSoon' : request.kind === 'throttled' ? 'throttled' : '';
    const resetAt = Number(request.resetAt);
    if (!kind || !Number.isFinite(resetAt) || resetAt <= Date.now()) return { allowed: false, reason: 'invalid' };
    const saved = await store.get(Keys.lookupToasts);
    const old = saved[Keys.lookupToasts] && typeof saved[Keys.lookupToasts] === 'object' ? saved[Keys.lookupToasts] : {};
    if (old[kind] === resetAt) return { allowed: false, reason: 'already-shown' };
    const next = Object.fromEntries(Object.entries(old).filter(([, expiry]) => Number(expiry) > Date.now()));
    next[kind] = resetAt;
    await store.set({ [Keys.lookupToasts]: next });
    return { allowed: true };
  }).catch(() => ({ allowed: false, reason: 'unavailable' }));
}

function reserveLookup(request) {
  return queues.lookups(async () => {
    const count = Math.max(1, Math.min(10, Number(request.count) || 1));
    const now = Date.now();
    const saved = await store.get([Keys.lookupBudget, Keys.lookupStatus]);
    const server = saved[Keys.lookupStatus]?.server;
    if (server?.rateLimited === true && server.resetAt > now) return { allowed: false, reason: 'server-rate-limit', remaining: 0, limit: server.limit, resetAt: server.resetAt };
    const authoritative = Number(server?.limit) > 0 && Number(server?.remaining) >= 0 && Number(server?.resetAt) > now;
    let budget = saved[Keys.lookupBudget] && typeof saved[Keys.lookupBudget] === 'object' ? saved[Keys.lookupBudget] : {};
    let limit;
    let remaining;
    let resetAt;
    if (authoritative) {
      limit = server.limit;
      resetAt = server.resetAt;
      if (budget.serverUpdatedAt !== server.updatedAt || budget.resetAt !== resetAt) {
        budget = { resetAt, nextAt: budget.resetAt === resetAt ? Number(budget.nextAt) || 0 : 0, serverUpdatedAt: server.updatedAt, estimatedRemaining: server.remaining };
      }
      remaining = Math.min(server.remaining, Number.isFinite(budget.estimatedRemaining) ? budget.estimatedRemaining : server.remaining);
    } else {
      if (!Number.isFinite(budget.startedAt) || !Number.isFinite(budget.fallbackUsed) || !Number.isFinite(budget.resetAt) || budget.resetAt <= now) {
        budget = { startedAt: now, fallbackUsed: 0, resetAt: now + Limits.lookupWindow, nextAt: 0 };
      }
      limit = Limits.lookupFallback;
      resetAt = budget.resetAt;
      remaining = Math.max(0, limit - budget.fallbackUsed);
    }
    if (Number(budget.nextAt) > now) return { allowed: false, reason: 'pace', retryAt: budget.nextAt, remaining, limit, resetAt, authoritative };
    if (remaining - count < Limits.lookupReserve) {
      if (!authoritative) await mergeLookupStatus('local', { reason: 'fallback-reserve', limit, remaining, resetAt });
      return { allowed: false, reason: authoritative ? 'safety-reserve' : 'fallback-reserve', remaining, limit, resetAt, authoritative };
    }
    const slots = Math.max(1, remaining - Limits.lookupReserve);
    const spacingMs = remaining <= Limits.lookupPaceAt ? Math.max(Limits.normalLookupDelay, Math.ceil((resetAt - now) / slots)) : Limits.normalLookupDelay;
    budget.nextAt = now + spacingMs;
    if (authoritative) budget.estimatedRemaining = remaining - count;
    else budget.fallbackUsed += count;
    await store.set({ [Keys.lookupBudget]: budget });
    return { allowed: true, remaining: remaining - count, limit, resetAt, spacingMs, nextAt: budget.nextAt, authoritative };
  }).catch(() => ({ allowed: true, unavailable: true }));
}
