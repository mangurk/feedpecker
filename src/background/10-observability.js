const RELEASE_ENDPOINT = 'https://api.github.com/repos/mangurk/feedpecker/releases/latest';
const UPDATE_CACHE_AGE = 6 * 60 * 60 * 1000;

function versionOrder(left, right) {
  const a = String(left || '').split('.').map(value => Number.parseInt(value, 10) || 0);
  const b = String(right || '').split('.').map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function recordLog(entry) {
  return queues.logs(async () => {
    const saved = await store.get(Keys.logs);
    const cutoff = Date.now() - Limits.logAge;
    const logs = (Array.isArray(saved[Keys.logs]) ? saved[Keys.logs] : [])
      .filter(item => Number.isFinite(Date.parse(item?.time)) && Date.parse(item.time) >= cutoff);
    logs.push({
      source: boundedText(entry.source || 'extension', 40),
      event: boundedText(entry.event || 'event', 100),
      details: safeDetails(entry.details),
      time: new Date().toISOString()
    });
    await store.set({ [Keys.logs]: logs.slice(-Limits.logCount) });
  });
}

function note(event, details) {
  console.info('[Feedpecker][background]', event, details ?? '');
  recordLog({ source: 'background', event, details }).catch(() => {});
}

async function fetchUpdateStatus(force = false) {
  if (state.updateRequest) return state.updateRequest;
  state.updateRequest = (async () => {
    const currentVersion = chrome.runtime.getManifest().version;
    if (!force) {
      const saved = await store.get(Keys.updates);
      const cached = saved[Keys.updates];
      if (cached && Date.now() - Number(cached.checkedAt || 0) < UPDATE_CACHE_AGE) return cached;
    }

    const checkedAt = Date.now();
    try {
      const response = await fetch(RELEASE_ENDPOINT, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 250_000) throw new Error('Release response too large');
      const release = JSON.parse(body);
      const match = String(release?.tag_name || '').match(/^v?(\d+(?:\.\d+){1,3})$/);
      if (!match) throw new Error('Invalid release tag');
      const latestVersion = match[1];
      const asset = Array.isArray(release.assets)
        ? release.assets.find(item => /^feedpecker-v[\d.]+\.zip$/i.test(String(item?.name || '')))
        : null;
      const status = {
        currentVersion,
        latestVersion,
        updateAvailable: versionOrder(latestVersion, currentVersion) > 0,
        releaseName: boundedText(release.name || release.tag_name || `v${latestVersion}`, 160),
        releaseNotes: boundedText(release.body, 12_000),
        releaseUrl: String(release.html_url || 'https://github.com/mangurk/feedpecker/releases/latest'),
        assetUrl: String(asset?.browser_download_url || ''),
        publishedAt: String(release.published_at || ''),
        checkedAt
      };
      await store.set({ [Keys.updates]: status });
      note('update-check', { currentVersion, latestVersion, updateAvailable: status.updateAvailable });
      return status;
    } catch (error) {
      const status = { currentVersion, latestVersion: null, updateAvailable: false, checkedAt, error: 'unavailable' };
      await store.set({ [Keys.updates]: status });
      note('update-check-failed', { message: error?.message || String(error) });
      return status;
    }
  })().finally(() => { state.updateRequest = null; });
  return state.updateRequest;
}
