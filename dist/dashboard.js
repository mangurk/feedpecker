const STATS_KEY = 'extension_stats';
const DEBUG_LOGS_KEY = 'debug_logs';
const DEBUG_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const BLOCKED_COUNTRIES_KEY = 'blocked_countries';
const UPDATE_STATUS_KEY = 'update_status';
const DISMISSED_UPDATE_KEY = 'dismissed_update_version';
const UPDATE_COMMAND = 'git pull --ff-only origin main';
const COUNTRY_LIST_PREVIEW_LIMIT = 30;
const REPOSITORY_URL = 'https://github.com/mangurk/feedpecker';
const extensionStorage = globalThis.feedpeckerWebExt?.storage;

const els = {
  totalUsers: document.getElementById('totalUsers'),
  totalCountriesCount: document.getElementById('totalCountriesCount'),
  mapView: document.getElementById('mapView'),
  analyticsView: document.getElementById('analyticsView'),
  mapViewBtn: document.getElementById('mapViewBtn'),
  analyticsViewBtn: document.getElementById('analyticsViewBtn'),
  rangeSwitcher: document.getElementById('rangeSwitcher'),
  activityChart: document.getElementById('activityChart'),
  activityEmpty: document.getElementById('activityEmpty'),
  activityDescription: document.getElementById('activityDescription'),
  periodProfiles: document.getElementById('periodProfiles'),
  periodProfilesLabel: document.getElementById('periodProfilesLabel'),
  dailyAverage: document.getElementById('dailyAverage'),
  mapContainer: document.getElementById('mapContainer'),
  tooltip: document.getElementById('mapTooltip'),
  tooltipFlag: document.getElementById('tooltipFlag'),
  tooltipCountry: document.getElementById('tooltipCountry'),
  tooltipCount: document.getElementById('tooltipCount'),
  countryList: document.getElementById('countryList'),
  countryListToggle: document.getElementById('countryListToggle'),
  hiddenCountriesToggle: document.getElementById('hiddenCountriesToggle'),
  countryRuleSearch: document.getElementById('countryRuleSearch'),
  countryRuleResults: document.getElementById('countryRuleResults'),
  emptyState: document.getElementById('emptyState'),
  resetBtn: document.getElementById('resetBtn'),
  resetModal: document.getElementById('resetModal'),
  confirmResetBtn: document.getElementById('confirmReset'),
  cancelResetBtn: document.getElementById('cancelReset'),
  logsBtn: document.getElementById('logsBtn'),
  filteredProfilesBtn: document.getElementById('filteredProfilesBtn'),
  logsModal: document.getElementById('logsModal'),
  logsOutput: document.getElementById('logsOutput'),
  logsSummary: document.getElementById('logsSummary'),
  sortLogsBtn: document.getElementById('sortLogs'),
  refreshLogsBtn: document.getElementById('refreshLogs'),
  clearLogsBtn: document.getElementById('clearLogs'),
  copyLogsBtn: document.getElementById('copyLogs'),
  closeLogsBtn: document.getElementById('closeLogs'),
  closeLogsFooterBtn: document.getElementById('closeLogsFooter'),
  footerVersion: document.getElementById('footerVersion'),
  updateToast: document.getElementById('updateToast'),
  updateToastTitle: document.getElementById('updateToastTitle'),
  viewUpdateToast: document.getElementById('viewUpdateToast'),
  dismissUpdateToast: document.getElementById('dismissUpdateToast'),
  updatesModal: document.getElementById('updatesModal'),
  closeUpdates: document.getElementById('closeUpdates'),
  installedVersion: document.getElementById('installedVersion'),
  latestVersion: document.getElementById('latestVersion'),
  updateStatus: document.getElementById('updateStatus'),
  releaseNotesSection: document.getElementById('releaseNotesSection'),
  releaseNotes: document.getElementById('releaseNotes'),
  checkUpdates: document.getElementById('checkUpdates'),
  copyUpdateCommand: document.getElementById('copyUpdateCommand'),
  openRelease: document.getElementById('openRelease')
};

let currentStats = {};
let currentCountryData = [];
let blockedCountries = [];
let analyticsDays = 7;
let logsNewestFirst = true;
let countryListExpanded = false;
let showHiddenCountriesOnly = false;
let installedExtensionVersion = '';
let currentUpdateStatus = null;
let dismissedUpdateVersion = '';

const COUNTRY_RULE_OPTIONS = [
  ...Object.keys(typeof COUNTRY_FLAGS === 'undefined' ? {} : COUNTRY_FLAGS).map(name => ({
    name: name === 'United States of America' ? 'United States' : name,
    kind: 'country'
  })),
  ...Array.from(typeof REGIONAL_AGGREGATES === 'undefined' ? [] : REGIONAL_AGGREGATES).map(name => ({
    name: name.replace(/\b\w/g, letter => letter.toUpperCase()),
    kind: 'region'
  }))
]
  .filter((option, index, options) => options.findIndex(candidate => candidate.name === option.name) === index)
  .sort((left, right) => left.name.localeCompare(right.name));

function normalizedCountryData(seenCountries = {}) {
  const grouped = new Map();
  for (const [origin, rawCount] of Object.entries(seenCountries)) {
    const count = Number(rawCount) || 0;
    if (isRegionalAggregate(origin)) {
      const key = `region:${origin.toLocaleLowerCase()}`;
      const current = grouped.get(key) || { country: origin, count: 0, flag: '' };
      current.count += count;
      grouped.set(key, current);
      continue;
    }
    const flag = getCountryFlag(origin) || '';
    const key = flag ? `country:${flag}` : `unknown:${origin.toLocaleLowerCase()}`;
    const resolvedName = resolveCountryName(origin) || origin;
    const country = resolvedName === 'United States of America' ? 'United States' : resolvedName;
    const current = grouped.get(key) || { country, count: 0, flag };
    current.count += count;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count || left.country.localeCompare(right.country));
}

function hasExtensionStorage() {
  return Boolean(extensionStorage);
}

function getIsoCodeFromFlag(code) {
  return /^[a-z]{2}$/i.test(String(code || '')) ? String(code).toUpperCase() : null;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const b = String(right || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function currentExtensionVersion() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) return chrome.runtime.getManifest().version;
  try {
    const response = await fetch('manifest.json');
    return response.ok ? (await response.json()).version : '';
  } catch (_) {
    return '';
  }
}

function updateAvailable(status = currentUpdateStatus) {
  return /^\d+(?:\.\d+){1,3}$/.test(String(status?.latestVersion || ''))
    && compareVersions(status.latestVersion, installedExtensionVersion) > 0;
}

function renderUpdateUI(status = currentUpdateStatus) {
  currentUpdateStatus = status;
  const latest = status?.latestVersion;
  const available = updateAvailable(status);
  const unavailable = status?.error === 'unavailable' || !latest;

  els.installedVersion.textContent = installedExtensionVersion ? `v${installedExtensionVersion}` : 'Development build';
  els.latestVersion.textContent = latest ? `v${latest}` : 'Unavailable';
  els.updateStatus.className = `update-status${available ? ' available' : unavailable ? ' error' : ''}`;
  els.updateStatus.textContent = available
    ? `Feedpecker v${latest} is ready to download.`
    : unavailable
      ? 'Could not reach the latest GitHub release. Your installed extension is unchanged.'
      : `You’re up to date on v${installedExtensionVersion}.`;

  const notes = String(status?.releaseNotes || '').trim();
  els.releaseNotesSection.hidden = !notes;
  els.releaseNotes.textContent = notes;
  els.openRelease.href = status?.assetUrl || status?.releaseUrl || `${REPOSITORY_URL}/releases/latest`;
  els.openRelease.textContent = status?.assetUrl ? 'Download release ZIP' : 'Open latest release';

  const showToast = available && dismissedUpdateVersion !== latest;
  els.updateToast.hidden = !showToast;
  els.updateToastTitle.textContent = showToast ? `Feedpecker v${latest} is available` : 'A new Feedpecker release is available';
}

function sendUpdateCheck(force) {
  if (!hasExtensionStorage() || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    const preview = { currentVersion: installedExtensionVersion, latestVersion: installedExtensionVersion, updateAvailable: false, checkedAt: Date.now() };
    renderUpdateUI(preview);
    return Promise.resolve(preview);
  }
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'checkForUpdates', force }, response => {
      if (chrome.runtime.lastError || !response) {
        resolve(null);
        return;
      }
      renderUpdateUI(response);
      resolve(response);
    });
  });
}

function setupUpdatesModal() {
  const close = () => {
    els.updatesModal.hidden = true;
    els.updatesModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    els.footerVersion.focus();
  };
  const open = () => {
    renderUpdateUI(currentUpdateStatus);
    els.updatesModal.hidden = false;
    els.updatesModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => els.closeUpdates.focus());
  };

  els.footerVersion.addEventListener('click', open);
  els.viewUpdateToast.addEventListener('click', open);
  els.closeUpdates.addEventListener('click', close);
  els.updatesModal.querySelector('.modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || els.updatesModal.hidden) return;
    event.preventDefault();
    close();
  });
  els.dismissUpdateToast.addEventListener('click', async () => {
    const latest = currentUpdateStatus?.latestVersion;
    if (!latest) return;
    dismissedUpdateVersion = latest;
    els.updateToast.hidden = true;
    if (hasExtensionStorage()) await extensionStorage.set({ [DISMISSED_UPDATE_KEY]: latest });
  });
  els.checkUpdates.addEventListener('click', async () => {
    els.checkUpdates.disabled = true;
    els.checkUpdates.textContent = 'Checking…';
    els.updateStatus.className = 'update-status';
    els.updateStatus.textContent = 'Checking GitHub for the latest release…';
    await sendUpdateCheck(true);
    els.checkUpdates.disabled = false;
    els.checkUpdates.textContent = 'Check again';
  });
  els.copyUpdateCommand.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      els.copyUpdateCommand.textContent = 'Copied';
    } catch (_) {
      els.copyUpdateCommand.textContent = 'Copy failed';
    }
    setTimeout(() => { els.copyUpdateCommand.textContent = 'Copy'; }, 1200);
  });
}

async function setupVersionFooter() {
  installedExtensionVersion = await currentExtensionVersion();
  els.footerVersion.textContent = installedExtensionVersion ? `v${installedExtensionVersion}` : 'Development build';
  els.footerVersion.setAttribute('aria-label', `About Feedpecker${installedExtensionVersion ? ` version ${installedExtensionVersion}` : ''}`);
  setupUpdatesModal();

  if (hasExtensionStorage()) {
    const result = await extensionStorage.get([UPDATE_STATUS_KEY, DISMISSED_UPDATE_KEY]);
    currentUpdateStatus = result[UPDATE_STATUS_KEY] || null;
    dismissedUpdateVersion = String(result[DISMISSED_UPDATE_KEY] || '');
  }
  renderUpdateUI(currentUpdateStatus);
  await sendUpdateCheck(false);

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[DISMISSED_UPDATE_KEY]) dismissedUpdateVersion = String(changes[DISMISSED_UPDATE_KEY].newValue || '');
      if (changes[UPDATE_STATUS_KEY]) renderUpdateUI(changes[UPDATE_STATUS_KEY].newValue);
    });
  }
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function recentDays(count) {
  const days = [];
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(now.getDate() - offset);
    days.push({ date, key: dayKey(date) });
  }
  return days;
}

function periodName(days) {
  if (days === 7) return 'week';
  if (days === 30) return 'month';
  return 'year';
}

function activityBuckets(stats, days) {
  const profilesByDay = stats.newFilteredByDay || {};

  if (days !== 365) {
    return recentDays(days).map((day, index) => ({
      ...day,
      profiles: profilesByDay[day.key] || 0,
      label: days === 7
        ? (index === days - 1 ? 'Today' : day.date.toLocaleDateString(undefined, { weekday: 'short' }))
        : (index === days - 1 ? 'Today' : (index % 5 === 0 ? day.date.getDate() : '')),
      title: day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    }));
  }

  const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const now = new Date();
  now.setDate(1);
  now.setHours(12, 0, 0, 0);
  const months = [];
  for (let offset = 11; offset >= 0; offset--) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1, 12);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1, 12);
    let profiles = 0;
    for (const [key, value] of Object.entries(profilesByDay)) {
      const date = new Date(`${key}T12:00:00`);
      if (date >= start && date < end) profiles += Number(value) || 0;
    }
    months.push({
      date: start,
      profiles,
      label: monthFormatter.format(start),
      title: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    });
  }
  return months;
}

function renderActivity(stats, days = analyticsDays) {
  if (!els.activityChart) return;
  const values = activityBuckets(stats, days);
  const maxValue = Math.max(1, ...values.map(item => item.profiles));
  const totalProfiles = values.reduce((sum, item) => sum + item.profiles, 0);
  const name = periodName(days);

  els.periodProfiles.textContent = formatCount(totalProfiles);
  els.periodProfilesLabel.textContent = `new profiles this ${name}`;
  els.dailyAverage.textContent = (totalProfiles / days).toLocaleString(undefined, { maximumFractionDigits: 1 });
  els.activityDescription.textContent = `Profiles identified and filtered for the first time this ${name}.`;
  els.activityChart.textContent = '';
  els.activityChart.style.gridTemplateColumns = `repeat(${values.length}, minmax(${days === 30 ? '8px' : '20px'}, 1fr))`;

  for (const item of values) {
    const formattedProfiles = formatCount(item.profiles);
    const profileWord = item.profiles === 1 ? 'profile' : 'profiles';
    const day = document.createElement('div');
    day.className = 'activity-day';
    day.tabIndex = 0;
    day.setAttribute('aria-label', `${item.title}: ${formattedProfiles} ${profileWord} blocked`);
    day.style.setProperty('--activity-height', item.profiles ? `${Math.max(3, (item.profiles / maxValue) * 100)}%` : '0%');
    const bars = document.createElement('div');
    bars.className = 'activity-bars';

    const bar = document.createElement('div');
    bar.className = 'activity-bar profiles';
    bar.style.height = 'var(--activity-height)';
    bars.appendChild(bar);

    const tooltip = document.createElement('div');
    tooltip.className = 'activity-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    const tooltipCount = document.createElement('strong');
    tooltipCount.textContent = formattedProfiles;
    const tooltipLabel = document.createElement('span');
    tooltipLabel.textContent = `blocked · ${item.title}`;
    tooltip.append(tooltipCount, tooltipLabel);
    bars.appendChild(tooltip);

    const label = document.createElement('span');
    label.className = 'activity-label';
    label.textContent = item.label;
    day.append(bars, label);
    els.activityChart.appendChild(day);
  }

  els.activityEmpty.hidden = totalProfiles > 0;
}

function sameOrigin(left, right) {
  return originsEquivalent(left, right);
}

function isCountryBlocked(country) {
  return blockedCountries.some(origin => sameOrigin(origin, country));
}

function mapCountryAliases(element) {
  const raw = element?.dataset?.countryAliases;
  if (!raw) return element?.dataset?.country ? [element.dataset.country] : [];
  return raw.split('|').filter(Boolean);
}

function isMapCountryBlocked(element) {
  return mapCountryAliases(element).some(isCountryBlocked);
}

async function saveBlockedCountries() {
  if (hasExtensionStorage()) {
    await extensionStorage.set({ [BLOCKED_COUNTRIES_KEY]: blockedCountries });
  }
}

function setCountryRuleResultsOpen(open) {
  if (!els.countryRuleSearch || !els.countryRuleResults) return;
  els.countryRuleResults.hidden = !open;
  els.countryRuleSearch.setAttribute('aria-expanded', String(open));
  if (open) positionCountryRuleResults();
}

function positionCountryRuleResults() {
  if (!els.countryRuleSearch || !els.countryRuleResults || els.countryRuleResults.hidden) return;
  const rect = els.countryRuleSearch.getBoundingClientRect();
  const viewportGap = 12;
  const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportGap);
  const availableAbove = Math.max(0, rect.top - viewportGap);
  const openUpward = availableBelow < 220 && availableAbove > availableBelow;
  const available = openUpward ? availableAbove : availableBelow;
  els.countryRuleResults.classList.toggle('opens-upward', openUpward);
  els.countryRuleResults.style.maxHeight = `${Math.max(72, Math.min(290, available - 6))}px`;
}

function countryRuleVisual(option) {
  const visual = document.createElement('span');
  visual.className = `country-rule-result-icon is-${option.kind}`;
  if (option.kind === 'region') {
    const icon = createRegionalAggregateIcon(`${option.name} regional aggregate`);
    if (icon) visual.appendChild(icon);
    return visual;
  }
  const flagUrl = getFlagAssetUrl(option.name);
  if (flagUrl) {
    const image = document.createElement('img');
    image.src = flagUrl;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.addEventListener('error', () => visual.classList.add('is-missing'), { once: true });
    visual.appendChild(image);
  }
  return visual;
}

async function addBlockedOrigin(origin) {
  if (!origin || isCountryBlocked(origin)) return;
  blockedCountries = [...blockedCountries, origin];
  showHiddenCountriesOnly = true;
  countryListExpanded = false;
  els.hiddenCountriesToggle.setAttribute('aria-pressed', 'true');
  els.hiddenCountriesToggle.classList.add('active');
  els.hiddenCountriesToggle.textContent = 'All countries';
  await saveBlockedCountries();
  renderCountryList(currentCountryData);
  syncMapBlockedState();
}

function renderCountryRuleResults() {
  if (!els.countryRuleSearch || !els.countryRuleResults) return;
  const query = els.countryRuleSearch.value.trim().toLocaleLowerCase();
  const matches = COUNTRY_RULE_OPTIONS
    .filter(option => !isCountryBlocked(option.name) && (!query || option.name.toLocaleLowerCase().includes(query)))
    .slice(0, 12);
  els.countryRuleResults.textContent = '';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'country-rule-result-empty';
    empty.textContent = query ? 'No available origins match' : 'All origins are already hidden';
    els.countryRuleResults.appendChild(empty);
    setCountryRuleResultsOpen(true);
    return;
  }

  for (const option of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'country-rule-result';
    button.setAttribute('role', 'option');
    button.append(countryRuleVisual(option));
    const copy = document.createElement('span');
    copy.className = 'country-rule-result-copy';
    const name = document.createElement('strong');
    name.textContent = option.name;
    const kind = document.createElement('span');
    kind.textContent = option.kind;
    copy.append(name, kind);
    const action = document.createElement('span');
    action.className = 'country-rule-result-action';
    action.textContent = 'Add';
    button.append(copy, action);
    button.addEventListener('click', async () => {
      await addBlockedOrigin(option.name);
      els.countryRuleSearch.value = '';
      setCountryRuleResultsOpen(false);
      els.countryRuleSearch.focus();
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        (button.nextElementSibling || els.countryRuleSearch).focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        (button.previousElementSibling || els.countryRuleSearch).focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setCountryRuleResultsOpen(false);
        els.countryRuleSearch.focus();
      }
    });
    els.countryRuleResults.appendChild(button);
  }
  setCountryRuleResultsOpen(true);
}

function setupCountryRuleSearch() {
  if (!els.countryRuleSearch || !els.countryRuleResults) return;
  els.countryRuleSearch.addEventListener('focus', renderCountryRuleResults);
  els.countryRuleSearch.addEventListener('input', renderCountryRuleResults);
  els.countryRuleSearch.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (els.countryRuleResults.hidden) renderCountryRuleResults();
      els.countryRuleResults.querySelector('button')?.focus();
    } else if (event.key === 'Escape') {
      setCountryRuleResultsOpen(false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const exact = COUNTRY_RULE_OPTIONS.find(option =>
        option.name.toLocaleLowerCase() === els.countryRuleSearch.value.trim().toLocaleLowerCase() &&
        !isCountryBlocked(option.name)
      );
      if (exact) {
        addBlockedOrigin(exact.name).then(() => {
          els.countryRuleSearch.value = '';
          setCountryRuleResultsOpen(false);
        });
      }
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.country-rule-adder')) setCountryRuleResultsOpen(false);
  });
  window.addEventListener('resize', positionCountryRuleResults);
  window.addEventListener('scroll', positionCountryRuleResults, { passive: true });
}

async function toggleBlockedCountry(country, relatedCountries = [country]) {
  if (!country) return;
  const aliases = [...new Set(relatedCountries.filter(Boolean))];
  const currentlyBlocked = aliases.some(isCountryBlocked);
  blockedCountries = currentlyBlocked
    ? blockedCountries.filter(item => !aliases.some(alias => sameOrigin(item, alias)))
    : [...blockedCountries, country];
  await saveBlockedCountries();
  renderCountryList(currentCountryData);
  syncMapBlockedState();
  hideTooltip();
}

function syncMapBlockedState() {
  const svg = els.mapContainer?.querySelector('svg');
  if (!svg) return;
  svg.querySelectorAll('[data-country]').forEach(element => {
    element.classList.toggle('blocked-country', isMapCountryBlocked(element));
  });
}

async function loadAndRenderMap(countryCounts) {
  try {
    const mapUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('world-map.svg')
      : 'world-map.svg';
    const response = await fetch(mapUrl);
    if (!response.ok) throw new Error('Failed to load map');
    const mapDocument = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    if (mapDocument.querySelector('parsererror') || mapDocument.documentElement.localName !== 'svg') {
      throw new Error('Map artwork is invalid');
    }
    els.mapContainer.replaceChildren(document.importNode(mapDocument.documentElement, true));
    const svg = els.mapContainer.querySelector('svg');
    if (!svg) throw new Error('Map artwork is missing');
    const mapCountries = new Map();
    for (const [countryName, flagCode] of Object.entries(COUNTRY_FLAGS)) {
      const iso = getIsoCodeFromFlag(flagCode);
      if (!iso) continue;
      const current = mapCountries.get(iso);
      if (!current) {
        mapCountries.set(iso, { country: countryName, flagCode, count: 0, totalCount: 0, aliases: [countryName] });
      } else {
        current.aliases.push(countryName);
      }
    }

    for (const [observedName, rawCount] of Object.entries(countryCounts)) {
      const flagCode = getCountryFlag(observedName);
      const iso = getIsoCodeFromFlag(flagCode);
      if (!iso) continue;
      const count = Number(rawCount) || 0;
      const current = mapCountries.get(iso) || {
        country: observedName,
        flagCode,
        count: 0,
        totalCount: 0,
        aliases: []
      };
      if (!current.aliases.includes(observedName)) current.aliases.push(observedName);
      current.totalCount += count;
      if (count > current.count) {
        current.country = observedName;
        current.flagCode = flagCode;
        current.count = count;
      }
      mapCountries.set(iso, current);
    }
    const maxCount = Math.max(...[...mapCountries.values()].map(item => item.totalCount), 1);

    for (const [iso, mapCountry] of mapCountries) {
      const element = svg.getElementById(iso.toLowerCase());
      if (!element) continue;
      const { country: countryName, flagCode, totalCount: count, aliases } = mapCountry;
      if (count > 0) {
        const intensity = Math.ceil((Math.log(count + 1) / Math.log(maxCount + 1)) * 8);
        element.classList.add(`heat-${Math.max(1, Math.min(8, intensity))}`, 'highlighted');
      }
      for (const target of [element, ...element.querySelectorAll('path')]) {
        target.dataset.country = countryName;
        target.dataset.countryAliases = aliases.join('|');
        target.dataset.count = String(count);
        target.dataset.flag = flagCode;
      }
    }

    syncMapBlockedState();
    let hoveredCountryElement = null;
    svg.addEventListener('mousemove', event => {
      const target = event.target.closest('[data-country]');
      const iso = target ? getIsoCodeFromFlag(target.dataset.flag) : '';
      const nextHovered = iso ? svg.getElementById(iso.toLowerCase()) : null;
      if (nextHovered !== hoveredCountryElement) {
        hoveredCountryElement?.classList.remove('hovered');
        nextHovered?.classList.add('hovered');
        hoveredCountryElement = nextHovered;
      }
      if (target) showTooltip(event, target.dataset.country, target.dataset.flag, target.dataset.count);
      else hideTooltip();
    });
    svg.addEventListener('click', event => {
      const target = event.target.closest('[data-country]');
      if (target) toggleBlockedCountry(target.dataset.country, mapCountryAliases(target));
    });
    svg.addEventListener('mouseleave', () => {
      hoveredCountryElement?.classList.remove('hovered');
      hoveredCountryElement = null;
      hideTooltip();
    });
  } catch (error) {
    const message = document.createElement('div');
    message.className = 'map-error';
    message.textContent = `Failed to load map: ${error?.message || 'Unknown error'}`;
    els.mapContainer.replaceChildren(message);
  }
}

function showTooltip(event, country, flag, count) {
  els.tooltip.hidden = false;
  const flagUrl = getFlagAssetUrl(flag);
  els.tooltipFlag.replaceChildren();
  if (flagUrl) {
    const flagImage = document.createElement('img');
    flagImage.src = flagUrl;
    flagImage.alt = `${country} flag`;
    flagImage.style.cssText = 'width:1.5em;height:auto;display:block';
    flagImage.addEventListener('error', () => flagImage.remove(), { once: true });
    els.tooltipFlag.appendChild(flagImage);
  }
  els.tooltipCountry.textContent = country;
  els.tooltipCount.textContent = `${formatCount(count)} profiles · ${isCountryBlocked(country) ? 'hidden — click to allow' : 'click to hide'}`;
  const rect = els.tooltip.getBoundingClientRect();
  let left = event.clientX + 15;
  let top = event.clientY + 15;
  if (left + rect.width > window.innerWidth) left = event.clientX - rect.width - 15;
  if (top + rect.height > window.innerHeight) top = event.clientY - rect.height - 15;
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function renderCountryList(sortedData) {
  const manuallyAdded = blockedCountries
    .filter(country => !sortedData.some(item => sameOrigin(item.country, country)))
    .map(country => ({ country, count: 0, flag: getCountryFlag(country) || '' }));
  const allData = [...sortedData, ...manuallyAdded];
  const sourceData = showHiddenCountriesOnly
    ? blockedCountries
      .map(country => allData.find(item => sameOrigin(item.country, country)))
      .filter(Boolean)
      .sort((left, right) => right.count - left.count || left.country.localeCompare(right.country))
    : allData;
  els.countryList.textContent = '';
  if (!sourceData.length) {
    els.emptyState.hidden = false;
    els.emptyState.querySelector('h3').textContent = showHiddenCountriesOnly ? 'No hidden countries' : 'No data yet';
    els.emptyState.querySelector('p').textContent = showHiddenCountriesOnly
      ? 'Use Hide on a country to add it to this view.'
      : 'Browse your X feed to start tracking countries.';
    els.countryListToggle.hidden = true;
    return;
  }
  els.emptyState.hidden = true;
  const hasMoreCountries = sourceData.length > COUNTRY_LIST_PREVIEW_LIMIT;
  const visibleData = countryListExpanded
    ? sourceData
    : sourceData.slice(0, COUNTRY_LIST_PREVIEW_LIMIT);
  els.countryListToggle.hidden = !hasMoreCountries;
  els.countryListToggle.textContent = countryListExpanded
    ? 'Show less'
    : `View more (${sourceData.length - COUNTRY_LIST_PREVIEW_LIMIT})`;
  els.countryListToggle.setAttribute('aria-expanded', String(countryListExpanded));
  const fragment = document.createDocumentFragment();
  const trafficMaximum = Math.max(...currentCountryData.map(item => item.count), 1);

  visibleData.forEach((item, index) => {
    const card = document.createElement('article');
    const blocked = isCountryBlocked(item.country);
    card.className = `country-item${blocked ? ' is-blocked' : ''}`;

    const rank = document.createElement('div');
    rank.className = `country-rank${index < 3 ? ' top-3' : ''}`;
    rank.textContent = `#${index + 1}`;

    const flag = document.createElement('div');
    flag.className = 'country-flag';
    const flagUrl = getFlagAssetUrl(item.flag);
    if (flagUrl) {
      const flagImage = document.createElement('img');
      flagImage.src = flagUrl;
      flagImage.alt = `${item.country} flag`;
      flagImage.loading = 'lazy';
      flagImage.addEventListener('error', () => flag.classList.add('is-missing'), { once: true });
      flag.appendChild(flagImage);
    } else if (isRegionalAggregate(item.country)) {
      flag.classList.add('is-region');
      const regionIcon = createRegionalAggregateIcon(`${item.country} regional aggregate`);
      if (regionIcon) flag.appendChild(regionIcon);
    } else {
      flag.classList.add('is-missing');
      flag.setAttribute('aria-hidden', 'true');
    }

    const info = document.createElement('div');
    info.className = 'country-info';
    const top = document.createElement('div');
    top.className = 'country-info-row';
    const name = document.createElement('span');
    name.className = 'country-name';
    name.textContent = item.country;
    const count = document.createElement('span');
    const trafficIntensity = item.count > 0
      ? Math.max(1, Math.min(8, Math.ceil((Math.log(item.count + 1) / Math.log(trafficMaximum + 1)) * 8)))
      : 0;
    count.className = `country-count${trafficIntensity ? ` traffic-${trafficIntensity}` : ''}`;
    count.textContent = formatCount(item.count);
    top.append(name, count);
    info.append(top);

    const action = document.createElement('button');
    action.className = `country-block-toggle${blocked ? ' enabled' : ''}`;
    action.type = 'button';
    action.setAttribute('role', 'switch');
    action.setAttribute('aria-checked', String(blocked));
    action.setAttribute('aria-label', `Hide posts from ${item.country}`);
    const actionLabel = document.createElement('span');
    actionLabel.textContent = blocked ? 'Hidden' : 'Hide';
    const actionTrack = document.createElement('i');
    actionTrack.setAttribute('aria-hidden', 'true');
    actionTrack.appendChild(document.createElement('b'));
    action.append(actionLabel, actionTrack);
    action.addEventListener('click', () => toggleBlockedCountry(item.country));

    card.append(rank, flag, info, action);
    fragment.appendChild(card);
  });
  els.countryList.appendChild(fragment);
  if (hasMoreCountries) els.countryList.appendChild(els.countryListToggle);
}

function setupCountryListToggle() {
  els.countryListToggle?.addEventListener('click', () => {
    countryListExpanded = !countryListExpanded;
    renderCountryList(currentCountryData);
    if (!countryListExpanded) {
      document.querySelector('.country-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  els.hiddenCountriesToggle?.addEventListener('click', () => {
    showHiddenCountriesOnly = !showHiddenCountriesOnly;
    countryListExpanded = false;
    els.hiddenCountriesToggle.setAttribute('aria-pressed', String(showHiddenCountriesOnly));
    els.hiddenCountriesToggle.classList.toggle('active', showHiddenCountriesOnly);
    els.hiddenCountriesToggle.textContent = showHiddenCountriesOnly ? 'All countries' : 'Hidden only';
    renderCountryList(currentCountryData);
  });
}

function setDashboardView(view) {
  const analytics = view === 'analytics';
  els.mapView.hidden = analytics;
  els.analyticsView.hidden = !analytics;
  els.rangeSwitcher.hidden = !analytics;
  els.mapViewBtn.classList.toggle('active', !analytics);
  els.analyticsViewBtn.classList.toggle('active', analytics);
  els.mapViewBtn.setAttribute('aria-selected', String(!analytics));
  els.analyticsViewBtn.setAttribute('aria-selected', String(analytics));
}

function setupVisualizationControls() {
  els.mapViewBtn.addEventListener('click', () => setDashboardView('map'));
  els.analyticsViewBtn.addEventListener('click', () => setDashboardView('analytics'));
  els.rangeSwitcher.querySelectorAll('.range-btn').forEach(button => {
    button.addEventListener('click', () => {
      analyticsDays = Number(button.dataset.days) || 7;
      els.rangeSwitcher.querySelectorAll('.range-btn').forEach(item => item.classList.toggle('active', item === button));
      renderActivity(currentStats, analyticsDays);
    });
  });
}

function setupFilteredProfilesButton() {
  els.filteredProfilesBtn?.addEventListener('click', () => {
    const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('filtered.html')
      : 'filtered.html';
    window.location.href = url;
  });
}

function setupResetButton() {
  if (!els.resetBtn) return;
  const close = () => {
    els.resetModal.hidden = true;
    els.resetModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    els.resetBtn.focus();
  };
  const open = () => {
    els.resetModal.hidden = false;
    els.resetModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => els.cancelResetBtn.focus());
  };
  els.resetBtn.addEventListener('click', open);
  els.cancelResetBtn.addEventListener('click', close);
  els.resetModal.querySelector('.modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || els.resetModal.hidden) return;
    event.preventDefault();
    close();
  });
  els.confirmResetBtn.addEventListener('click', async () => {
    els.confirmResetBtn.disabled = true;
    els.confirmResetBtn.textContent = 'Resetting…';
    const emptyStats = { seenCountries: {}, totalScanned: 0, hiddenPosts: 0, blockedAccounts: 0, scannedByDay: {}, hiddenByDay: {}, blockedByDay: {}, profilesByDay: {}, newFilteredProfiles: 0, newFilteredByDay: {} };
    if (hasExtensionStorage()) await extensionStorage.set({ [STATS_KEY]: emptyStats });
    window.location.reload();
  });
}

async function renderLogs() {
  if (!els.logsOutput || !els.logsSummary) return;
  if (!hasExtensionStorage()) {
    els.logsSummary.textContent = 'Preview mode';
    els.logsOutput.textContent = 'Diagnostics are available when this page is opened from the installed extension.';
    return;
  }
  try {
    const result = await extensionStorage.get(DEBUG_LOGS_KEY);
    const storedLogs = Array.isArray(result[DEBUG_LOGS_KEY]) ? result[DEBUG_LOGS_KEY] : [];
    const cutoff = Date.now() - DEBUG_LOG_RETENTION_MS;
    const logs = storedLogs
      .filter(log => Number.isFinite(Date.parse(log?.time)) && Date.parse(log.time) >= cutoff)
      .sort((a, b) => {
        const difference = Date.parse(a.time) - Date.parse(b.time);
        return logsNewestFirst ? -difference : difference;
      });
    if (logs.length !== storedLogs.length) await extensionStorage.set({ [DEBUG_LOGS_KEY]: logs });
    if (!logs.length) {
      els.logsSummary.textContent = 'No saved events';
      els.logsOutput.textContent = 'No diagnostic events yet. Browse X or open the extension popup to generate them.';
      return;
    }
    els.logsSummary.textContent = `${logs.length} saved event${logs.length === 1 ? '' : 's'}`;
    els.logsOutput.textContent = logs.map(entry => {
      const time = entry.time ? new Date(entry.time).toLocaleString() : 'unknown time';
      let details = '';
      if (entry.details !== undefined && entry.details !== null && entry.details !== '') {
        try { details = ` ${JSON.stringify(entry.details)}`; } catch (_) { details = ` ${String(entry.details)}`; }
      }
      return `[${time}] [${entry.source || 'extension'}] ${entry.event || 'event'}${details}`;
    }).join('\n');
  } catch (error) {
    els.logsSummary.textContent = 'Log read failed';
    els.logsOutput.textContent = `Unable to read logs: ${error.message || error}`;
  }
}

function setupLogsButton() {
  if (!els.logsBtn || !els.logsModal) return;
  const close = () => { els.logsModal.hidden = true; };
  els.logsBtn.addEventListener('click', async () => { els.logsModal.hidden = false; await renderLogs(); });
  els.sortLogsBtn?.addEventListener('click', async () => {
    logsNewestFirst = !logsNewestFirst;
    els.sortLogsBtn.textContent = logsNewestFirst ? 'Newest ↓' : 'Oldest ↑';
    els.sortLogsBtn.setAttribute('aria-label', logsNewestFirst ? 'Show oldest logs first' : 'Show newest logs first');
    await renderLogs();
  });
  els.refreshLogsBtn?.addEventListener('click', renderLogs);
  els.closeLogsBtn?.addEventListener('click', close);
  els.closeLogsFooterBtn?.addEventListener('click', close);
  els.logsModal.querySelector('.modal-backdrop')?.addEventListener('click', close);
  els.clearLogsBtn?.addEventListener('click', async () => {
    if (hasExtensionStorage()) await extensionStorage.set({ [DEBUG_LOGS_KEY]: [] });
    await renderLogs();
  });
  els.copyLogsBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.logsOutput.textContent || '');
      els.copyLogsBtn.textContent = 'Copied';
    } catch (_) {
      els.copyLogsBtn.textContent = 'Copy failed';
    }
    setTimeout(() => { els.copyLogsBtn.textContent = 'Copy diagnostics'; }, 1200);
  });
}

function mockStats() {
  const newFilteredByDay = {};
  recentDays(36).forEach((day, index) => {
    newFilteredByDay[day.key] = Math.max(0, Math.round(7 + Math.sin(index / 2) * 5 + index / 8));
  });
  return {
    seenCountries: { 'United States': 286, 'United Kingdom': 104, India: 82, Japan: 55, Germany: 44, Canada: 31, France: 23, Brazil: 18, Australia: 14 },
    totalScanned: 732,
    newFilteredProfiles: 214,
    newFilteredByDay
  };
}

async function init() {
  let stats = mockStats();
  if (hasExtensionStorage()) {
    const result = await extensionStorage.get([STATS_KEY, BLOCKED_COUNTRIES_KEY]);
    stats = result[STATS_KEY] || { seenCountries: {}, totalScanned: 0, newFilteredProfiles: 0, newFilteredByDay: {} };
    blockedCountries = Array.isArray(result[BLOCKED_COUNTRIES_KEY]) ? result[BLOCKED_COUNTRIES_KEY] : [];
  }
  currentStats = stats;
  const seenCountries = stats.seenCountries || {};
  currentCountryData = normalizedCountryData(seenCountries);

  els.totalUsers.textContent = formatCount(stats.totalScanned || 0);
  els.totalCountriesCount.textContent = String(currentCountryData.length);

  renderCountryList(currentCountryData);
  renderActivity(stats, analyticsDays);
  setupCountryListToggle();
  setupCountryRuleSearch();
  setupVisualizationControls();
  setupFilteredProfilesButton();
  setupResetButton();
  setupLogsButton();
  await setupVersionFooter();

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[BLOCKED_COUNTRIES_KEY]) return;
      blockedCountries = Array.isArray(changes[BLOCKED_COUNTRIES_KEY].newValue) ? changes[BLOCKED_COUNTRIES_KEY].newValue : [];
      renderCountryList(currentCountryData);
      syncMapBlockedState();
      if (!els.countryRuleResults.hidden) renderCountryRuleResults();
    });
  }

  await loadAndRenderMap(seenCountries);
}

document.addEventListener('DOMContentLoaded', init);
