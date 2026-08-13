// Country and regional-origin resolution. Generated facts live in
// countryData.generated.js; this file contains only runtime behavior.

const REGIONAL_AGGREGATES = new Set(Object.keys(REGIONAL_CODES).map(name => normalizeOrigin(name)));
const COUNTRY_BY_NAME = new Map();
const COUNTRY_BY_CODE = new Map();
const COUNTRY_PHRASES = [];
const CITY_PHRASES = Object.entries(CITY_TIMEZONES)
  .map(([name, timezone]) => ({ search: normalizeOrigin(name), timezone }))
  .sort((left, right) => right.search.length - left.search.length);
const LOCATION_RESULTS = new Map();
const TIMEZONE_RESULTS = new Map();
const TIME_FORMATTERS = new Map();
const HOUR_FORMATTERS = new Map();
const MAX_MEMOIZED_RESULTS = 600;

function normalizeOrigin(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .trim()
    .toLocaleLowerCase();
}

function phraseOccurs(text, phrase) {
  const index = text.indexOf(phrase);
  if (index < 0) return false;
  const token = /[\p{L}\p{N}_]/u;
  return (!text[index - 1] || !token.test(text[index - 1])) &&
    (!text[index + phrase.length] || !token.test(text[index + phrase.length]));
}

function remember(map, key, value) {
  if (map.size >= MAX_MEMOIZED_RESULTS) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}

function registerCountry(searchName, canonicalName, code) {
  const search = normalizeOrigin(searchName);
  if (!search || !/^[a-z]{2}$/.test(code)) return;
  const record = Object.freeze({ name: canonicalName, code });
  COUNTRY_BY_NAME.set(search, record);
  COUNTRY_BY_CODE.set(code, record);
}

for (const [name, code] of Object.entries(COUNTRY_FLAGS)) registerCountry(name, name, code);
for (const [alias, canonical] of Object.entries(COUNTRY_ALIASES)) {
  const canonicalRecord = COUNTRY_BY_NAME.get(normalizeOrigin(canonical));
  if (canonicalRecord) registerCountry(alias, canonicalRecord.name, canonicalRecord.code);
}
for (const [search, record] of COUNTRY_BY_NAME.entries()) COUNTRY_PHRASES.push({ search, record });
COUNTRY_PHRASES.sort((left, right) => right.search.length - left.search.length);

const US_RECORD = COUNTRY_BY_CODE.get('us') || null;

function isRegionalAggregate(location) {
  return REGIONAL_AGGREGATES.has(normalizeOrigin(location));
}

function isSupportedOrigin(location) {
  return isRegionalAggregate(location) || Boolean(resolveCountryRecord(location));
}

function hasCustomRegionalIcon(location) {
  return Boolean(REGIONAL_CODES[regionalDisplayName(location)]);
}

function regionalDisplayName(location) {
  const normalized = normalizeOrigin(String(location || '').replace(/\s+regional aggregate$/i, ''));
  return Object.keys(REGIONAL_CODES).find(name => normalizeOrigin(name) === normalized) || '';
}

function createRegionalAggregateIcon(label = 'Regional aggregate') {
  if (typeof document === 'undefined') return null;
  const name = regionalDisplayName(label);
  const code = REGIONAL_CODES[name];
  if (!code) return null;
  const badge = document.createElement('span');
  badge.className = 'region-glyph';
  badge.setAttribute('role', 'img');
  const displayName = name.replace(/\b\w/g, letter => letter.toUpperCase());
  badge.setAttribute('aria-label', `${displayName} regional aggregate`);
  badge.textContent = code;
  return badge;
}

function resolveCountryRecord(location) {
  const key = normalizeOrigin(location);
  if (!key || REGIONAL_AGGREGATES.has(key)) return null;
  if (LOCATION_RESULTS.has(key)) return LOCATION_RESULTS.get(key);

  let record = COUNTRY_BY_NAME.get(key) || null;
  const stateMatch = key.match(/(?:^|,)\s*([a-z]{2})\s*$/);
  if (!record && stateMatch && US_STATE_TIMEZONES[stateMatch[1]]) record = US_RECORD;
  if (!record) record = COUNTRY_PHRASES.find(candidate => phraseOccurs(key, candidate.search))?.record || null;
  return remember(LOCATION_RESULTS, key, record);
}

function resolveCountryName(location) {
  return resolveCountryRecord(location)?.name || null;
}

function getCountryFlag(location) {
  return resolveCountryRecord(location)?.code || null;
}

function getCountryFlagEmoji(location) {
  const code = getCountryFlag(location);
  if (!code) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map(letter => letter.charCodeAt(0) + 127397));
}

function getFlagAssetUrl(countryOrCode) {
  const raw = String(countryOrCode || '').trim();
  const code = /^[a-z]{2}$/i.test(raw) ? raw.toLowerCase() : getCountryFlag(raw);
  if (!code || !COUNTRY_BY_CODE.has(code)) return '';
  const asset = `flags/4x3/${code}.svg`;
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(asset) : asset;
}

function resolveTimezone(location) {
  const key = normalizeOrigin(location);
  if (!key || REGIONAL_AGGREGATES.has(key)) return null;
  if (TIMEZONE_RESULTS.has(key)) return TIMEZONE_RESULTS.get(key);

  const city = CITY_PHRASES.find(candidate => phraseOccurs(key, candidate.search));
  if (city) return remember(TIMEZONE_RESULTS, key, city.timezone);

  const stateMatch = key.match(/(?:^|,)\s*([a-z]{2})\s*$/);
  if (stateMatch && US_STATE_TIMEZONES[stateMatch[1]]) {
    return remember(TIMEZONE_RESULTS, key, US_STATE_TIMEZONES[stateMatch[1]]);
  }

  const country = resolveCountryName(location);
  return remember(TIMEZONE_RESULTS, key, country ? (COUNTRY_TIMEZONES[country] || null) : null);
}

function getLocalTimeString(timezone) {
  if (!timezone) return null;
  try {
    let formatter = TIME_FORMATTERS.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
      TIME_FORMATTERS.set(timezone, formatter);
    }
    return formatter.format(new Date());
  } catch (_) {
    return null;
  }
}

function getLocalHour(timezone) {
  if (!timezone) return null;
  try {
    let formatter = HOUR_FORMATTERS.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
      HOUR_FORMATTERS.set(timezone, formatter);
    }
    const value = formatter.formatToParts(new Date()).find(part => part.type === 'hour')?.value;
    return value === undefined ? null : Number.parseInt(value, 10);
  } catch (_) {
    return null;
  }
}
