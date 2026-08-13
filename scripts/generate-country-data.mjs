import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.resolve(process.argv[2] || path.join(root, 'vendor', 'flag-icons-country.json'));
const outputFile = path.join(root, 'src', 'shared', 'countryData.generated.js');

const timezoneCandidates = [
  process.env.FEEDPECKER_ZONE_TAB,
  '/usr/share/zoneinfo/zone1970.tab',
  '/usr/share/zoneinfo/zone.tab',
  '/var/db/timezone/zoneinfo/zone1970.tab',
  '/var/db/timezone/zoneinfo/zone.tab'
].filter(Boolean);

async function firstReadable(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error('No IANA zone1970.tab or zone.tab file found. Set FEEDPECKER_ZONE_TAB to an explicit path.');
}

const rawCountries = JSON.parse(await readFile(sourceFile, 'utf8'));
const countries = rawCountries
  .filter(country => country?.iso === true && /^[a-z]{2}$/.test(String(country.code || '')) && country.name)
  .map(country => ({ name: String(country.name), code: String(country.code) }))
  .sort((left, right) => left.name.localeCompare(right.name));

if (countries.length < 200) throw new Error(`Country source is incomplete: found ${countries.length} ISO records.`);

const zoneTabFile = await firstReadable(timezoneCandidates);
const timezoneByCode = new Map();
for (const line of (await readFile(zoneTabFile, 'utf8')).split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [codes, , timezone] = line.split('\t');
  if (!timezone) continue;
  for (const code of String(codes || '').split(',')) {
    const normalized = code.trim().toLowerCase();
    if (normalized && !timezoneByCode.has(normalized)) timezoneByCode.set(normalized, timezone);
  }
}

const flags = Object.fromEntries(countries.map(country => [country.name, country.code]));
const timezones = Object.fromEntries(countries
  .map(country => [country.name, timezoneByCode.get(country.code)])
  .filter(([, timezone]) => Boolean(timezone)));

if (Object.keys(timezones).length < 150) {
  throw new Error(`Timezone source is incomplete: mapped only ${Object.keys(timezones).length} countries from ${zoneTabFile}.`);
}

const aliases = {
  'Åland Islands': 'Aland Islands',
  America: 'United States of America',
  'United States': 'United States of America',
  'Bolivia, Plurinational State of': 'Bolivia',
  Brunei: 'Brunei Darussalam',
  Burma: 'Myanmar',
  'Cape Verde': 'Cabo Verde',
  Czechia: 'Czech Republic',
  'Congo, The Democratic Republic of the': 'Democratic Republic of the Congo',
  England: 'United Kingdom',
  Swaziland: 'Eswatini',
  'Great Britain': 'United Kingdom',
  'Iran, Islamic Republic of': 'Iran',
  'Ivory Coast': "Côte d'Ivoire",
  "Lao People's Democratic Republic": 'Laos',
  'Libyan Arab Jamahiriya': 'Libya',
  Macao: 'Macau',
  Macedonia: 'North Macedonia',
  Micronesia: 'Federated States of Micronesia',
  'Micronesia, Federated States of': 'Federated States of Micronesia',
  'Moldova, Republic of': 'Moldova',
  "Korea, Democratic People's Republic of": 'North Korea',
  'Northern Ireland': 'United Kingdom',
  Palestine: 'State of Palestine',
  'Palestinian Territory': 'State of Palestine',
  'Korea, Republic of': 'South Korea',
  'Republic of Korea': 'South Korea',
  'Russian Federation': 'Russia',
  Scotland: 'United Kingdom',
  Korea: 'South Korea',
  'Syrian Arab Republic': 'Syria',
  'Tanzania, United Republic of': 'Tanzania',
  Turkey: 'Türkiye',
  UAE: 'United Arab Emirates',
  UK: 'United Kingdom',
  US: 'United States of America',
  USA: 'United States of America',
  Vatican: 'Holy See',
  'Venezuela, Bolivarian Republic of': 'Venezuela',
  'Viet Nam': 'Vietnam',
  Wales: 'United Kingdom'
};

const regionalLabels = {
  Africa: 'AF', Asia: 'AS', Caribbean: 'CB', 'Central America': 'CA', 'Central Asia': 'CAS',
  'East Africa': 'EA', 'East Asia': 'EAS', 'Eastern Europe': 'EE', Europe: 'EU',
  'Latin America': 'LA', 'Middle East': 'ME', 'North Africa': 'NAF', 'North America': 'NAM',
  'Northern Europe': 'NE', Oceania: 'OC', 'South America': 'SA', 'South Asia': 'SAS',
  'Southeast Asia': 'SEA', 'Southern Africa': 'SAF', 'Southern Europe': 'SEU',
  'Sub-Saharan Africa': 'SSA', 'West Africa': 'WAF', 'West Asia': 'WA', 'Western Europe': 'WE',
  World: 'WR', Global: 'GL', International: 'INT'
};
const regionalCodes = Object.fromEntries(Object.entries(regionalLabels).map(([name, code]) => [name.toLocaleLowerCase(), code]));

const cityTimezones = {
  'abu dhabi': 'Asia/Dubai', amsterdam: 'Europe/Amsterdam', atlanta: 'America/New_York',
  austin: 'America/Chicago', bangkok: 'Asia/Bangkok', barcelona: 'Europe/Madrid',
  beijing: 'Asia/Shanghai', berlin: 'Europe/Berlin', bogota: 'America/Bogota',
  boston: 'America/New_York', 'buenos aires': 'America/Argentina/Buenos_Aires', cairo: 'Africa/Cairo',
  'cape town': 'Africa/Johannesburg', cdmx: 'America/Mexico_City', chicago: 'America/Chicago',
  dallas: 'America/Chicago', delhi: 'Asia/Kolkata', denver: 'America/Denver', dubai: 'Asia/Dubai',
  dublin: 'Europe/Dublin', helsinki: 'Europe/Helsinki', 'hong kong': 'Asia/Hong_Kong',
  houston: 'America/Chicago', istanbul: 'Europe/Istanbul', jakarta: 'Asia/Jakarta',
  johannesburg: 'Africa/Johannesburg', 'kuala lumpur': 'Asia/Kuala_Lumpur', lagos: 'Africa/Lagos',
  lima: 'America/Lima', lisbon: 'Europe/Lisbon', london: 'Europe/London',
  'los angeles': 'America/Los_Angeles', madrid: 'Europe/Madrid', manila: 'Asia/Manila',
  melbourne: 'Australia/Melbourne', 'mexico city': 'America/Mexico_City', miami: 'America/New_York',
  montreal: 'America/Toronto', moscow: 'Europe/Moscow', mumbai: 'Asia/Kolkata',
  nairobi: 'Africa/Nairobi', 'new delhi': 'Asia/Kolkata', 'new york': 'America/New_York',
  nyc: 'America/New_York', paris: 'Europe/Paris', perth: 'Australia/Perth',
  phoenix: 'America/Phoenix', rome: 'Europe/Rome', 'san francisco': 'America/Los_Angeles',
  santiago: 'America/Santiago', 'sao paulo': 'America/Sao_Paulo', 'são paulo': 'America/Sao_Paulo',
  seattle: 'America/Los_Angeles', seoul: 'Asia/Seoul', shanghai: 'Asia/Shanghai',
  singapore: 'Asia/Singapore', stockholm: 'Europe/Stockholm', sydney: 'Australia/Sydney',
  taipei: 'Asia/Taipei', tokyo: 'Asia/Tokyo', toronto: 'America/Toronto',
  vancouver: 'America/Vancouver', vienna: 'Europe/Vienna', warsaw: 'Europe/Warsaw',
  washington: 'America/New_York', zurich: 'Europe/Zurich'
};

const usStateTimezones = {
  al: 'America/Chicago', ak: 'America/Anchorage', az: 'America/Phoenix', ar: 'America/Chicago',
  ca: 'America/Los_Angeles', co: 'America/Denver', ct: 'America/New_York', de: 'America/New_York',
  fl: 'America/New_York', ga: 'America/New_York', hi: 'Pacific/Honolulu', id: 'America/Boise',
  il: 'America/Chicago', in: 'America/Indiana/Indianapolis', ia: 'America/Chicago', ks: 'America/Chicago',
  ky: 'America/New_York', la: 'America/Chicago', me: 'America/New_York', md: 'America/New_York',
  ma: 'America/New_York', mi: 'America/Detroit', mn: 'America/Chicago', ms: 'America/Chicago',
  mo: 'America/Chicago', mt: 'America/Denver', ne: 'America/Chicago', nv: 'America/Los_Angeles',
  nh: 'America/New_York', nj: 'America/New_York', nm: 'America/Denver', ny: 'America/New_York',
  nc: 'America/New_York', nd: 'America/Chicago', oh: 'America/New_York', ok: 'America/Chicago',
  or: 'America/Los_Angeles', pa: 'America/New_York', ri: 'America/New_York', sc: 'America/New_York',
  sd: 'America/Chicago', tn: 'America/Chicago', tx: 'America/Chicago', ut: 'America/Denver',
  vt: 'America/New_York', va: 'America/New_York', wa: 'America/Los_Angeles', wv: 'America/New_York',
  wi: 'America/Chicago', wy: 'America/Denver', dc: 'America/New_York'
};

const generated = `// Generated by scripts/generate-country-data.mjs. Do not edit directly.\n` +
  `// Flag metadata: lipis/flag-icons country.json. Timezones: IANA ${path.basename(zoneTabFile)}.\n` +
  `const COUNTRY_FLAGS = Object.freeze(${JSON.stringify(flags, null, 2)});\n\n` +
  `const COUNTRY_ALIASES = Object.freeze(${JSON.stringify(aliases, null, 2)});\n\n` +
  `const COUNTRY_TIMEZONES = Object.freeze(${JSON.stringify(timezones, null, 2)});\n\n` +
  `const CITY_TIMEZONES = Object.freeze(${JSON.stringify(cityTimezones, null, 2)});\n\n` +
  `const US_STATE_TIMEZONES = Object.freeze(${JSON.stringify(usStateTimezones, null, 2)});\n\n` +
  `const REGIONAL_CODES = Object.freeze(${JSON.stringify(regionalCodes, null, 2)});\n`;

await writeFile(outputFile, generated, 'utf8');
console.log(`Generated ${countries.length} countries and ${Object.keys(timezones).length} country timezones from ${path.basename(zoneTabFile)}.`);
