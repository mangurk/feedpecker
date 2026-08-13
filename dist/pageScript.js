(() => {
  'use strict';

  if (window.__feedpeckerPageAdapterV2) return;
  window.__feedpeckerPageAdapterV2 = true;

  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  const OPERATION_RE = /^[A-Za-z0-9_-]{8,128}$/;
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
  const HEADER_ALLOWLIST = new Set([
    'authorization',
    'x-csrf-token',
    'x-twitter-active-user',
    'x-twitter-auth-type',
    'x-twitter-client-language',
    'accept',
    'content-type'
  ]);
  const KNOWN_OPERATIONS = ['zs_jFPFT78rBpXv9Z3U2YQ', 'XRqGa7EeokUU5kppkh13EA', 'GsbGOVoqyItTRx7Cr4owgQ'];
  const PUBLIC_WEB_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const PASSIVE_SKIP_KEYS = new Set([
    'birdwatch_pivot', 'card', 'entities', 'extended_entities', 'features',
    'media', 'mediaStats', 'promoted_content', 'tombstone'
  ]);

  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrDetails = new WeakMap();

  const session = {
    bridgeId: crypto.randomUUID(),
    port: null,
    pending: [],
    bridgeAttempts: 0,
    bridgeTimer: null,
    operationId: null,
    operationIsObserved: false,
    rejectedOperations: new Set(),
    operationSearch: null,
    headers: Object.create(null),
    authWaiters: new Set()
  };

  function validOperation(value) {
    return OPERATION_RE.test(String(value || ''));
  }

  function cleanHandle(value) {
    const handle = String(value || '').trim().replace(/^@/, '');
    if (!HANDLE_RE.test(handle) || RESERVED_NAMES.has(handle.toLowerCase())) return null;
    return handle;
  }

  function send(type, fields = {}) {
    const message = { type, ...fields };
    if (session.port) {
      session.port.postMessage(message);
    } else if (session.pending.length < 80) {
      session.pending.push(message);
    }
  }

  function log(event, details) {
    console.info('[Feedpecker][page]', event, details ?? '');
    send('__debugLog', { source: 'page', event, details });
  }

  function readCookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    for (const part of document.cookie.split(';')) {
      const item = part.trim();
      if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
    }
    return null;
  }

  function absorbHeaders(input) {
    if (!input) return;
    try {
      new Headers(input).forEach((value, name) => {
        const key = name.toLowerCase();
        if (HEADER_ALLOWLIST.has(key) && typeof value === 'string' && value.length <= 4096) {
          session.headers[key] = value;
        }
      });
    } catch (_) {
      return;
    }

    if (hasSessionAuth()) {
      for (const resolve of session.authWaiters) resolve();
      session.authWaiters.clear();
    }
  }

  function hasSessionAuth() {
    return Boolean((session.headers.authorization || PUBLIC_WEB_BEARER) && (session.headers['x-csrf-token'] || readCookie('ct0')));
  }

  function requestHeaders() {
    const headers = { ...session.headers };
    headers.authorization ||= PUBLIC_WEB_BEARER;
    headers['x-csrf-token'] = readCookie('ct0') || headers['x-csrf-token'] || '';
    headers['x-twitter-active-user'] ||= 'yes';
    headers['x-twitter-auth-type'] ||= 'OAuth2Session';
    headers['x-twitter-client-language'] ||= document.documentElement.lang?.split('-')[0] || 'en';
    headers.accept ||= 'application/json';
    headers['content-type'] ||= 'application/json';
    return headers;
  }

  async function waitForAuth(timeoutMs = 3000) {
    if (hasSessionAuth()) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        session.authWaiters.delete(done);
        resolve();
      }, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      session.authWaiters.add(done);
    });
  }

  function queryOperationFromUrl(url) {
    const text = String(url || '');
    if (!text.includes('AboutAccount') || !text.includes('/graphql/')) return null;
    const candidate = text.match(/\/graphql\/([A-Za-z0-9_-]+)\//)?.[1];
    return validOperation(candidate) ? candidate : null;
  }

  function queryOperationFromSource(source) {
    if (typeof source !== 'string' || !source.includes('AboutAccountQuery')) return null;
    const patterns = [
      /queryId\s*:\s*["']([A-Za-z0-9_-]+)["'][\s\S]{0,180}AboutAccountQuery/,
      /AboutAccountQuery[\s\S]{0,180}queryId\s*:\s*["']([A-Za-z0-9_-]+)["']/,
      /\/graphql\/([A-Za-z0-9_-]+)\/AboutAccountQuery/
    ];
    for (const pattern of patterns) {
      const candidate = source.match(pattern)?.[1];
      if (validOperation(candidate)) return candidate;
    }
    return null;
  }

  function rememberOperation(candidate, observed = true) {
    if (!validOperation(candidate) || session.rejectedOperations.has(candidate)) return false;
    session.operationId = candidate;
    session.operationIsObserved ||= observed;
    return true;
  }

  function inspectWebpackChunks() {
    const chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks)) return null;
    for (const chunk of chunks) {
      const modules = chunk?.[1];
      if (!modules || typeof modules !== 'object') continue;
      for (const factory of Object.values(modules)) {
        const candidate = queryOperationFromSource(typeof factory === 'function' ? Function.prototype.toString.call(factory) : '');
        if (candidate) return candidate;
      }
    }
    return null;
  }

  async function locateOperation() {
    if (session.operationId && !session.rejectedOperations.has(session.operationId)) return session.operationId;
    if (session.operationSearch) return session.operationSearch;

    session.operationSearch = Promise.resolve().then(() => {
      for (const entry of performance.getEntriesByType('resource')) {
        const candidate = queryOperationFromUrl(entry.name);
        if (candidate) return candidate;
      }
      for (const script of document.scripts) {
        if (!script.src) {
          const candidate = queryOperationFromSource(script.textContent || '');
          if (candidate) return candidate;
        }
      }
      return inspectWebpackChunks() || KNOWN_OPERATIONS.find(id => !session.rejectedOperations.has(id)) || KNOWN_OPERATIONS[0];
    }).then(candidate => {
      rememberOperation(candidate, !KNOWN_OPERATIONS.includes(candidate));
      return session.operationId;
    }).finally(() => {
      session.operationSearch = null;
    });

    return session.operationSearch;
  }

  function followingValue(node, legacy = node?.legacy) {
    const options = [
      node?.relationship_perspectives?.following,
      node?.relationship_perspective?.following,
      node?.following,
      legacy?.following
    ];
    return options.find(value => typeof value === 'boolean') ?? null;
  }

  function aboutProfile(node) {
    if (!node || typeof node !== 'object') return null;
    const direct = node.about_profile || node.aboutProfile;
    if (direct && typeof direct === 'object') return direct;
    const moduleProfile = node.aboutModule?.about_profile || node.aboutModule?.aboutProfile;
    return moduleProfile && typeof moduleProfile === 'object' ? moduleProfile : null;
  }

  function aboutResult(payload) {
    return payload?.data?.user_result_by_screen_name?.result ||
      payload?.data?.user_result?.result ||
      payload?.data?.user?.result ||
      payload?.data?.about_account?.result ||
      null;
  }

  function normalizeUser(node, fallbackHandle = null) {
    if (!node || typeof node !== 'object') return null;
    const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : null;
    const core = node.core && typeof node.core === 'object' ? node.core : null;
    const profile = aboutProfile(node);
    const handle = cleanHandle(node.screen_name || core?.screen_name || legacy?.screen_name || fallbackHandle);
    if (!handle) return null;
    const location = profile?.account_based_in || profile?.accountBasedIn || node.location || legacy?.location || null;
    const resemblesUser = Boolean(node.__typename === 'User' || node.rest_id || legacy || profile || location);
    if (!resemblesUser) return null;
    return {
      screen_name: handle,
      location,
      verified: Boolean(
        node.verified || node.is_blue_verified || legacy?.verified || legacy?.is_blue_verified ||
        legacy?.verified_type || node.verification_info?.is_identity_verified
      ),
      following: followingValue(node, legacy),
      utc_offset: node.utc_offset ?? legacy?.utc_offset ?? null,
      time_zone: node.time_zone ?? legacy?.time_zone ?? null,
      is_region: (profile?.location_accurate ?? profile?.locationAccurate) === false
    };
  }

  function mergeUserRecords(primary, fallback) {
    if (!primary) return fallback;
    if (!fallback) return primary;
    return {
      ...fallback,
      ...primary,
      location: primary.location || fallback.location || null,
      verified: primary.verified || fallback.verified,
      following: primary.following ?? fallback.following ?? null,
      utc_offset: primary.utc_offset ?? fallback.utc_offset ?? null,
      time_zone: primary.time_zone ?? fallback.time_zone ?? null,
      is_region: primary.is_region || fallback.is_region
    };
  }

  function collectUsers(payload) {
    const found = new Map();
    if (!payload || typeof payload !== 'object') return found;
    const pending = [payload];
    const visited = new WeakSet();
    let inspected = 0;

    while (pending.length && inspected < 50000) {
      const value = pending.pop();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      inspected += 1;

      const user = normalizeUser(value);
      if (user && !found.has(user.screen_name.toLowerCase())) found.set(user.screen_name.toLowerCase(), user);

      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') pending.push(child);
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (!PASSIVE_SKIP_KEYS.has(key) && child && typeof child === 'object') pending.push(child);
        }
      }
    }
    return found;
  }

  function publishPassive(payload) {
    const work = () => {
      const users = [...collectUsers(payload).values()];
      if (users.length) send('__passiveData', { users });
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(work, { timeout: 800 });
    else setTimeout(work, 0);
  }

  function inspectJsonResponse(response) {
    response.clone().json().then(publishPassive).catch(() => {});
  }

  function observeUrl(url) {
    const candidate = queryOperationFromUrl(url);
    if (candidate) rememberOperation(candidate);
  }

  window.fetch = async function(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    observeUrl(url);
    if (url.includes('/i/api/') || url.includes('/1.1/')) {
      absorbHeaders(input instanceof Request ? input.headers : null);
      absorbHeaders(init?.headers);
    }
    const response = await nativeFetch.apply(this, arguments);
    if (url.includes('/i/api/graphql') || url.includes('/1.1/')) inspectJsonResponse(response);
    return response;
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    xhrDetails.set(this, { url: String(url || ''), headers: Object.create(null) });
    observeUrl(url);
    this.addEventListener('load', () => {
      const details = xhrDetails.get(this);
      if (!details?.url || (!details.url.includes('/i/api/graphql') && !details.url.includes('/1.1/'))) return;
      try { publishPassive(JSON.parse(this.responseText)); } catch (_) {}
    }, { once: true });
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const details = xhrDetails.get(this);
    if (details) details.headers[name] = value;
    return nativeSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const details = xhrDetails.get(this);
    if (details?.url.includes('/i/api/')) absorbHeaders(details.headers);
    return nativeSend.apply(this, arguments);
  };

  function numericHeader(response, name) {
    const value = Number.parseInt(response.headers.get(name) || '', 10);
    return Number.isFinite(value) ? value : null;
  }

  function rateWindow(response) {
    return {
      limit: numericHeader(response, 'x-rate-limit-limit'),
      remaining: numericHeader(response, 'x-rate-limit-remaining'),
      resetTime: numericHeader(response, 'x-rate-limit-reset'),
      rateLimited: response.status === 429
    };
  }

  function publishLookupRate(response) {
    const rate = rateWindow(response);
    if (rate.limit !== null || rate.remaining !== null || rate.resetTime !== null || rate.rateLimited) {
      if (rate.rateLimited && rate.resetTime === null) rate.resetTime = Math.floor(Date.now() / 1000) + 60;
      send('__rateLimitInfo', rate);
    }
    return rate;
  }

  async function timedFetch(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await nativeFetch.call(window, url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function lookupFailure(screenName, requestId, failure, extras = {}) {
    send('__userDataResponse', {
      screenName,
      requestId,
      location: null,
      verified: false,
      failure,
      ...extras
    });
  }

  async function requestAboutAccount(screenName) {
    const operationId = await locateOperation();
    const variables = encodeURIComponent(JSON.stringify({ screenName }));
    const url = `${location.origin}/i/api/graphql/${operationId}/AboutAccountQuery?variables=${variables}`;
    const profileReferrer = `${location.origin}/${encodeURIComponent(screenName)}/about`;
    return timedFetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: requestHeaders(),
      referrer: profileReferrer,
      referrerPolicy: 'origin-when-cross-origin'
    }, 5000);
  }

  async function handleLookup(message) {
    const screenName = cleanHandle(message.screenName);
    const requestId = String(message.requestId || '');
    if (!screenName || !UUID_V4_RE.test(requestId)) {
      lookupFailure(screenName || '', requestId, 'invalid-request');
      return;
    }

    await waitForAuth();
    try {
      let payload = null;
      let normalized = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const operationId = await locateOperation();
        const response = await requestAboutAccount(screenName);
        const rate = publishLookupRate(response);
        if (!response.ok) {
          if (attempt === 0 && (response.status === 400 || response.status === 404)) {
            session.rejectedOperations.add(operationId);
            session.operationId = null;
            session.operationIsObserved = false;
            continue;
          }
          lookupFailure(screenName, requestId, `http-${response.status}`, {
            isRateLimited: rate.rateLimited,
            retryable: !rate.rateLimited
          });
          return;
        }

        payload = await response.json();
        publishPassive(payload);
        const direct = aboutResult(payload);
        const directUser = normalizeUser(direct, screenName);
        const nestedUser = collectUsers(payload).get(screenName.toLowerCase()) || null;
        normalized = mergeUserRecords(directUser, nestedUser);
        if (normalized) break;

        if (attempt === 0 && !session.operationIsObserved) {
          log('about-account-operation-stale', { operationId });
          session.rejectedOperations.add(operationId);
          session.operationId = null;
          continue;
        }
        break;
      }

      if (!normalized) {
        log('about-account-parse-failed', {
          hasData: Boolean(payload?.data),
          errorCount: Array.isArray(payload?.errors) ? payload.errors.length : 0
        });
        lookupFailure(screenName, requestId, 'parse-error', { retryable: true });
        return;
      }

      send('__userDataResponse', {
        screenName,
        requestId,
        location: normalized.location,
        verified: normalized.verified,
        following: normalized.following,
        is_region: normalized.is_region,
        confirmed: true
      });
    } catch (error) {
      lookupFailure(screenName, requestId, error?.name === 'AbortError' ? 'request-timeout' : 'network-error', { retryable: true });
    }
  }

  async function handleAccountAction(message) {
    const screenName = cleanHandle(message.screenName);
    const action = message.type === '__unblockUser' ? 'unblock' : 'block';
    const actionId = String(message.actionId || '').slice(0, 80);
    const source = message.source === 'manual' ? 'manual' : 'auto';
    if (!screenName) {
      send('__accountActionResult', { actionId, screenName: '', action, source, ok: false, status: 400 });
      return;
    }

    await waitForAuth();
    try {
      const verb = action === 'block' ? 'create' : 'destroy';
      const response = await timedFetch(
        `https://api.x.com/1.1/blocks/${verb}.json?screen_name=${encodeURIComponent(screenName)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: requestHeaders(),
          referrerPolicy: 'origin-when-cross-origin'
        },
        8000
      );
      const rate = rateWindow(response);
      send('__accountActionResult', {
        actionId,
        screenName,
        action,
        source,
        ok: response.ok,
        status: response.status,
        rateLimitLimit: rate.limit,
        rateLimitRemaining: rate.remaining,
        rateLimitResetAt: rate.resetTime === null ? null : rate.resetTime * 1000
      });
    } catch (error) {
      log('account-action-failed', { screenName, action, error: error?.message || String(error) });
      send('__accountActionResult', { actionId, screenName, action, source, ok: false, status: 0 });
    }
  }

  async function acceptBridgeMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === '__fetchUserData') {
      await handleLookup(message);
      return;
    }
    if (message.type === '__blockUser' || message.type === '__unblockUser') {
      await handleAccountAction(message);
    }
  }

  function askForBridge() {
    if (session.port || session.bridgeAttempts >= 100) {
      if (session.bridgeTimer) clearInterval(session.bridgeTimer);
      session.bridgeTimer = null;
      return;
    }
    session.bridgeAttempts += 1;
    window.postMessage({
      target: 'contentScript',
      type: '__feedpeckerBridgeRequest',
      bridgeId: session.bridgeId
    }, location.origin);
  }

  window.addEventListener('message', event => {
    if (
      session.port || event.source !== window || event.origin !== location.origin ||
      event.data?.target !== 'pageScript' || event.data?.type !== '__feedpeckerBridgeInit' ||
      event.data?.bridgeId !== session.bridgeId || event.ports?.length !== 1
    ) return;

    session.port = event.ports[0];
    session.port.onmessage = portEvent => {
      acceptBridgeMessage(portEvent.data).catch(error => log('bridge-message-failed', error?.message || String(error)));
    };
    session.port.start?.();
    session.port.postMessage({ type: '__bridgeReady' });
    for (const queued of session.pending.splice(0)) session.port.postMessage(queued);
    if (session.bridgeTimer) clearInterval(session.bridgeTimer);
    session.bridgeTimer = null;
  });

  askForBridge();
  session.bridgeTimer = setInterval(askForBridge, 100);
})();
