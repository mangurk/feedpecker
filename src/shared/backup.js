var FeedpeckerBackup = (() => {
  'use strict';

  const FORMAT = 'feedpecker-backup';
  const VERSION = 1;
  const MAX_PROFILES = 50_000;
  const MAX_CACHE_ROWS = 5_000;
  const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const BOOLEAN_SETTINGS = Object.freeze([
    'extension_enabled', 'verified_only_mode', 'auto_block_mode',
    'always_load_comments', 'toast_notifications', 'hide_animation'
  ]);
  const PORTABLE_STORAGE_KEYS = Object.freeze([
    ...BOOLEAN_SETTINGS,
    'blocked_countries', 'extension_stats', 'filtered_accounts', 'profile_visibility_overrides'
  ]);
  const DAILY_STAT_FIELDS = Object.freeze([
    'scannedByDay', 'hiddenByDay', 'blockedByDay', 'profilesByDay', 'newFilteredByDay'
  ]);
  const { storage, tabs } = globalThis.feedpeckerWebExt;

  function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedText(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }

  function safeNumber(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function safeHandle(value) {
    const handle = boundedText(value, 16).replace(/^@/, '');
    return HANDLE_PATTERN.test(handle) && !FORBIDDEN_KEYS.has(handle.toLowerCase()) ? handle : '';
  }

  function copyJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cleanCounterMap(value, { limit, keyPattern } = {}) {
    const result = Object.create(null);
    if (!plainObject(value)) return result;
    let accepted = 0;
    for (const [rawKey, rawCount] of Object.entries(value)) {
      if (accepted >= (limit || 250)) break;
      const key = boundedText(rawKey, 100);
      if (!key || FORBIDDEN_KEYS.has(key) || (keyPattern && !keyPattern.test(key))) continue;
      result[key] = safeNumber(rawCount);
      accepted += 1;
    }
    return result;
  }

  function cleanStats(value) {
    if (!plainObject(value)) return {};
    const stats = {
      hiddenPosts: safeNumber(value.hiddenPosts),
      blockedAccounts: safeNumber(value.blockedAccounts),
      seenCountries: cleanCounterMap(value.seenCountries, { limit: 250 }),
      totalScanned: safeNumber(value.totalScanned),
      newFilteredProfiles: safeNumber(value.newFilteredProfiles)
    };
    for (const field of DAILY_STAT_FIELDS) {
      stats[field] = cleanCounterMap(value[field], { limit: 370, keyPattern: /^\d{4}-\d{2}-\d{2}$/ });
    }
    return stats;
  }

  function cleanProfiles(value) {
    const result = Object.create(null);
    if (!plainObject(value)) return result;
    let accepted = 0;
    for (const candidate of Object.values(value)) {
      if (accepted >= MAX_PROFILES) break;
      if (!plainObject(candidate)) continue;
      const screenName = safeHandle(candidate.screenName);
      if (!screenName) continue;
      const profile = {
        screenName,
        location: boundedText(candidate.location, 160),
        country: boundedText(candidate.country, 100),
        verified: candidate.verified === true,
        blocked: candidate.blocked === true,
        lastSeen: safeNumber(candidate.lastSeen)
      };
      if (typeof candidate.following === 'boolean') {
        profile.following = candidate.following;
        profile.relationshipObservedAt = safeNumber(candidate.relationshipObservedAt);
      }
      if (candidate.exclusionReason === 'following' || candidate.exclusionReason === 'manual') {
        profile.exclusionReason = candidate.exclusionReason;
      }
      result[screenName.toLowerCase()] = profile;
      accepted += 1;
    }
    return result;
  }

  function cleanOverrides(value) {
    const result = Object.create(null);
    if (!plainObject(value)) return result;
    let accepted = 0;
    for (const [rawHandle, visibility] of Object.entries(value)) {
      if (accepted >= MAX_PROFILES) break;
      const handle = safeHandle(rawHandle);
      if (!handle || (visibility !== 'hide' && visibility !== 'show')) continue;
      result[handle.toLowerCase()] = visibility;
      accepted += 1;
    }
    return result;
  }

  function cleanStorage(value) {
    if (!plainObject(value)) return {};
    const result = {};
    for (const key of BOOLEAN_SETTINGS) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (Array.isArray(value.blocked_countries)) {
      result.blocked_countries = [...new Set(value.blocked_countries
        .map(item => boundedText(item, 100))
        .filter(Boolean))].slice(0, 250);
    }
    if (plainObject(value.extension_stats)) result.extension_stats = cleanStats(value.extension_stats);
    if (plainObject(value.filtered_accounts)) result.filtered_accounts = cleanProfiles(value.filtered_accounts);
    if (plainObject(value.profile_visibility_overrides)) {
      result.profile_visibility_overrides = cleanOverrides(value.profile_visibility_overrides);
    }
    return result;
  }

  function cleanLocationCache(value) {
    if (!Array.isArray(value)) return [];
    const rows = [];
    for (const candidate of value) {
      if (rows.length >= MAX_CACHE_ROWS) break;
      if (!plainObject(candidate)) continue;
      const username = safeHandle(candidate.username);
      if (!username || !Number.isFinite(candidate.expiry)) continue;
      rows.push({
        username: username.toLowerCase(),
        location: typeof candidate.location === 'string' ? candidate.location.slice(0, 160) : null,
        verified: candidate.verified === true,
        timezone: typeof candidate.timezone === 'string' ? candidate.timezone.slice(0, 100) : null,
        isRegion: candidate.isRegion === true,
        resultVersion: safeNumber(candidate.resultVersion),
        expiry: candidate.expiry
      });
    }
    return rows;
  }

  function validateBackup(input) {
    if (!plainObject(input) || !Number.isInteger(input.version)) throw new Error('This is not a Feedpecker backup file.');
    const storageLooksPortable = plainObject(input.storage) && PORTABLE_STORAGE_KEYS.some(key => key in input.storage);
    if (input.format !== FORMAT && !(input.version === 1 && storageLooksPortable)) {
      throw new Error('This is not a Feedpecker backup file.');
    }
    if (input.version > VERSION) throw new Error('This backup was created by a newer extension version.');
    if (!plainObject(input.storage)) throw new Error('The backup does not contain restorable extension data.');
    return { storage: cleanStorage(input.storage), locationCache: cleanLocationCache(input.locationCache) };
  }

  async function portableStorageSnapshot() {
    const stored = await storage.get(PORTABLE_STORAGE_KEYS);
    return Object.fromEntries(PORTABLE_STORAGE_KEYS
      .filter(key => Object.prototype.hasOwnProperty.call(stored, key))
      .map(key => [key, copyJson(stored[key])]));
  }

  async function xTabs() {
    return tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  }

  async function askXTab(message, accept) {
    for (const tab of await xTabs()) {
      if (!tab?.id) continue;
      try {
        const response = await tabs.sendMessage(tab.id, message);
        if (accept(response)) return response;
      } catch (_) {}
    }
    return null;
  }

  async function exportLocationCache() {
    const response = await askXTab({ type: 'exportLocationCache' }, value => value?.ok && Array.isArray(value.entries));
    return response
      ? { ok: true, entries: response.entries, count: response.entries.length }
      : { ok: false, entries: [], count: 0, reason: 'Open or refresh an X tab to include the lookup cache.' };
  }

  async function importLocationCache(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true, count: 0 };
    const response = await askXTab({ type: 'importLocationCache', entries }, value => value?.ok === true);
    return response
      ? { ok: true, count: safeNumber(response.count) }
      : { ok: false, count: 0, reason: 'Core data restored, but the lookup cache needs an open, refreshed X tab.' };
  }

  async function createBackup() {
    const [stored, cache] = await Promise.all([portableStorageSnapshot(), exportLocationCache()]);
    return {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      extensionVersion: chrome.runtime?.getManifest?.().version || '',
      storage: stored,
      locationCache: cache.ok ? cache.entries : [],
      cacheIncluded: cache.ok,
      cacheEntryCount: cache.ok ? cache.count : 0
    };
  }

  async function restoreBackup(input) {
    const clean = validateBackup(input);
    await storage.remove(PORTABLE_STORAGE_KEYS);
    await storage.set(clean.storage);
    const cache = await importLocationCache(clean.locationCache);
    return { storageKeys: Object.keys(clean.storage).length, cache };
  }

  function download(name, type, contents) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const anchor = document.createElement('a');
    anchor.download = name;
    anchor.href = url;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return Object.freeze({
    FORMAT,
    VERSION,
    PORTABLE_STORAGE_KEYS,
    getPortableStorage: portableStorageSnapshot,
    exportLocationCache,
    importLocationCache,
    createBackup,
    validateBackup,
    restoreBackup,
    download
  });
})();
