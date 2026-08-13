function profileRecord(request, previous = {}) {
  const record = {
    screenName: screenNameFrom(request.screenName),
    location: boundedText(request.location || previous.location, 160),
    country: boundedText(request.country || previous.country, 100),
    verified: request.verified === true || previous.verified === true,
    blocked: previous.blocked === true,
    lastSeen: Number(previous.lastSeen) || Date.now()
  };
  const following = typeof request.following === 'boolean' ? request.following : previous.following;
  if (typeof following === 'boolean') {
    record.following = following;
    record.relationshipObservedAt = typeof request.following === 'boolean' ? Date.now() : (Number(previous.relationshipObservedAt) || Date.now());
  }
  if (['following', 'manual'].includes(previous.exclusionReason)) record.exclusionReason = previous.exclusionReason;
  return record;
}

function withProfileData(operation) {
  return queues.profiles(async () => {
    const saved = await store.get([Keys.accounts, Keys.visibility]);
    const accounts = saved[Keys.accounts] && typeof saved[Keys.accounts] === 'object' ? saved[Keys.accounts] : {};
    const visibility = saved[Keys.visibility] && typeof saved[Keys.visibility] === 'object' ? saved[Keys.visibility] : {};
    return operation(accounts, visibility);
  });
}

function rememberFilteredProfile(request) {
  return withProfileData(async accounts => {
    const name = screenNameFrom(request.screenName);
    if (!name) return { ok: false };
    const key = name.toLowerCase();
    const created = !Object.hasOwn(accounts, key);
    const record = profileRecord(request, accounts[key]);
    record.lastSeen = Date.now();
    accounts[key] = record;
    await store.set({ [Keys.accounts]: accounts });
    if (created && request.manual !== true) {
      const today = dayStamp();
      state.stats.newFilteredProfiles += 1;
      state.stats.newFilteredByDay[today] = (state.stats.newFilteredByDay[today] || 0) + 1;
      state.stats.newFilteredByDay = recentDays(state.stats.newFilteredByDay);
      saveStatsSoon();
    }
    return { ok: true, isNew: created };
  }).catch(() => ({ ok: false }));
}

function setProfileVisibility(request) {
  return withProfileData(async (accounts, visibility) => {
    const name = screenNameFrom(request.screenName);
    const choice = ['hide', 'show', 'default'].includes(request.visibility) ? request.visibility : '';
    if (!name || !choice) return { ok: false };
    const key = name.toLowerCase();
    const record = profileRecord(request, accounts[key]);
    if (choice === 'show') record.exclusionReason = request.exclusionReason === 'following' ? 'following' : 'manual';
    accounts[key] = record;
    if (choice === 'default') delete visibility[key];
    else visibility[key] = choice;
    await store.set({ [Keys.accounts]: accounts, [Keys.visibility]: visibility });
    return { ok: true, visibility: choice };
  }).catch(() => ({ ok: false }));
}

function rememberRelationship(request) {
  return withProfileData(async (accounts, visibility) => {
    const name = screenNameFrom(request.screenName);
    if (!name || typeof request.following !== 'boolean') return { ok: false };
    const key = name.toLowerCase();
    const record = accounts[key];
    if (!record || typeof record !== 'object') return { ok: true, recorded: false, restored: false };
    record.following = request.following;
    record.relationshipObservedAt = Date.now();
    const restored = request.following === false && record.exclusionReason === 'following' && visibility[key] === 'show';
    if (restored) {
      delete visibility[key];
      delete record.exclusionReason;
    }
    await store.set({ [Keys.accounts]: accounts, ...(restored ? { [Keys.visibility]: visibility } : {}) });
    return { ok: true, recorded: true, restored };
  }).catch(() => ({ ok: false }));
}

function recordAccountAction(request) {
  return withProfileData(async accounts => {
    const name = screenNameFrom(request.screenName);
    const action = ['block', 'unblock'].includes(request.action) ? request.action : '';
    if (!name || !action) return;
    const record = accounts[name.toLowerCase()];
    if (!record) return;
    if (request.ok === true) record.blocked = action === 'block';
    Object.assign(record, {
      lastAction: Date.now(), lastActionOk: request.ok === true,
      lastActionStatus: Number.isFinite(request.status) ? request.status : 0
    });
    if (Number.isFinite(request.rateLimitLimit)) record.actionRateLimit = request.rateLimitLimit;
    if (Number.isFinite(request.rateLimitRemaining)) record.actionRateRemaining = request.rateLimitRemaining;
    if (Number.isFinite(request.rateLimitResetAt)) record.actionRateResetAt = request.rateLimitResetAt;
    await store.set({ [Keys.accounts]: accounts });
    note('account-action', { screenName: name, action, source: request.source || 'unknown', ok: request.ok, status: request.status });
  }).catch(() => {});
}
