import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

function pngAlphaRange(buffer) {
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const imageData = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'Icon PNGs must use 8-bit channels');
      assert.equal(data[9], 6, 'Icon PNGs must be RGBA');
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  const raw = inflateSync(Buffer.concat(imageData));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const previous = Buffer.alloc(stride);
  let rowOffset = 0;
  let minimum = 255;
  let maximum = 0;

  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
      ? left
      : aboveDistance <= upperLeftDistance ? above : upperLeft;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rowOffset];
    rowOffset += 1;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rowOffset + x];
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2)
        : filter === 4 ? paeth(left, above, upperLeft)
        : assert.fail(`Unsupported PNG filter ${filter}`);
      current[x] = (encoded + predictor) & 255;
    }
    for (let x = 3; x < stride; x += bytesPerPixel) {
      minimum = Math.min(minimum, current[x]);
      maximum = Math.max(maximum, current[x]);
    }
    current.copy(previous);
    rowOffset += stride;
  }
  return { minimum, maximum };
}

test('built extension has every manifest entry', async () => {
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  const required = new Set([
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    manifest.background.service_worker,
    ...manifest.background.scripts,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(script => script.js)
  ]);
  for (const relativePath of required) {
    assert.doesNotReject(() => readFile(path.join(output, relativePath)));
  }
});

test('browser-ready output excludes development-only icon sources', async () => {
  const shippedIcons = (await readdir(path.join(output, 'icons'))).sort();
  assert.deepEqual(shippedIcons, ['128.png', '16-fav.png', '16.png', '48-fav.png', '48.png']);
});

test('built JavaScript parses', async () => {
  const scripts = (await readdir(output)).filter(file => file.endsWith('.js'));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ['--check', path.join(output, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `${script} did not parse`);
  }
});

test('built extension uses Feedpecker branding', async () => {
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const popup = await readFile(path.join(output, manifest.action.default_popup), 'utf8');
  const dashboard = await readFile(path.join(output, 'dashboard.html'), 'utf8');
  const background = await readFile(path.join(output, 'background.js'), 'utf8');

  assert.equal(manifest.name, 'Feedpecker');
  assert.equal(manifest.version, packageMetadata.version);
  assert.equal(manifest.action.default_icon['16'], 'icons/16-fav.png');
  assert.equal(manifest.action.default_icon['48'], 'icons/48-fav.png');
  assert.equal(manifest.icons['16'], 'icons/16-fav.png');
  assert.equal(manifest.icons['48'], 'icons/48-fav.png');
  assert.match(popup, /Feedpecker/);
  assert.match(popup, /rel="icon"[^>]*href="icons\/16-fav\.png"/);
  assert.match(dashboard, /Feedpecker/);
  assert.match(dashboard, /rel="icon"[^>]*href="icons\/16-fav\.png"/);
  assert.match(background, /function applyActionIcon\(\) \{[\s\S]*chrome\.action\.setIcon\(\{ path: \{ 16: 'icons\/16-fav\.png', 48: 'icons\/48-fav\.png' \} \}\);/);
  assert.match(background, /chrome\.runtime\.onStartup\?\.addListener[\s\S]*applyActionIcon\(\);[\s\S]*fetchUpdateStatus\(\);/);
  assert.doesNotMatch(background, /setIcon\([^\n]*icons\/16\.png/);
});

test('country and timezone data resolve aliases while regional aggregates stay flagless', async () => {
  const source = await readFile(path.join(output, 'countryFlags.js'), 'utf8');
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(`${source}; globalThis.resolveFlagForTest = getCountryFlag; globalThis.resolveTimezoneForTest = resolveTimezone; globalThis.supportsOriginForTest = isSupportedOrigin; globalThis.hasRegionalIconForTest = hasCustomRegionalIcon; globalThis.regionalLabelsForTest = [...REGIONAL_AGGREGATES]; globalThis.regionalCodesForTest = REGIONAL_CODES; globalThis.countryTimezoneCountForTest = Object.keys(COUNTRY_TIMEZONES).length; globalThis.normalizeRulesForTest = normalizeOriginRules; globalThis.originsEquivalentForTest = originsEquivalent; globalThis.originIsBlockedForTest = originIsBlocked;`, context);
  assert.equal(context.resolveFlagForTest('Turkey'), 'tr');
  assert.equal(context.resolveFlagForTest('Czechia'), 'cz');
  assert.equal(context.resolveFlagForTest('United States'), 'us');
  assert.equal(context.resolveFlagForTest('USA'), 'us');
  assert.equal(context.resolveFlagForTest('America'), 'us');
  assert.equal(context.resolveFlagForTest('Macao'), 'mo');
  assert.equal(context.resolveFlagForTest('Micronesia'), 'fm');
  assert.equal(context.resolveFlagForTest('Palestine'), 'ps');
  assert.equal(context.resolveFlagForTest('Korea'), 'kr');
  assert.equal(context.resolveFlagForTest('Republic of Korea'), 'kr');
  assert.equal(context.resolveFlagForTest('South Asia'), null);
  assert.equal(context.resolveFlagForTest('South America'), null);
  assert.equal(context.supportsOriginForTest('Africa'), true);
  assert.equal(context.supportsOriginForTest('South Asia'), true);
  assert.equal(context.supportsOriginForTest('The Moon'), false);
  assert.equal(context.regionalLabelsForTest.length, 27);
  assert.equal(context.regionalLabelsForTest.filter(label => !context.hasRegionalIconForTest(label)).length, 0);
  assert.equal(context.regionalCodesForTest['west asia'], 'WA');
  assert.equal(context.regionalCodesForTest['south america'], 'SA');
  assert.ok(context.countryTimezoneCountForTest >= 200);
  assert.equal(context.resolveTimezoneForTest('Malaysia'), 'Asia/Kuala_Lumpur');
  assert.equal(context.resolveTimezoneForTest('Germany'), 'Europe/Berlin');
  assert.equal(context.resolveTimezoneForTest('Austin, TX'), 'America/Chicago');
  assert.equal(context.resolveTimezoneForTest('South America'), null);
  assert.deepEqual([...context.normalizeRulesForTest(['USA', 'usa', ' South America '])], ['usa', 'south america']);
  assert.equal(context.originsEquivalentForTest('USA', 'United States'), true);
  assert.equal(context.originsEquivalentForTest('South America', 'United States'), false);
  assert.equal(context.originIsBlockedForTest('Austin, TX', false, ['United States']), true);
  assert.equal(context.originIsBlockedForTest('South America', false, ['South America']), true);
  assert.equal(context.originIsBlockedForTest('South America', false, ['United States']), false);
  assert.equal(context.originIsBlockedForTest('Germany', false, ['Germany'], true), false);
  assert.equal(context.originIsBlockedForTest('Germany', true, ['Germany'], true), true);
});

test('generated country data is reproducible and never silently drops timezones', async () => {
  const [generator, generated, buildScript, integrationSpec] = await Promise.all([
    readFile(path.join(root, 'scripts', 'generate-country-data.mjs'), 'utf8'),
    readFile(path.join(root, 'src', 'shared', 'countryData.generated.js'), 'utf8'),
    readFile(path.join(root, 'scripts', 'build.mjs'), 'utf8'),
    readFile(path.join(root, 'docs', 'integration-spec.md'), 'utf8')
  ]);
  assert.match(generator, /FEEDPECKER_ZONE_TAB/);
  assert.match(generator, /Timezone source is incomplete/);
  assert.match(generated, /const COUNTRY_TIMEZONES = Object\.freeze\(\{/);
  assert.match(generated, /"Malaysia": "Asia\/Kuala_Lumpur"/);
  assert.match(buildScript, /countryData\.generated\.js/);
  assert.doesNotMatch(integrationSpec, /__setCachedQueryId|__queryIdDiscovered/);
});

test('soft dark styling stays consistent across extension surfaces', async () => {
  const [popup, popupScript, popupStyles, dashboard, dashboardScript, dashboardStyles, filteredStyles, background] = await Promise.all([
    readFile(path.join(output, 'popup.html'), 'utf8'),
    readFile(path.join(output, 'popup.js'), 'utf8'),
    readFile(path.join(output, 'popup.css'), 'utf8'),
    readFile(path.join(output, 'dashboard.html'), 'utf8'),
    readFile(path.join(output, 'dashboard.js'), 'utf8'),
    readFile(path.join(output, 'dashboard.css'), 'utf8'),
    readFile(path.join(output, 'filtered.css'), 'utf8'),
    readFile(path.join(output, 'background.js'), 'utf8')
  ]);

  for (const styles of [popupStyles, dashboardStyles, filteredStyles]) {
    assert.match(styles, /#ef233c/i);
  }
  assert.match(popupStyles, /--surface: #121212;/);
  assert.match(popupStyles, /\.popup-shell \{[\s\S]*background: var\(--surface\);/);
  assert.match(popupStyles, /\.topbar \{[\s\S]*background: var\(--surface\);/);
  assert.match(popupStyles, /padding: 6px 1px 8px;/);
  assert.match(popupStyles, /\.quota-meter,[\s\S]*background: var\(--black\);/);
  assert.match(popupStyles, /\.quota-meter-track \{[\s\S]*background: var\(--surface\);/);
  assert.match(popupStyles, /\.switch \{[\s\S]*background: #424242;/);
  assert.match(popupStyles, /border: 1px solid rgba\(250, 239, 226, \.14\);/);
  assert.match(popupStyles, /\.power-switch span \{[^}]*width: 13px;[^}]*height: 13px/s);
  assert.match(popupStyles, /--green: #49d55f;/);
  assert.match(popupStyles, /\.lookup-status\.green \.status-icon \{ background: var\(--green\); \}/);
  assert.match(popupStyles, /\.options-disclosure \{[\s\S]*background: var\(--black\)/);
  assert.match(popup, /id="manageCountries"/);
  assert.match(popup, /id="scannedTodayCount"/);
  assert.match(popup, /id="hiddenTodayCount"/);
  assert.match(popup, /id="blockedTodayCount"/);
  assert.doesNotMatch(popup, /class="filter-panel"|class="stats-strip"/);
  assert.doesNotMatch(popup, /id="customSelect"/);
  assert.doesNotMatch(popup, />Feed filter</);
  assert.doesNotMatch(popup, /X-only lookups/);
  assert.match(popupScript, /dashboard\.html#countries/);
  assert.match(popupScript, /stats\.scannedByDay\?\.\[today\]/);
  assert.match(popupScript, /stats\.hiddenByDay\?\.\[today\]/);
  assert.match(popupScript, /stats\.blockedByDay\?\.\[today\]/);
  assert.match(popup, /id="quotaMeter"[^>]*hidden/);
  assert.match(popupScript, /const pacing = paused \|\| fallbackPaused \|\| remaining <= 20;/);
  assert.match(popupScript, /if \(!pacing\) \{[\s\S]*els\.quotaMeter\.hidden = true;/);
  assert.match(background, /state\.stats\.scannedByDay\[today\]/);
  assert.match(background, /state\.stats\.blockedByDay\[today\]/);
  assert.match(dashboard, /id="countryRuleSearch"/);
  assert.doesNotMatch(dashboard, /Click a country to hide or allow its posts/);
  assert.match(dashboardScript, /REGIONAL_AGGREGATES/);
  assert.match(dashboardScript, /function addBlockedOrigin/);
  assert.match(dashboardScript, /function normalizedCountryData/);
  assert.match(dashboardScript, /function sameOrigin/);
  assert.match(dashboardScript, /function positionCountryRuleResults/);
  assert.match(dashboardScript, /trafficIntensity/);
  assert.match(dashboardStyles, /\.map-container \{ background: var\(--ink\); \}/);
  assert.match(dashboardStyles, /\.country-flag \{[^}]*border: 0/s);
  assert.match(dashboardStyles, /#f2d36b/i);
  assert.doesNotMatch(dashboardScript, /bar\.className = 'country-bar'/);
  assert.match(dashboardScript, /flag\.classList\.add\('is-missing'\)/);
  assert.match(dashboardScript, /showHiddenCountriesOnly/);
  assert.match(dashboardScript, /hiddenCountriesToggle/);
  assert.match(dashboardScript, /appendChild\(els\.countryListToggle\)/);
  assert.match(dashboardScript, /for \(const \[observedName, rawCount\] of Object\.entries\(countryCounts\)\)/);
  assert.match(dashboardScript, /action\.setAttribute\('role', 'switch'\)/);
  assert.match(dashboardStyles, /repeat\(auto-fill, minmax\(245px, 1fr\)\)/);
  assert.match(dashboardStyles, /\.country-flag\.is-missing::before/);
  assert.match(dashboardStyles, /\.country-filter-toggle, \.reset-btn \{/);
  assert.match(dashboardStyles, /\.activity-chart \{ border-bottom: 1px solid/);
  assert.match(dashboardStyles, /\.activity-chart \{ margin-top: 40px; \}/);
  assert.match(dashboardStyles, /\.dashboard-header::after \{ display: none; \}/);
  assert.match(dashboardStyles, /\.country-section \{ margin: 30px 0 0; \}/);
  assert.match(dashboardStyles, /\.map-legend \{[\s\S]*left: 50%;[\s\S]*width: max-content;[\s\S]*translateX\(-50%\);/);
  assert.match(dashboardStyles, /Restored from the cream popup picker in f5650a4\/a2771c6/);
  assert.match(dashboardStyles, /\.country-rule-results \{[\s\S]*background: #faefe2;[\s\S]*color: #000;/);
  assert.match(dashboardStyles, /box-shadow: 0 18px 42px rgba\(0,0,0,\.62\) !important;/);
  assert.match(dashboardStyles, /\.country-count\.traffic-8 \{ color: #f2d36b; \}/);
  assert.match(dashboardStyles, /scrollbar-color: #4b4b4b #121212;/);
  assert.match(dashboardStyles, /\.modal-footer \.btn-secondary \{ border-color: rgba\(250,239,226,\.3\); \}/);
  assert.match(dashboardStyles, /\.modal-footer \.btn-primary,[\s\S]*\.modal-footer \.btn-danger \{ border-color: #5c0e17; \}/);
  assert.match(dashboardStyles, /\.modal-content,[\s\S]*\.reset-confirm-detail,[\s\S]*\.modal-footer button \{ border-radius: 3px; \}/);
  assert.match(dashboardStyles, /\.modal-close::before,[\s\S]*\.modal-close::after \{[\s\S]*top: 50%;[\s\S]*left: 50%;/);
  assert.match(dashboardStyles, /translate\(-50%, -50%\) rotate\(45deg\)/);
  assert.match(dashboardStyles, /\.view-tab,[\s\S]*\.range-btn \{ border-radius: 0; \}/);
  assert.match(dashboardStyles, /\.update-status\.error \{[\s\S]*background: #14110d;[\s\S]*color: #c89b52;/);
  assert.match(dashboardStyles, /\/\* Unified soft-dark finish \*\//);
  assert.match(dashboardStyles, /\.tooltip-content, \.activity-tooltip \{/);
  assert.match(dashboardStyles, /\.analytics-view \{ padding: 44px/);
  assert.match(dashboardStyles, /\.activity-chart \{[^}]*height: 330px/s);
  assert.match(dashboardScript, /const maxValue = Math\.max\(1, \.\.\.values\.map\(item => item\.profiles\)\)/);
  assert.match(dashboardScript, /\(item\.profiles \/ maxValue\) \* 100/);
  assert.match(dashboard, /class="empty-icon" aria-hidden="true">◎</);
  assert.match(dashboardStyles, /rgba\(239,35,60,\.68\)/);
  assert.match(dashboardStyles, /\.legend-gradient \{ border-color: #81705c; \}/);
  assert.match(dashboardStyles, /\.country-item:hover,[\s\S]*border-color: rgb\(200 155 82 \/ 42%\)/);
  assert.match(dashboardStyles, /\.country-block-toggle \{[\s\S]*color: #cfc8bc;/);
  assert.match(dashboardStyles, /\.country-item:hover \.country-block-toggle:not\(\.enabled\),[\s\S]*color: #c89b52;/);
  assert.match(dashboardStyles, /\.country-block-toggle\.enabled \{ color: var\(--red\); \}/);
  assert.match(dashboardStyles, /\.map-container svg \.list-hovered,[\s\S]*fill: #c89b52 !important/);
  assert.match(dashboardScript, /function setCountryListMapHover\(country, active\)/);
  assert.match(dashboardScript, /card\.addEventListener\('mouseenter', \(\) => setLinkedHover\(true\)\)/);
  assert.match(dashboard, />Fewer traffic<[^>]*>[\s\S]*>More traffic</);
  assert.match(dashboardStyles, /body \{ background: #121212; \}/);
  assert.match(filteredStyles, /--bg: #000/);
  assert.match(filteredStyles, /body \{ background: #121212; \}/);
  assert.match(filteredStyles, /\.header-brand img \{ width: 46px; height: 46px/);
  assert.match(filteredStyles, /\.action-btn\.is-blocked,[\s\S]*border-color: var\(--red\)/);
  assert.match(filteredStyles, /\.control-panel\.is-stuck \{[\s\S]*box-shadow:[^}]*!important/s);
  assert.match(filteredStyles, /\.header-inner,[\s\S]*\.page-main \{ width: min\(1280px, calc\(100% - 40px\)\); \}/);
  assert.match(filteredStyles, /\.header-brand img \{[\s\S]*width: 46px;[\s\S]*height: 46px;[\s\S]*padding: 3px;[\s\S]*border: 0;/);
  assert.match(filteredStyles, /#restoreBackupBtn \{[\s\S]*color: #c89b52;/);
  assert.match(filteredStyles, /#clearFilteredBtn \{[\s\S]*border-color: #5c0e17;/);
  assert.match(filteredStyles, /scrollbar-color: #4b4b4b #121212;/);
  assert.match(filteredStyles, /#downloadBackupBtn:hover \{[\s\S]*border-color: #faefe2;[\s\S]*color: #faefe2;/);
  assert.match(filteredStyles, /\.confirm-copy \.confirm-detail,[\s\S]*\.modal-button \{ border-radius: 3px; \}/);
  assert.match(filteredStyles, /\.filter-tab:focus, \.filter-tab:focus-visible \{ outline: 0/);
  assert.match(filteredStyles, /\.action-btn\.is-blocked,[\s\S]*\.primary-button\.is-unblock,[\s\S]*border-color: #5c0e17/s);
});

test('About Account parsing tolerates X identity field migrations', async () => {
  const pageScript = await readFile(path.join(root, 'src', 'pageScript.js'), 'utf8');

  assert.match(pageScript, /KNOWN_OPERATIONS = \['zs_jFPFT78rBpXv9Z3U2YQ'/);
  assert.match(pageScript, /inspectWebpackChunks\(\) \|\| KNOWN_OPERATIONS\.find/);
  assert.match(pageScript, /node\.screen_name \|\| core\?\.screen_name \|\| legacy\?\.screen_name \|\| fallbackHandle/);
  assert.match(pageScript, /payload\?\.data\?\.user_result_by_screen_name\?\.result/);
  assert.match(pageScript, /payload\?\.data\?\.user\?\.result/);
  assert.match(pageScript, /mergeUserRecords\(directUser, nestedUser\)/);
  assert.match(pageScript, /collectUsers\(payload\)\.get\(screenName\.toLowerCase\(\)\)/);
  assert.match(pageScript, /about-account-operation-stale/);
  assert.match(pageScript, /referrer: profileReferrer/);
  const content = await readFile(path.join(output, 'content.js'), 'utf8');
  assert.doesNotMatch(content, /_tf_query_id/);
  assert.match(content, /version: 7/);
  assert.match(content, /if \(cursor\.result\.value\?\.location === null\) cursor\.result\.delete\(\)/);
  assert.match(content, /const LOCATION_RESULT_VERSION = 1/);
  assert.match(content, /proposedLocation === null && !confirmed/);
  assert.match(content, /resultVersion: LOCATION_RESULT_VERSION/);
  assert.match(content, /dbVal\.location === null && dbVal\.resultVersion !== LOCATION_RESULT_VERSION/);
  assert.match(content, /flag\.src = getFlagAssetUrl\(flagCode\)/);
  assert.match(content, /fallback\.textContent = getCountryFlagEmoji\(/);
  assert.match(content, /\.tf-filter-profile-btn\.is-filtered \{ border-color: #5c0e17; background: #000; color: #ef233c; \}/);
  assert.match(content, /\.tf-filter-profile-btn\.is-excluded \{ border-color: rgba\(200, 155, 82, \.72\); background: rgba\(200, 155, 82, \.14\); color: #e0b66e; \}/);
  assert.match(content, /\.tf-filter-profile-btn \{[\s\S]*border-radius: 999px;/);
  assert.match(content, /function appendHoverManualFilterButton\(root, handle\)/);
  assert.match(content, /appendHoverManualFilterButton\(root, handle\);[\s\S]*registerDirectLookupDemand\(handle, root\)/);
  assert.match(content, /const profile = getManualFilterProfile\(handle\);[\s\S]*createManualFilterButton\(profile, 'profile'\)/);
  assert.match(content, /\.tf-flag-image/);
  assert.match(content, /\.tf-flag-emoji/);
  assert.match(content, /debugLog\('flag-rendered'/);
  assert.match(content, /#tf-tooltip \{[\s\S]*background: #faefe2; color: #000;[\s\S]*border: 1px solid #000;/);
  assert.doesNotMatch(content, /⚠️|tf-flag-warning/);
});

test('release updates are checked and presented without self-installing code', async () => {
  const [manifestSource, background, dashboard, dashboardScript, dashboardStyles] = await Promise.all([
    readFile(path.join(output, 'manifest.json'), 'utf8'),
    readFile(path.join(output, 'background.js'), 'utf8'),
    readFile(path.join(output, 'dashboard.html'), 'utf8'),
    readFile(path.join(output, 'dashboard.js'), 'utf8'),
    readFile(path.join(output, 'dashboard.css'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.ok(manifest.host_permissions.includes('https://api.github.com/*'));
  assert.doesNotMatch(manifestSource, /raw\.githubusercontent\.com/);
  assert.match(background, /repos\/mangurk\/feedpecker\/releases\/latest/);
  assert.match(background, /UPDATE_CACHE_AGE = 6 \* 60 \* 60 \* 1000/);
  assert.match(background, /checkForUpdates\(request,/);
  assert.match(dashboard, /id="updateToast"/);
  assert.match(dashboard, /id="updatesModal"/);
  assert.match(dashboard, /git pull --ff-only origin main/);
  assert.match(dashboardScript, /dismissed_update_version/);
  assert.match(dashboardStyles, /\.footer-version:hover/);
  assert.doesNotMatch(background, /eval\(|new Function\(/);
});

test('background message contracts preserve settings, stats, and sender boundaries', async () => {
  const source = await readFile(path.join(output, 'background.js'), 'utf8');
  const values = {
    extension_enabled: true,
    blocked_countries: ['Germany'],
    extension_stats: { totalScanned: 4, seenCountries: { Spain: 2 } }
  };
  let messageListener;
  const read = async keys => {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
  };
  const write = async patch => Object.assign(values, patch);
  const chrome = {
    runtime: {
      id: 'feedpecker-test',
      getManifest: () => ({ version: '0.6.0' }),
      onMessage: { addListener: listener => { messageListener = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onSuspend: { addListener() {} }
    },
    storage: { onChanged: { addListener() {} } },
    tabs: { query(_query, callback) { callback([]); } },
    action: { setIcon() {} }
  };
  const context = {
    chrome,
    URL,
    console: { info() {} },
    fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
    setTimeout: callback => { callback(); return 1; },
    clearTimeout() {},
    feedpeckerWebExt: { storage: { get: read, set: write }, tabs: { sendMessage: async () => {} } }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));

  const ownSender = { id: 'feedpecker-test', url: 'chrome-extension://feedpecker-test/popup.html' };
  const xSender = { id: 'feedpecker-test', tab: { url: 'https://x.com/home' } };
  const foreignSender = { id: 'another-extension', tab: { url: 'https://x.com/home' } };
  const ask = (request, sender) => new Promise(resolve => {
    const asynchronous = messageListener(request, sender, resolve);
    if (!asynchronous) resolve(undefined);
  });

  const settings = await ask({ type: 'getSettings' }, ownSender);
  assert.equal(settings.extension_enabled, true);
  assert.deepEqual([...settings.blocked_countries], ['Germany']);
  assert.equal(await ask({ type: 'countrySpotted', country: 'Mexico' }, foreignSender), undefined);
  await ask({ type: 'countrySpotted', country: 'Mexico' }, xSender);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.extension_stats.totalScanned, 5);
  assert.equal(values.extension_stats.seenCountries.Mexico, 1);
  const savedProfile = await ask({ type: 'filteredAccount', screenName: 'valid_user', country: 'Mexico' }, xSender);
  assert.equal(savedProfile.ok, true);
  assert.equal(values.filtered_accounts.valid_user.country, 'Mexico');
});

test('analytics bars expose blocked counts on hover and keyboard focus', async () => {
  const [dashboardScript, dashboardStyles] = await Promise.all([
    readFile(path.join(output, 'dashboard.js'), 'utf8'),
    readFile(path.join(output, 'dashboard.css'), 'utf8')
  ]);

  assert.match(dashboardScript, /day\.tabIndex = 0/);
  assert.match(dashboardScript, /profileWord = item\.profiles === 1 \? 'profile' : 'profiles'/);
  assert.match(dashboardScript, /\$\{profileWord\} blocked/);
  assert.match(dashboardScript, /tooltip\.className = 'activity-tooltip'/);
  assert.match(dashboardStyles, /\.activity-day:hover \.activity-tooltip/);
  assert.match(dashboardStyles, /\.activity-day:focus-visible \.activity-tooltip/);
});

test('version-one portable backups remain importable after the rebrand', async () => {
  const source = await readFile(path.join(output, 'backup.js'), 'utf8');
  const context = {
    feedpeckerWebExt: {
      storage: {},
      tabs: {}
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  const backup = context.FeedpeckerBackup.validateBackup({
    format: 'previous-project-backup',
    version: 1,
    storage: { extension_enabled: true, hide_animation: false }
  });
  assert.equal(backup.storage.extension_enabled, true);
  assert.equal(backup.storage.hide_animation, false);
  const detailed = context.FeedpeckerBackup.validateBackup({
    format: 'feedpecker-backup',
    version: 1,
    storage: {
      blocked_countries: ['Germany', 'Germany', 'South America'],
      extension_stats: {
        totalScanned: 12,
        scannedByDay: { '2026-08-12': 4, nope: 9 },
        blockedByDay: { '2026-08-12': 2 }
      },
      filtered_accounts: {
        one: { screenName: '@Valid_User', country: 'Germany', location: 'Berlin, Germany', verified: true, lastSeen: 3 },
        two: { screenName: 'not valid!', country: 'Spain' }
      },
      profile_visibility_overrides: { Valid_User: 'show', invalid: 'maybe' }
    },
    locationCache: [{ username: 'Valid_User', location: 'Germany', expiry: Date.now() + 1000, resultVersion: 1 }]
  });
  assert.deepEqual([...detailed.storage.blocked_countries], ['Germany', 'South America']);
  assert.equal(detailed.storage.extension_stats.scannedByDay['2026-08-12'], 4);
  assert.equal(detailed.storage.extension_stats.scannedByDay.nope, undefined);
  assert.equal(Object.keys(detailed.storage.filtered_accounts).length, 1);
  assert.equal(detailed.storage.profile_visibility_overrides.valid_user, 'show');
  assert.equal(detailed.locationCache[0].resultVersion, 1);
  assert.throws(() => context.FeedpeckerBackup.validateBackup({ format: 'feedpecker-backup', version: 2, storage: { extension_enabled: true } }), /newer extension version/);
});

test('hide animation is wired through settings and both filtering paths', async () => {
  const [background, content, popup, popupScript] = await Promise.all([
    readFile(path.join(output, 'background.js'), 'utf8'),
    readFile(path.join(output, 'content.js'), 'utf8'),
    readFile(path.join(output, 'popup.html'), 'utf8'),
    readFile(path.join(output, 'popup.js'), 'utf8')
  ]);

  assert.match(background, /hide_animation/);
  assert.match(content, /function hideArticle\(/);
  assert.equal((content.match(/^\s+hideArticle\(article, screenNameKey\);$/gm) || []).length, 2);
  assert.match(content, /prefers-reduced-motion: reduce/);
  assert.match(content, /hide-animation-(?:start|skipped)/);
  assert.match(content, /hide-animation-pending/);
  assert.match(content, /function queueArticleHideForViewport\(/);
  assert.match(content, /rootMargin: '0px'/);
  assert.match(content, /if \(canAnimate && !visible && queueArticleHideForViewport\(article, screenNameKey\)\) return true/);
  assert.match(content, /function flushPendingArticleHides\(/);
  assert.match(content, /const HIDE_SCROLL_SETTLE_MS = 160/);
  assert.match(content, /function noteTimelineScroll\(/);
  assert.match(content, /pendingHide\.enteredViewport = true/);
  assert.match(content, /hide-animation-fast-scroll/);
  assert.match(content, /skipAnimation: true/);
  assert.match(content, /tf-smash-wave--core/);
  assert.match(content, /tf-smash-wave--glow/);
  assert.match(content, /tf-hide-sparks--fixed/);
  assert.match(content, /const collapseDuration = 250/);
  assert.match(content, /sprites\/feedpecker-flight\.png/);
  assert.match(content, /tf-smash-bird-sprite/);
  assert.match(content, /transform: 'translateX\(-66\.6667%\)'/);
  assert.match(content, /offset: 1 \/ 3, easing: 'steps\(1, end\)'/);
  assert.match(content, /function chooseBirdFlightDirection\(\)/);
  assert.match(content, /sameDirectionFlightCount >= 2/);
  assert.match(content, /const birdDirection = chooseBirdFlightDirection\(\)/);
  assert.match(content, /offset: \.82/);
  assert.match(content, /function getHideRecoilTargets\(/);
  assert.match(content, /direction \* 7/);
  assert.doesNotMatch(content, /const shakeTarget = article\.parentElement/);
  assert.match(content, /duration: 860, delay: impactDelay/);
  assert.match(content, /duration: 215, delay: impactDelay, iterations: 4, easing: 'linear'/);
  assert.match(popup, /id="hideAnimationToggle"/);
  assert.match(popupScript, /HIDE_ANIMATION_KEY/);
  assert.doesNotMatch(content, /testHideAnimation/);
  assert.doesNotMatch(popup, /testHideAnimation|animation-test/);
  assert.doesNotMatch(popupScript, /testHideAnimation|animationTestMessage/);
  assert.match(content, /const BLOCKED_COUNTRIES_KEY = 'blocked_countries'/);
  assert.match(content, /changes\[BLOCKED_COUNTRIES_KEY\]/);
  assert.match(content, /parseRegions\(changes\[BLOCKED_COUNTRIES_KEY\]\.newValue \|\| \[\]\)/);
});

test('exported icons contain real transparent and opaque pixels', async () => {
  for (const size of [16, 48, 128]) {
    const png = await readFile(path.join(output, 'icons', `${size}.png`));
    assert.deepEqual(pngAlphaRange(png), { minimum: 0, maximum: 255 });
  }
});

test('flight sprite is exported with transparent and opaque pixels', async () => {
  const png = await readFile(path.join(output, 'sprites', 'feedpecker-flight.png'));
  assert.deepEqual(pngAlphaRange(png), { minimum: 0, maximum: 255 });
});
