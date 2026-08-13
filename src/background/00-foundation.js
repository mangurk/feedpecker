if (!globalThis.feedpeckerWebExt && typeof importScripts === 'function') importScripts('webext.js');

const platform = globalThis.feedpeckerWebExt;
const store = platform.storage;
const tabApi = platform.tabs;

const Keys = Object.freeze({
  stats: 'extension_stats',
  logs: 'debug_logs',
  accounts: 'filtered_accounts',
  visibility: 'profile_visibility_overrides',
  lookupBudget: 'lookup_budget',
  lookupStatus: 'lookup_status',
  lookupToasts: 'lookup_toast_state',
  actionBudget: 'account_action_budget',
  updates: 'update_status'
});

const settingNames = Object.freeze([
  'extension_enabled', 'blocked_countries', 'verified_only_mode', 'auto_block_mode',
  'always_load_comments', 'toast_notifications', 'hide_animation'
]);

const Limits = Object.freeze({
  historyDays: 370,
  logCount: 300,
  logAge: 24 * 60 * 60 * 1000,
  lookupWindow: 15 * 60 * 1000,
  lookupFallback: 50,
  lookupReserve: 3,
  lookupPaceAt: 20,
  normalLookupDelay: 1000,
  actionReserve: 3,
  actionPaceAt: 10,
  normalActionDelay: 2500,
  actionCooldown: 15 * 60 * 1000
});

const state = {
  settings: null,
  stats: null,
  statsTimer: null,
  updateRequest: null
};

function serialTask() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

const queues = Object.freeze({
  logs: serialTask(),
  profiles: serialTask(),
  lookups: serialTask(),
  lookupStatus: serialTask(),
  toasts: serialTask(),
  actions: serialTask()
});

function ownExtensionSender(sender) {
  return sender?.id === chrome.runtime.id;
}

function xPageSender(sender) {
  if (!ownExtensionSender(sender)) return false;
  try {
    const address = new URL(sender.tab?.url || sender.url || '');
    return address.protocol === 'https:' && ['x.com', 'twitter.com'].includes(address.hostname);
  } catch {
    return false;
  }
}

function screenNameFrom(value) {
  const candidate = String(value ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) return '';
  return ['__proto__', 'prototype', 'constructor'].includes(candidate.toLowerCase()) ? '' : candidate;
}

function boundedText(value, length) {
  return String(value ?? '').trim().slice(0, length);
}

function safeDetails(value) {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json.length <= 4000 ? JSON.parse(json) : `${json.slice(0, 3999)}…`;
  } catch {
    return boundedText(value, 4000);
  }
}

function dayStamp(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function recentDays(values) {
  return Object.fromEntries(Object.entries(values || {}).sort(([a], [b]) => b.localeCompare(a)).slice(0, Limits.historyDays));
}

function emptyStats(source = {}) {
  return {
    hiddenPosts: Number(source.hiddenPosts) || 0,
    blockedAccounts: Number(source.blockedAccounts) || 0,
    seenCountries: source.seenCountries && typeof source.seenCountries === 'object' ? source.seenCountries : {},
    totalScanned: Number(source.totalScanned) || 0,
    scannedByDay: source.scannedByDay && typeof source.scannedByDay === 'object' ? source.scannedByDay : {},
    hiddenByDay: source.hiddenByDay && typeof source.hiddenByDay === 'object' ? source.hiddenByDay : {},
    blockedByDay: source.blockedByDay && typeof source.blockedByDay === 'object' ? source.blockedByDay : {},
    profilesByDay: source.profilesByDay && typeof source.profilesByDay === 'object' ? source.profilesByDay : {},
    newFilteredProfiles: Number(source.newFilteredProfiles) || 0,
    newFilteredByDay: source.newFilteredByDay && typeof source.newFilteredByDay === 'object' ? source.newFilteredByDay : {}
  };
}

function saveStatsSoon() {
  clearTimeout(state.statsTimer);
  state.statsTimer = setTimeout(() => store.set({ [Keys.stats]: state.stats }).catch(() => {}), 1000);
}
