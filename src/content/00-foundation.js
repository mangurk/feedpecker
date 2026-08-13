// ─────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────
// Personal build: location lookups stay on X and are cached only in this browser.
const EXPIRY_DAYS       = 30;
const STALE_WINDOW_DAYS = 90;
const EXPIRY_EMPTY_DAYS = 14;
const LOCATION_RESULT_VERSION = 1;
const STORE_LIMIT       = 5000;
const MEMORY_CACHE_LIMIT = 500;
const TRANSIENT_MISS_TTL = 3_000;        // Brief retry delay for timeouts and temporary X failures
const MAX_LOOKUP_QUEUE  = 40;            // Bound queued/in-flight lookups during very fast scrolling
const MAX_VISIBLE_RETRIES = 2;           // One initial attempt plus two bounded retries while still visible
const DRAIN_INTERVAL    = 30;            // ms – micro-batch MutationObserver events
const TWITTER_PARALLEL  = 1;              // One at a time - hide has no urgency
const TWITTER_STAGGER_MS = 1000;          // Pace visible lookups without creating a burst
const LAZY_DELAY_MS     = 180;            // Only inspect profiles that actually enter the viewport
const PASSIVE_WAIT_MS   = 300;            // Give passive timeline data a brief chance to arrive
const LOOKUP_RESPONSE_TIMEOUT_MS = 12_000; // Covers header discovery plus one X request/retry
const LOOKUP_DIAGNOSTIC_FLUSH_MS = 10_000;
const LOOKUP_TOAST_THRESHOLD = 20;
const LOOKUP_RESET_WARNING_MS = 60_000;
const TOAST_VISIBLE_MS = 6_500;
const TOAST_LEAVE_GRACE_MS = 1_500;
const ACCOUNT_ACTION_NORMAL_DELAY_MS = 2500;
const ACCOUNT_ACTION_RESULT_TIMEOUT_MS = 15_000;
const MAX_ACCOUNT_ACTION_QUEUE = 500;
const FOLLOWING_STATE_TTL_MS = 10 * 60 * 1000;
const FOLLOWING_STATE_LIMIT = 2000;
const FILTERED_ACCOUNTS_KEY = 'filtered_accounts';
const PROFILE_VISIBILITY_OVERRIDES_KEY = 'profile_visibility_overrides';
const BLOCKED_COUNTRIES_KEY = 'blocked_countries';
const CLOCK_TICK_MS     = 60_000;        // local-time refresh interval
const COUNTRY_TOTAL     = 195;
const NEGATIVE_MAP_CAP  = 2000;          // max negative cache entries
const SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const ELEMENT_SELECTORS =
  'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]';

function cleanScreenName(value) {
  const screenName = String(value || '').replace(/^@/, '').trim();
  return SCREEN_NAME_PATTERN.test(screenName) && !RESERVED_OBJECT_KEYS.has(screenName.toLowerCase()) ? screenName : '';
}

// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────
let enabled         = true;
let filteredRegions = [];
let onlyVerified    = false;
let autoFilter      = false;
let alwaysLoadComments = false;
let toastNotificationsEnabled = true;
let hideAnimationEnabled = true;
let rateLimitUntil  = 0;
let lookupBudgetResetAt = 0;

// Queues / flags
let twitterBusy     = false;

const dataMap          = new Map();  // screenName → { location, verified, timezone, expiry }
const negativeMap      = new Map();  // screenName → expiryTs
const flightMap        = new Map();  // screenName → Promise  (dedup concurrent fetches)
const twitterPending   = [];         // { screenName, resolve, reject }
let   watcherRef       = null;       // MutationObserver handle

// Visibility queue
let   watched    = new WeakSet();
const lazyTimers = new WeakMap();  // element → setTimeout id (scroll debounce)
const retryTimers = new WeakMap(); // element → setTimeout id (temporary lookup failures)
const visibleElements = new Set();
const hiddenArticleStates = new WeakMap();
const directLookupDemand = new Map(); // screenName → Set of transient visible surfaces
const viewport   = new IntersectionObserver(onVisible, { rootMargin: '100px 0px 160px 0px' });
let warningToastTimer = null;
let warningToastElement = null;
let warningToastShownAt = 0;
let warningToastClickGuardUntil = 0;
let lookupResetToastTimer = null;
let lookupDiagnosticTimer = null;
const lookupDiagnosticCounts = new Map();
let filteredAccounts = new Map();
let profileVisibilityOverrides = new Map();
let profileControlScanTimer = null;
let profileControlScanRunning = false;
let profileControlScanAgain = false;
const hoverCardRetryTimers = new WeakMap();
const accountActionQueue = [];
const accountActionKeys = new Set();
const followingStates = new Map();
const followingExclusionPromises = new Map();
const followingRestorePromises = new Map();
let accountActionBusy = false;
let accountActionWakeTimer = null;
let accountActionResultTimer = null;
let currentAccountAction = null;
let accountActionSequence = 0;
let accountActionFallbackNextAt = 0;

// Private MessageChannel bridge to the MAIN-world page integration. Only the
// one-time handshake uses window messaging; account data and actions stay on
// the transferred port instead of accepting commands from arbitrary page code.
let pageBridgePort = null;
let resolvePageBridge = null;
let pendingBridge = null;
const pageBridgeListeners = new Set();
const pageBridgeReady = new Promise(resolve => { resolvePageBridge = resolve; });

function dispatchPageBridgeMessage(data) {
  if (!data || typeof data !== 'object') return;
  for (const listener of pageBridgeListeners) {
    try { listener(data); } catch (_) {}
  }
}

function sendToPage(message) {
  return pageBridgeReady.then(port => {
    port.postMessage(message);
    return port;
  });
}

window.addEventListener('message', event => {
  const request = event.data;
  if (
    pageBridgePort || pendingBridge ||
    event.source !== window ||
    event.origin !== window.location.origin ||
    request?.target !== 'contentScript' ||
    request?.type !== '__feedpeckerBridgeRequest' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(request.bridgeId || ''))
  ) return;

  const channel = new MessageChannel();
  const candidate = channel.port1;
  pendingBridge = candidate;

  const timeout = setTimeout(() => {
    if (pageBridgePort || pendingBridge !== candidate) return;
    candidate.close();
    pendingBridge = null;
  }, 1000);

  candidate.onmessage = bridgeEvent => {
    if (bridgeEvent.data?.type !== '__bridgeReady' || pageBridgePort) return;
    clearTimeout(timeout);
    pageBridgePort = candidate;
    pendingBridge = null;
    pageBridgePort.onmessage = eventFromPage => dispatchPageBridgeMessage(eventFromPage.data);
    pageBridgePort.start?.();
    resolvePageBridge(pageBridgePort);
    debugLog('bridge-ready');
  };
  candidate.start?.();

  window.postMessage({
    target: 'pageScript',
    type: '__feedpeckerBridgeInit',
    bridgeId: request.bridgeId
  }, window.location.origin, [channel.port2]);
});

// Tooltip
let tip = null;

// ─────────────────────────────────────────────────────────────
//  Storage adapter (Chrome / Firefox)
// ─────────────────────────────────────────────────────────────
function gone() { return !chrome.runtime?.id; }

function debugLog(event, details, source = 'feed') {
  console.info(`[Feedpecker][${source}]`, event, details ?? '');
  try {
    const result = chrome.runtime.sendMessage({ type: 'debugLog', source, event, details });
    result?.catch?.(() => {});
  } catch (_) {}
}
