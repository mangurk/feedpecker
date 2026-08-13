const FILTERED_ACCOUNTS_KEY = 'filtered_accounts';
const PROFILE_VISIBILITY_OVERRIDES_KEY = 'profile_visibility_overrides';
const ACTION_BUDGET_KEY = 'account_action_budget';
const ACTION_MAX_WAIT_MS = 20 * 60 * 1000;
const BACKUP_FILE_NAME = 'feedpecker-backup.json';
const MAX_BACKUP_FILE_BYTES = 20 * 1024 * 1024;
const { storage: extensionStorage, tabs: extensionTabs } = globalThis.feedpeckerWebExt;

let accounts = [];
let activeFilter = 'unblocked';
let searchQuery = '';
let currentPage = 1;
let pageSize = 50;
let bulkRunning = false;
let stopBulkRequested = false;
const selected = new Set();
const busy = new Set();

const els = {
  refreshBtn: document.getElementById('refreshBtn'),
  backupToggle: document.getElementById('backupToggle'),
  backupContent: document.getElementById('backupContent'),
  backupPanel: document.querySelector('.backup-panel'),
  controlPanel: document.getElementById('controlPanel'),
  controlPanelSentinel: document.getElementById('controlPanelSentinel'),
  summary: document.getElementById('filteredSummary'),
  emptyState: document.getElementById('emptyState'),
  profileList: document.getElementById('profileList'),
  search: document.getElementById('profileSearch'),
  selectAll: document.getElementById('selectAll'),
  selectAllLabel: document.getElementById('selectAllLabel'),
  bulkAction: document.getElementById('bulkActionBtn'),
  bulkStatus: document.getElementById('bulkStatus'),
  stopBulk: document.getElementById('stopBulkBtn'),
  downloadBackup: document.getElementById('downloadBackupBtn'),
  restoreBackup: document.getElementById('restoreBackupBtn'),
  clearFiltered: document.getElementById('clearFilteredBtn'),
  restoreBackupInput: document.getElementById('restoreBackupInput'),
  backupStatus: document.getElementById('backupStatus'),
  pagination: document.getElementById('profilePagination'),
  pageRange: document.getElementById('pageRange'),
  pageStatus: document.getElementById('pageStatus'),
  previousPage: document.getElementById('previousPageBtn'),
  nextPage: document.getElementById('nextPageBtn'),
  confirmModal: document.getElementById('confirmModal'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmMessage: document.getElementById('confirmMessage'),
  confirmDetail: document.getElementById('confirmDetail'),
  confirmCancel: document.getElementById('confirmCancelBtn'),
  confirmAccept: document.getElementById('confirmAcceptBtn'),
  bulkProgressModal: document.getElementById('bulkProgressModal'),
  bulkProgressKicker: document.getElementById('bulkProgressKicker'),
  bulkProgressTitle: document.getElementById('bulkProgressTitle'),
  bulkProgressMessage: document.getElementById('bulkProgressMessage'),
  bulkProgressCount: document.getElementById('bulkProgressCount'),
  bulkProgressPercent: document.getElementById('bulkProgressPercent'),
  bulkProgressTrack: document.getElementById('bulkProgressTrack'),
  bulkProgressFill: document.getElementById('bulkProgressFill'),
  bulkProgressStatus: document.getElementById('bulkProgressStatus'),
  bulkProgressStop: document.getElementById('bulkProgressStopBtn'),
  bulkProgressClose: document.getElementById('bulkProgressCloseBtn'),
  pageToast: document.getElementById('pageToast'),
  pageToastMessage: document.getElementById('pageToastMessage'),
  pageToastClose: document.getElementById('pageToastClose'),
  pageSizeOptions: Array.from(document.querySelectorAll('[data-page-size]')),
  filterTabs: Array.from(document.querySelectorAll('.filter-tab'))
};

let confirmationResolver = null;
let confirmationPreviousFocus = null;
let pageToastTimer = null;

function hasExtensionRuntime() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id && chrome.storage?.local);
}

function setBackupExpanded(expanded) {
  const isExpanded = expanded === true;
  els.backupToggle.setAttribute('aria-expanded', String(isExpanded));
  els.backupContent.hidden = !isExpanded;
  els.backupPanel.classList.toggle('is-open', isExpanded);
}

els.backupToggle.addEventListener('click', () => {
  setBackupExpanded(els.backupToggle.getAttribute('aria-expanded') !== 'true');
});

const stickyPanelObserver = new IntersectionObserver(([entry]) => {
  const isStuck = !entry.isIntersecting && entry.boundingClientRect.top < 5;
  els.controlPanel.classList.toggle('is-stuck', isStuck);
}, { rootMargin: '-5px 0px 0px 0px', threshold: 0 });
stickyPanelObserver.observe(els.controlPanelSentinel);

function setBackupStatus(message, state = '') {
  els.backupStatus.textContent = message;
  if (state) els.backupStatus.dataset.state = state;
  else delete els.backupStatus.dataset.state;
}

function dismissPageToast() {
  clearTimeout(pageToastTimer);
  pageToastTimer = null;
  els.pageToast.hidden = true;
}

function schedulePageToastDismiss(delay = 5000) {
  clearTimeout(pageToastTimer);
  pageToastTimer = setTimeout(() => {
    if (els.pageToast.matches(':hover')) {
      schedulePageToastDismiss(1200);
      return;
    }
    dismissPageToast();
  }, delay);
}

function showPageToast(message, tone = 'notice') {
  els.pageToastMessage.textContent = message;
  els.pageToast.dataset.tone = tone;
  els.pageToast.hidden = false;
  schedulePageToastDismiss();
}

els.pageToast.addEventListener('click', dismissPageToast);
els.pageToastClose.addEventListener('click', event => {
  event.stopPropagation();
  dismissPageToast();
});

function closeConfirmation(accepted) {
  if (els.confirmModal.hidden) return;
  els.confirmModal.hidden = true;
  els.confirmModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  const resolve = confirmationResolver;
  confirmationResolver = null;
  resolve?.(accepted === true);
  if (confirmationPreviousFocus?.isConnected) confirmationPreviousFocus.focus();
  confirmationPreviousFocus = null;
}

function showConfirmation({ title, message, detail = '', confirmLabel = 'Confirm', tone = 'danger' }) {
  if (confirmationResolver) closeConfirmation(false);
  confirmationPreviousFocus = document.activeElement;
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmDetail.textContent = detail;
  els.confirmDetail.hidden = !detail;
  els.confirmAccept.textContent = confirmLabel;
  els.confirmAccept.dataset.tone = tone;
  els.confirmModal.hidden = false;
  els.confirmModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => els.confirmCancel.focus());
  return new Promise(resolve => { confirmationResolver = resolve; });
}

function updateBulkProgress(completed, total, status) {
  const safeTotal = Math.max(0, total);
  const safeCompleted = Math.max(0, Math.min(completed, safeTotal));
  const percent = safeTotal ? Math.round((safeCompleted / safeTotal) * 100) : 0;
  els.bulkProgressCount.textContent = `${safeCompleted} of ${safeTotal} completed`;
  els.bulkProgressPercent.textContent = `${percent}%`;
  els.bulkProgressFill.style.width = `${percent}%`;
  els.bulkProgressTrack.setAttribute('aria-valuemax', String(safeTotal));
  els.bulkProgressTrack.setAttribute('aria-valuenow', String(safeCompleted));
  els.bulkProgressStatus.textContent = status;
}

function openBulkProgress(total, action = 'block') {
  const unblocking = action === 'unblock';
  els.bulkProgressKicker.textContent = unblocking ? 'Bulk unblock' : 'Bulk block';
  els.bulkProgressTitle.textContent = unblocking ? 'Unblocking selected profiles' : 'Blocking selected profiles';
  els.bulkProgressMessage.textContent = 'Please don’t close this window while requests are being processed.';
  els.bulkProgressStop.hidden = false;
  els.bulkProgressStop.disabled = false;
  els.bulkProgressStop.textContent = 'Stop after current request';
  els.bulkProgressClose.hidden = true;
  updateBulkProgress(0, total, 'Preparing the first request…');
  els.bulkProgressModal.hidden = false;
  els.bulkProgressModal.setAttribute('aria-hidden', 'false');
  els.bulkProgressTrack.setAttribute('aria-label', unblocking ? 'Bulk unblock progress' : 'Bulk block progress');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => els.bulkProgressStop.focus());
}

function finishBulkProgress(completed, total, message, state = 'complete', action = 'block') {
  const actionLabel = action === 'unblock' ? 'unblock' : 'block';
  updateBulkProgress(completed, total, message);
  els.bulkProgressTitle.textContent = state === 'complete'
    ? `Bulk ${actionLabel} complete`
    : state === 'stopped'
      ? `Bulk ${actionLabel} stopped`
      : `Bulk ${actionLabel} interrupted`;
  els.bulkProgressMessage.textContent = state === 'complete'
    ? 'Every selected request was completed.'
    : 'Completed requests remain saved. You can select the remaining profiles and continue later.';
  els.bulkProgressStop.hidden = true;
  els.bulkProgressClose.hidden = false;
  requestAnimationFrame(() => els.bulkProgressClose.focus());
}

function closeBulkProgress() {
  if (bulkRunning) return;
  els.bulkProgressModal.hidden = true;
  els.bulkProgressModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function requestBulkStop() {
  if (!bulkRunning || stopBulkRequested) return;
  stopBulkRequested = true;
  els.bulkStatus.textContent = 'Stopping after the current request…';
  els.bulkProgressStop.disabled = true;
  els.bulkProgressStop.textContent = 'Stopping…';
  els.bulkProgressStatus.textContent = 'Stopping safely after the current request…';
}

els.confirmCancel.addEventListener('click', () => closeConfirmation(false));
els.confirmAccept.addEventListener('click', () => closeConfirmation(true));
els.confirmModal.querySelector('[data-confirm-dismiss]').addEventListener('click', () => closeConfirmation(false));
document.addEventListener('keydown', event => {
  if (els.confirmModal.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeConfirmation(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [els.confirmCancel, els.confirmAccept];
  const index = focusable.indexOf(document.activeElement);
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    els.confirmAccept.focus();
  } else if (!event.shiftKey && index === focusable.length - 1) {
    event.preventDefault();
    els.confirmCancel.focus();
  }
});

async function downloadBackup() {
  if (!hasExtensionRuntime()) return;
  els.downloadBackup.disabled = true;
  setBackupStatus('Preparing complete backup…');
  try {
    const backup = await FeedpeckerBackup.createBackup();
    FeedpeckerBackup.download(BACKUP_FILE_NAME, 'application/json', `${JSON.stringify(backup, null, 2)}\n`);
    if (backup.cacheIncluded) {
      setBackupStatus(`Backup downloaded with ${backup.cacheEntryCount} cached lookups.`, 'ready');
    } else {
      setBackupStatus('Backup downloaded. After restoring, some profile locations may need to be checked again.', 'warning');
    }
  } catch (error) {
    setBackupStatus(`Backup failed: ${error?.message || error}`, 'error');
  } finally {
    els.downloadBackup.disabled = false;
  }
}

async function restoreBackupFile(file) {
  if (!file || !hasExtensionRuntime()) return;
  try {
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      throw new Error('This backup is too large to import safely.');
    }
    const parsed = JSON.parse(await file.text());
    const validated = FeedpeckerBackup.validateBackup(parsed);
    const profiles = Object.keys(validated.storage.filtered_accounts || {}).length;
    const confirmed = await showConfirmation({
      title: 'Restore this backup?',
      message: "This replaces the extension's current portable data with the selected backup.",
      detail: `${profiles} filtered profiles and ${validated.locationCache.length} cached lookups are included.`,
      confirmLabel: 'Restore backup'
    });
    if (!confirmed) return;
    els.restoreBackup.disabled = true;
    setBackupStatus('Restoring backup…');
    const result = await FeedpeckerBackup.restoreBackup(parsed);
    await loadAccounts();
    if (result.cache.ok) {
      setBackupStatus(`Backup restored · ${profiles} profiles · ${result.cache.count} cached lookups`, 'ready');
    } else {
      setBackupStatus(result.cache.reason || 'Core data restored, but the lookup cache was skipped.', 'warning');
    }
  } catch (error) {
    setBackupStatus(`Restore failed: ${error?.message || error}`, 'error');
  } finally {
    els.restoreBackup.disabled = false;
    els.restoreBackupInput.value = '';
  }
}

function cleanHandle(screenName) {
  return String(screenName || '').replace(/^@/, '');
}

function accountKey(account) {
  return cleanHandle(account.screenName).toLowerCase();
}

function getFlagCode(account) {
  return typeof getCountryFlag === 'function' ? (getCountryFlag(account.country) || '') : '';
}

function profileUrl(screenName) {
  return `https://x.com/${encodeURIComponent(cleanHandle(screenName))}`;
}

function formatLastSeen(timestamp) {
  if (!timestamp) return 'Seen recently';
  const value = new Date(timestamp);
  const today = new Date();
  if (value.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value);
}

function formatRelationshipObserved(timestamp) {
  if (!timestamp) return 'Follow status was observed previously on X.';
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return 'Follow status was observed previously on X.';
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(value);
  return `Following status last confirmed ${formatted}.`;
}

function readAccounts(raw, rawOverrides) {
  const overrides = rawOverrides && typeof rawOverrides === 'object' ? rawOverrides : {};
  const records = new Map();
  for (const account of Object.values(raw || {})) {
    if (!account?.screenName) continue;
    const key = accountKey(account);
    records.set(key, { ...account, visibility: overrides[key] || '' });
  }
  // Older builds removed the profile record when Unhide was clicked. Preserve
  // those existing exclusions as handle-only rows until metadata is seen again.
  for (const [rawHandle, visibility] of Object.entries(overrides)) {
    if (visibility !== 'show' && visibility !== 'hide') continue;
    const screenName = cleanHandle(rawHandle);
    const key = screenName.toLowerCase();
    if (!screenName || records.has(key)) continue;
    records.set(key, {
      screenName,
      location: '',
      country: '',
      verified: false,
      blocked: false,
      lastSeen: 0,
      visibility
    });
  }
  return Array.from(records.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function getVisibleAccounts() {
  const query = searchQuery.trim().toLowerCase();
  return accounts.filter(account => {
    if (activeFilter === 'blocked' && !account.blocked) return false;
    if (activeFilter === 'unblocked' && account.blocked) return false;
    if (!query) return true;
    const status = account.blocked ? 'blocked' : account.visibility === 'show' ? 'excluded' : 'filtered';
    const relationship = account.following === true ? 'following' : '';
    return [account.screenName, account.location, account.country, status, relationship]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function canSelectAccount(account) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'unblocked') return !account.blocked;
  if (activeFilter === 'blocked') return account.blocked;
  return false;
}

function getSelectableAccounts(filtered = getVisibleAccounts()) {
  return filtered.filter(canSelectAccount);
}

async function loadAccounts() {
  const result = await extensionStorage.get([FILTERED_ACCOUNTS_KEY, PROFILE_VISIBILITY_OVERRIDES_KEY]);
  accounts = readAccounts(result[FILTERED_ACCOUNTS_KEY], result[PROFILE_VISIBILITY_OVERRIDES_KEY]);
  for (const key of Array.from(selected)) {
    const account = accounts.find(item => accountKey(item) === key);
    if (!account || !canSelectAccount(account)) selected.delete(key);
  }
  renderAccounts();
}

function syncSelectionControls(filtered) {
  const selectionAvailable = true;
  const selectable = getSelectableAccounts(filtered);
  const selectedMatches = selectable.filter(account => selected.has(accountKey(account))).length;
  const selectionControl = els.selectAll.closest('.select-all-control');
  selectionControl.hidden = !selectionAvailable;
  els.bulkAction.hidden = !selectionAvailable;
  els.selectAll.checked = selectionAvailable && selectable.length > 0 && selectedMatches === selectable.length;
  els.selectAll.indeterminate = selectionAvailable && selectedMatches > 0 && selectedMatches < selectable.length;
  els.selectAll.disabled = bulkRunning || selectable.length === 0;
  els.selectAllLabel.textContent = selectable.length ? `Select all ${selectable.length}` : 'Select all';
  els.bulkAction.disabled = bulkRunning || selectedMatches === 0;
  const actionLabel = activeFilter === 'all'
    ? 'Delete selected'
    : activeFilter === 'blocked'
      ? 'Unblock selected'
      : 'Block selected';
  els.bulkAction.textContent = selectedMatches ? `${actionLabel} (${selectedMatches})` : actionLabel;
  els.bulkAction.classList.toggle('is-delete', activeFilter === 'all');
  els.bulkAction.classList.toggle('is-unblock', activeFilter === 'blocked');
}

function getCurrentPageAccounts(filtered = getVisibleAccounts()) {
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  const start = (currentPage - 1) * pageSize;
  return filtered.slice(start, start + pageSize);
}

function renderPagination(total) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, total);
  els.pagination.hidden = total === 0;
  els.pageRange.textContent = total ? `${start}–${end} of ${total}` : '0 profiles';
  els.pageStatus.textContent = `Page ${currentPage} of ${totalPages}`;
  els.previousPage.disabled = currentPage <= 1;
  els.nextPage.disabled = currentPage >= totalPages;
  els.pageSizeOptions.forEach(button => button.classList.toggle('active', Number(button.dataset.pageSize) === pageSize));
}

function renderAccounts() {
  const filtered = getVisibleAccounts();
  const visible = getCurrentPageAccounts(filtered);
  els.clearFiltered.disabled = bulkRunning || accounts.length === 0;
  els.profileList.textContent = '';
  els.profileList.hidden = filtered.length === 0;
  els.emptyState.hidden = filtered.length > 0;
  els.summary.textContent = filtered.length === accounts.length
    ? `${accounts.length} profile${accounts.length === 1 ? '' : 's'}`
    : `${filtered.length} of ${accounts.length} profiles`;

  const fragment = document.createDocumentFragment();
  for (const account of visible) fragment.appendChild(createRow(account));
  els.profileList.appendChild(fragment);
  syncSelectionControls(filtered);
  renderPagination(filtered.length);
}

function setProfileVisibilityFromList(account, visibility) {
  if (!hasExtensionRuntime()) {
    account.visibility = visibility === 'default' ? '' : visibility;
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        type: 'setProfileVisibility',
        visibility,
        screenName: cleanHandle(account.screenName),
        location: account.location,
        country: account.country,
        verified: account.verified === true,
        exclusionReason: visibility === 'show' ? 'manual' : ''
      }, response => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(response?.ok === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function toggleProfileExclusion(account) {
  if (account.blocked || bulkRunning) return;
  const key = accountKey(account);
  const excluded = account.visibility === 'show';
  const followedExclusion = excluded && account.following === true;
  const nextVisibility = excluded ? (followedExclusion ? 'hide' : 'default') : 'show';
  busy.add(key);
  renderAccounts();
  const updated = await setProfileVisibilityFromList(account, nextVisibility);
  busy.delete(key);
  if (!updated) {
    showPageToast(`Could not ${excluded ? 'restore filtering for' : 'exclude'} @${cleanHandle(account.screenName)}.`, 'error');
    renderAccounts();
    return;
  }
  showPageToast(excluded
    ? followedExclusion
      ? `@${cleanHandle(account.screenName)} will be hidden despite being followed.`
      : `Country filtering restored for @${cleanHandle(account.screenName)}.`
    : `@${cleanHandle(account.screenName)} excluded from country filtering.`, excluded ? 'success' : 'notice');
  if (hasExtensionRuntime()) await loadAccounts();
  else renderAccounts();
}

function createRow(account) {
  const key = accountKey(account);
  const selectionAvailable = true;
  const row = document.createElement('article');
  row.className = `profile-row${selected.has(key) ? ' selected' : ''}${selectionAvailable ? '' : ' no-selection'}`;
  row.tabIndex = 0;
  row.setAttribute('role', 'link');
  row.setAttribute('aria-label', `Open ${cleanHandle(account.screenName)} on X`);

  const checkWrap = document.createElement('label');
  checkWrap.className = 'row-check';
  checkWrap.addEventListener('click', event => event.stopPropagation());
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(key);
  checkbox.disabled = !canSelectAccount(account) || bulkRunning;
  checkbox.setAttribute('aria-label', `Select @${cleanHandle(account.screenName)}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(key);
    else selected.delete(key);
    renderAccounts();
  });
  checkWrap.appendChild(checkbox);

  const identity = document.createElement('div');
  identity.className = 'identity';
  const flag = document.createElement('div');
  flag.className = 'flag';
  const flagCode = getFlagCode(account);
  if (flagCode) {
    const flagImage = document.createElement('img');
    flagImage.src = getFlagAssetUrl(flagCode);
    flagImage.alt = `${account.country} flag`;
    flagImage.addEventListener('error', () => {
      flagImage.remove();
      flag.classList.add('is-missing');
    }, { once: true });
    flag.appendChild(flagImage);
  } else if (isRegionalAggregate(account.country)) {
    flag.classList.add('is-region');
    const regionIcon = createRegionalAggregateIcon(`${account.country} regional aggregate`);
    if (regionIcon) flag.appendChild(regionIcon);
  } else {
    flag.classList.add('is-missing');
    flag.setAttribute('aria-hidden', 'true');
  }
  const identityCopy = document.createElement('div');
  identityCopy.className = 'identity-copy';
  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.textContent = `@${cleanHandle(account.screenName)}`;
  const handleRow = document.createElement('div');
  handleRow.className = 'handle-row';
  handleRow.appendChild(handle);
  if (account.following === true) {
    const relationship = document.createElement('span');
    relationship.className = 'relationship-pill';
    relationship.title = `${formatRelationshipObserved(account.relationshipObservedAt)} No lookup was made when this page opened.`;
    relationship.setAttribute('aria-label', relationship.title);
    const relationshipIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    relationshipIcon.setAttribute('viewBox', '0 0 24 24');
    relationshipIcon.setAttribute('aria-hidden', 'true');
    const relationshipCheck = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    relationshipCheck.setAttribute('d', 'M4.5 12.5 9.5 17.5 19.5 6.5');
    relationshipIcon.appendChild(relationshipCheck);
    relationship.append(relationshipIcon, document.createTextNode('Following'));
    handleRow.appendChild(relationship);
  }
  const location = document.createElement('div');
  location.className = 'location';
  location.textContent = account.location || 'Location unavailable';
  identityCopy.append(handleRow, location);
  identity.append(flag, identityCopy);

  const country = document.createElement('div');
  country.className = 'country';
  country.textContent = account.country || 'Unknown origin';

  const seen = document.createElement('div');
  seen.className = 'last-seen';
  seen.textContent = formatLastSeen(account.lastSeen);

  const excluded = account.visibility === 'show';
  const automaticFollowingExclusion = excluded && account.exclusionReason === 'following';
  const status = document.createElement(account.blocked ? 'span' : 'button');
  status.className = `status-pill${account.blocked ? ' blocked' : excluded ? ' excluded is-clickable' : ' is-clickable'}`;
  status.textContent = busy.has(key) ? 'Updating…' : account.blocked ? 'Blocked' : excluded ? 'Excluded' : 'Filtered';
  if (!account.blocked) {
    status.type = 'button';
    status.disabled = busy.has(key) || bulkRunning;
    status.setAttribute('aria-label', excluded
      ? automaticFollowingExclusion
        ? `Automatically excluded because you follow @${cleanHandle(account.screenName)}. Hide this profile despite following it`
        : `Restore country filtering for @${cleanHandle(account.screenName)}`
      : `Exclude @${cleanHandle(account.screenName)} from country filtering`);
    status.title = excluded
      ? automaticFollowingExclusion
        ? 'Automatically excluded because you follow this profile. Click to hide it anyway.'
        : 'Click to restore country filtering'
      : 'Click to exclude from country filtering';
    status.addEventListener('click', event => {
      event.stopPropagation();
      toggleProfileExclusion(account);
    });
  }

  const action = document.createElement('button');
  const deleteMode = activeFilter === 'all';
  action.className = `action-btn${deleteMode ? ' is-delete' : account.blocked ? ' is-blocked' : ''}`;
  action.type = 'button';
  action.disabled = busy.has(key) || bulkRunning;
  action.textContent = busy.has(key) ? 'Working…' : deleteMode ? 'Delete' : account.blocked ? 'Unblock' : 'Block';
  action.addEventListener('click', event => {
    event.stopPropagation();
    runAction(account);
  });

  if (selectionAvailable) row.append(checkWrap);
  row.append(identity, country, seen, status, action);
  const openAccount = () => window.open(profileUrl(account.screenName), '_blank');
  row.addEventListener('click', openAccount);
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter') openAccount();
  });
  return row;
}

async function sendAccountAction(account, action) {
  const tabs = await extensionTabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const tab = tabs.find(candidate => candidate.active) || tabs[0];
  if (!tab?.id) throw new Error('Open an X tab first so the extension can send the action.');
  const response = await extensionTabs.sendMessage(tab.id, {
    type: 'accountAction',
    screenName: cleanHandle(account.screenName),
    action
  });
  if (!response?.queued) throw new Error('The X tab is not ready. Refresh it and try again.');
  return response;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAction(account, action, startedAt, onWait) {
  const key = accountKey(account);
  const expectedBlocked = action === 'block';
  const deadline = Date.now() + ACTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await extensionStorage.get([FILTERED_ACCOUNTS_KEY, ACTION_BUDGET_KEY]);
    const fresh = result[FILTERED_ACCOUNTS_KEY]?.[key];
    if (fresh?.lastAction >= startedAt) {
      if (fresh.lastActionOk === true && fresh.blocked === expectedBlocked) return fresh;
      const suffix = fresh.lastActionStatus ? ` (X returned ${fresh.lastActionStatus})` : '';
      throw new Error(`X rejected the ${action} request${suffix}.`);
    }
    const budget = result[ACTION_BUDGET_KEY];
    const nextAt = Number(budget?.nextAt);
    if (typeof onWait === 'function' && Number.isFinite(nextAt) && nextAt > Date.now()) {
      onWait({
        waitingMs: nextAt - Date.now(),
        remaining: Number.isFinite(budget.remaining) ? budget.remaining : null,
        resetAt: Number.isFinite(budget.resetAt) ? budget.resetAt : null,
        rateLimited: budget.rateLimited === true
      });
    }
    await delay(250);
  }
  throw new Error(`X did not confirm the ${action} request in time.`);
}

async function performAction(account, action, onWait) {
  const startedAt = Date.now();
  const queued = await sendAccountAction(account, action);
  if (typeof onWait === 'function' && queued.estimatedWaitMs > 0) {
    onWait({ waitingMs: queued.estimatedWaitMs, remaining: null, resetAt: null, rateLimited: false });
  }
  return waitForAction(account, action, startedAt, onWait);
}

async function deleteProfileRecords(targets) {
  const keys = new Set(targets.map(accountKey));
  if (!keys.size) return;

  if (hasExtensionRuntime()) {
    const result = await extensionStorage.get([FILTERED_ACCOUNTS_KEY, PROFILE_VISIBILITY_OVERRIDES_KEY]);
    const records = result[FILTERED_ACCOUNTS_KEY] && typeof result[FILTERED_ACCOUNTS_KEY] === 'object'
      ? { ...result[FILTERED_ACCOUNTS_KEY] }
      : {};
    const overrides = result[PROFILE_VISIBILITY_OVERRIDES_KEY] && typeof result[PROFILE_VISIBILITY_OVERRIDES_KEY] === 'object'
      ? { ...result[PROFILE_VISIBILITY_OVERRIDES_KEY] }
      : {};
    for (const key of keys) {
      delete records[key];
      delete overrides[key];
    }
    await extensionStorage.set({
      [FILTERED_ACCOUNTS_KEY]: records,
      [PROFILE_VISIBILITY_OVERRIDES_KEY]: overrides
    });
    await loadAccounts();
  } else {
    accounts = accounts.filter(account => !keys.has(accountKey(account)));
    renderAccounts();
  }

  for (const key of keys) selected.delete(key);
}

function deletionDetail(targets) {
  const blockedCount = targets.filter(account => account.blocked).length;
  const blockedWarning = blockedCount
    ? `${blockedCount} blocked profile${blockedCount === 1 ? '' : 's'} will remain blocked on X. `
    : '';
  return `${blockedWarning}Profiles that still match an active country filter may be detected and added again later.`;
}

async function runDeleteAction(account) {
  const handle = cleanHandle(account.screenName);
  const confirmed = await showConfirmation({
    title: `Delete @${handle} from this list?`,
    message: 'This removes only the local filtered-profile record and its manual visibility setting.',
    detail: deletionDetail([account]),
    confirmLabel: 'Delete profile'
  });
  if (!confirmed) return;
  try {
    await deleteProfileRecords([account]);
  } catch (error) {
    setBackupStatus(`Delete failed: ${error?.message || error}`, 'error');
  }
}

async function runBulkDelete() {
  const targets = getSelectableAccounts().filter(account => selected.has(accountKey(account)));
  if (!targets.length || bulkRunning) return;
  const confirmed = await showConfirmation({
    title: `Delete ${targets.length} selected profile${targets.length === 1 ? '' : 's'}?`,
    message: 'This removes the selected records from the local filtered-profiles list.',
    detail: deletionDetail(targets),
    confirmLabel: `Delete ${targets.length} profile${targets.length === 1 ? '' : 's'}`
  });
  if (!confirmed) return;
  try {
    await deleteProfileRecords(targets);
    els.bulkStatus.hidden = false;
    els.bulkStatus.textContent = `Deleted ${targets.length} profile${targets.length === 1 ? '' : 's'}`;
  } catch (error) {
    els.bulkStatus.hidden = false;
    els.bulkStatus.textContent = `Delete failed: ${error?.message || error}`;
  }
}

async function clearFilteredProfiles() {
  if (!accounts.length) return;
  const targets = [...accounts];
  const confirmed = await showConfirmation({
    title: 'Clear all filtered profiles?',
    message: `This removes all ${targets.length} local profile records and manual hide/show choices. Dashboard analytics and country filters are not changed.`,
    detail: deletionDetail(targets),
    confirmLabel: 'Clear profiles'
  });
  if (!confirmed) return;
  els.clearFiltered.disabled = true;
  try {
    await deleteProfileRecords(targets);
    setBackupStatus('Filtered profiles cleared. Your settings and analytics were kept.', 'ready');
  } catch (error) {
    setBackupStatus(`Clear failed: ${error?.message || error}`, 'error');
  } finally {
    els.clearFiltered.disabled = accounts.length === 0;
  }
}

async function runAction(account) {
  if (activeFilter === 'all') {
    await runDeleteAction(account);
    return;
  }
  const action = account.blocked ? 'unblock' : 'block';
  const handle = cleanHandle(account.screenName);
  const confirmed = await showConfirmation({
    title: `${action === 'block' ? 'Block' : 'Unblock'} @${handle}?`,
    message: action === 'block'
      ? 'This sends a block request to X. The profile will remain in your local filtered list.'
      : 'This sends an unblock request to X. The profile will remain in your local filtered list.',
    confirmLabel: action === 'block' ? 'Block on X' : 'Unblock on X',
    tone: action === 'block' ? 'danger' : 'neutral'
  });
  if (!confirmed) return;
  const key = accountKey(account);
  busy.add(key);
  renderAccounts();
  try {
    await performAction(account, action);
    if (action === 'block') selected.delete(key);
    await loadAccounts();
  } catch (error) {
    window.alert(error?.message || 'Could not complete the request.');
  } finally {
    busy.delete(key);
    renderAccounts();
  }
}

async function runBulkAccountAction(action) {
  const targets = getSelectableAccounts().filter(account => selected.has(accountKey(account)));
  if (!targets.length || bulkRunning) return;
  const unblocking = action === 'unblock';
  const actionTitle = unblocking ? 'Unblock' : 'Block';
  const actionPresent = unblocking ? 'Unblocking' : 'Blocking';
  const actionPast = unblocking ? 'Unblocked' : 'Blocked';
  const plural = targets.length === 1 ? 'profile' : 'profiles';
  const confirmed = await showConfirmation({
    title: `${actionTitle} ${targets.length} selected ${plural}?`,
    message: `The extension will send each ${action} request to X one at a time.`,
    detail: 'This uses the shared account-action queue: about one request every 2.5 seconds, slowing only near X’s reported limit.',
    confirmLabel: `${actionTitle} ${targets.length} ${plural}`,
    tone: unblocking ? 'neutral' : 'danger'
  });
  if (!confirmed) return;

  bulkRunning = true;
  stopBulkRequested = false;
  els.bulkStatus.hidden = false;
  els.stopBulk.hidden = false;
  openBulkProgress(targets.length, action);
  renderAccounts();

  let completed = 0;
  try {
    for (const account of targets) {
      if (stopBulkRequested) break;
      els.bulkStatus.textContent = `${actionPresent} ${completed + 1} of ${targets.length}…`;
      updateBulkProgress(completed, targets.length, `${actionPresent} @${cleanHandle(account.screenName)}…`);
      await performAction(account, action, pacing => {
        const seconds = Math.max(1, Math.ceil(pacing.waitingMs / 1000));
        const quotaNote = pacing.remaining !== null ? ` · ${pacing.remaining} calls left` : '';
        const status = pacing.rateLimited
          ? `X paused ${action} actions · retrying in ${seconds}s`
          : `Waiting for the shared action queue · next attempt in ${seconds}s${quotaNote}`;
        els.bulkStatus.textContent = `${actionPast} ${completed} of ${targets.length} · next in ${seconds}s`;
        updateBulkProgress(completed, targets.length, status);
      });
      selected.delete(accountKey(account));
      completed++;
      await loadAccounts();
    }
    els.bulkStatus.textContent = stopBulkRequested
      ? `Stopped after ${completed} of ${targets.length}`
      : `${actionPast} ${completed} profile${completed === 1 ? '' : 's'}`;
    const completedProfiles = `${completed} profile${completed === 1 ? '' : 's'}`;
    finishBulkProgress(
      completed,
      targets.length,
      stopBulkRequested ? `Stopped after ${completed} of ${targets.length}.` : `${completedProfiles} ${unblocking ? 'unblocked' : 'blocked'} successfully.`,
      stopBulkRequested ? 'stopped' : 'complete',
      action
    );
  } catch (error) {
    const message = error?.message || 'X rejected a request';
    els.bulkStatus.textContent = `Stopped after ${completed}: ${message}`;
    finishBulkProgress(completed, targets.length, message, 'error', action);
  } finally {
    bulkRunning = false;
    els.stopBulk.hidden = true;
    await loadAccounts();
  }
}

els.refreshBtn.addEventListener('click', loadAccounts);
els.search.addEventListener('input', () => {
  searchQuery = els.search.value;
  currentPage = 1;
  selected.clear();
  els.bulkStatus.hidden = true;
  renderAccounts();
});
els.filterTabs.forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  currentPage = 1;
  selected.clear();
  els.bulkStatus.hidden = true;
  els.filterTabs.forEach(item => item.classList.toggle('active', item === button));
  renderAccounts();
}));
els.selectAll.addEventListener('change', () => {
  const selectable = getSelectableAccounts();
  for (const account of selectable) {
    if (els.selectAll.checked) selected.add(accountKey(account));
    else selected.delete(accountKey(account));
  }
  renderAccounts();
});
els.bulkAction.addEventListener('click', () => {
  if (activeFilter === 'all') runBulkDelete();
  else runBulkAccountAction(activeFilter === 'blocked' ? 'unblock' : 'block');
});
els.stopBulk.addEventListener('click', requestBulkStop);
els.bulkProgressStop.addEventListener('click', requestBulkStop);
els.bulkProgressClose.addEventListener('click', closeBulkProgress);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !bulkRunning && !els.bulkProgressModal.hidden) closeBulkProgress();
});
window.addEventListener('beforeunload', event => {
  if (!bulkRunning) return;
  event.preventDefault();
  event.returnValue = '';
});
els.downloadBackup.addEventListener('click', downloadBackup);
els.restoreBackup.addEventListener('click', () => els.restoreBackupInput.click());
els.restoreBackupInput.addEventListener('change', () => restoreBackupFile(els.restoreBackupInput.files?.[0]));
els.clearFiltered.addEventListener('click', clearFilteredProfiles);
els.previousPage.addEventListener('click', () => {
  if (currentPage <= 1) return;
  currentPage--;
  renderAccounts();
  els.profileList.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.nextPage.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(getVisibleAccounts().length / pageSize));
  if (currentPage >= totalPages) return;
  currentPage++;
  renderAccounts();
  els.profileList.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.pageSizeOptions.forEach(button => button.addEventListener('click', () => {
  pageSize = Number(button.dataset.pageSize) || 50;
  currentPage = 1;
  renderAccounts();
}));

if (hasExtensionRuntime()) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[FILTERED_ACCOUNTS_KEY] || changes[PROFILE_VISIBILITY_OVERRIDES_KEY])) loadAccounts();
  });
  loadAccounts();
} else {
  els.downloadBackup.disabled = true;
  els.restoreBackup.disabled = true;
  setBackupStatus('Backup controls are available when this page is opened from the installed extension.');
  accounts = [
    { screenName: 'sample_profile', country: 'India', location: 'India', lastSeen: Date.now(), blocked: false, visibility: 'show' },
    { screenName: 'filtered_account', country: 'Canada', location: 'Canada', lastSeen: Date.now() - 3_600_000, blocked: false },
    { screenName: 'another_account', country: 'South Asia', location: 'South Asia', lastSeen: Date.now() - 86_400_000, blocked: true }
  ];
  renderAccounts();
}
