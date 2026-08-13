const CACHE_DATABASE = Object.freeze({ name: 'TwitterLocationCacheDB', store: 'locations', version: 7 });
let cacheDatabasePromise;

function getDB() {
  if (cacheDatabasePromise) return cacheDatabasePromise;
  cacheDatabasePromise = new Promise((resolve, reject) => {
    const opening = indexedDB.open(CACHE_DATABASE.name, CACHE_DATABASE.version);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => resolve(opening.result);
    opening.onupgradeneeded = event => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(CACHE_DATABASE.store)) {
        database.createObjectStore(CACHE_DATABASE.store, { keyPath: 'username' });
        return;
      }
      if (event.oldVersion >= CACHE_DATABASE.version) return;
      const cursor = opening.transaction.objectStore(CACHE_DATABASE.store).openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (cursor.result.value?.location === null) cursor.result.delete();
        cursor.result.continue();
      };
    };
  });
  return cacheDatabasePromise;
}

async function cacheTransaction(mode, work) {
  const database = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_DATABASE.store, mode);
    const objectStore = transaction.objectStore(CACHE_DATABASE.store);
    let result;
    try { result = work(objectStore, transaction); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestResult(request, fallback = null) {
  return new Promise(resolve => {
    request.onsuccess = () => resolve(request.result ?? fallback);
    request.onerror = () => resolve(fallback);
  });
}

async function dbGet(username) {
  try {
    const database = await getDB();
    const transaction = database.transaction(CACHE_DATABASE.store, 'readonly');
    return await requestResult(transaction.objectStore(CACHE_DATABASE.store).get(String(username).toLowerCase()));
  } catch { return null; }
}

async function dbSet(username, value) {
  try {
    await cacheTransaction('readwrite', objectStore => objectStore.put({ username: String(username).toLowerCase(), ...value }));
  } catch {}
}

async function dbDeleteBatch(usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) return;
  try {
    await cacheTransaction('readwrite', objectStore => {
      for (const username of usernames) objectStore.delete(String(username).toLowerCase());
    });
  } catch {}
}

async function dbClear() {
  try { await cacheTransaction('readwrite', objectStore => objectStore.clear()); } catch {}
}

async function dbExportAll() {
  try {
    const database = await getDB();
    const transaction = database.transaction(CACHE_DATABASE.store, 'readonly');
    const entries = await requestResult(transaction.objectStore(CACHE_DATABASE.store).getAll(), []);
    return Array.isArray(entries) ? entries : [];
  } catch { return []; }
}

function portableCacheEntry(entry) {
  const username = cleanScreenName(entry?.username).toLowerCase();
  if (!username || !Number.isFinite(entry?.expiry)) return null;
  return {
    username,
    location: typeof entry.location === 'string' ? entry.location.slice(0, 160) : null,
    verified: entry.verified === true,
    timezone: typeof entry.timezone === 'string' ? entry.timezone.slice(0, 100) : null,
    isRegion: entry.isRegion === true,
    resultVersion: Number(entry.resultVersion) || 0,
    expiry: entry.expiry
  };
}

async function dbReplaceAll(entries) {
  const replacements = (Array.isArray(entries) ? entries : []).slice(0, STORE_LIMIT).map(portableCacheEntry).filter(Boolean);
  await cacheTransaction('readwrite', objectStore => {
    objectStore.clear();
    for (const entry of replacements) objectStore.put(entry);
  });
  dataMap.clear();
  negativeMap.clear();
  return replacements.length;
}

async function hydrate() {
  try {
    const entries = await dbExportAll();
    const staleBefore = Date.now() - STALE_WINDOW_DAYS * 86_400_000;
    await dbDeleteBatch(entries.filter(entry => Number(entry.expiry) <= staleBefore).map(entry => entry.username));
  } catch {}
}

function record(username, location, verified = false, apiTimezone = null, isRegion = false, confirmed = false) {
  if (gone()) return;
  const screenName = cleanScreenName(username);
  if (!screenName) return;
  const key = screenName.toLowerCase();
  const proposedLocation = typeof location === 'string' ? location.slice(0, 160) : null;
  if (proposedLocation === null && !confirmed) return;
  const proposedTimezone = typeof apiTimezone === 'string' ? apiTimezone.slice(0, 100) : null;
  const old = dataMap.get(key);
  const preserveOld = old && proposedLocation && !isSupportedOrigin(proposedLocation)
    && (old.location === null || isSupportedOrigin(old.location));
  const finalLocation = preserveOld ? old.location : proposedLocation;
  const entry = {
    location: finalLocation,
    verified: verified === true || old?.verified === true,
    timezone: (finalLocation ? resolveTimezone(finalLocation) : null) || (preserveOld ? old?.timezone : proposedTimezone) || null,
    isRegion: preserveOld ? old?.isRegion === true : isRegion === true,
    resultVersion: LOCATION_RESULT_VERSION,
    expiry: Date.now() + (finalLocation === null ? EXPIRY_EMPTY_DAYS : EXPIRY_DAYS) * 86_400_000
  };
  dataMap.set(key, entry);
  dbSet(key, entry);
  evict();
}

function evict() {
  const now = Date.now();
  for (const [key, entry] of dataMap) if (entry.expiry <= now) dataMap.delete(key);
  for (const key of dataMap.keys()) {
    if (dataMap.size <= MEMORY_CACHE_LIMIT) break;
    dataMap.delete(key);
  }
}
