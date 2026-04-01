import QRCode from 'qrcode';
import { getConfig, setConfig, clearPairing } from '../storage';
import type { SWMessageResult } from '../types';
import { trackEvent } from '../analytics';
import { FocusLinkAPI, connectReviewDemo } from '../api';

const $ = (id: string) => document.getElementById(id)!;

let qrTimerInterval: ReturnType<typeof setInterval> | null = null;
let qrFlowActive = false;          // true while QR code is displayed — prevents re-render loops
let pairingStartInFlight = false;  // true while requesting a new pairing session
let refreshDomainsInFlight = false;
let listenersRegistered = false;
let hasTrackedBlockListVisible = false;
let hasTrackedOptionsOpened = false;
let latestStatus: Extract<SWMessageResult, { type: 'STATUS' }> | null = null;
let warningToggleSyncInProgress = false;
let reviewRevealVisible = false;
let reviewTapCount = 0;
let reviewTapStartedAt = 0;
let reviewActionInFlight = false;
const REVIEW_TAP_TARGET = 5;
const REVIEW_TAP_WINDOW_MS = 3000;
const WORKER_URL = process.env.FOCUSLINK_WORKER_URL || 'https://focus.zeyt.io';

function applyDevSyncGuard(): void {
  const paused = latestStatus?.liveSyncEnabled === false;
  $('dev-sync-card').style.display = paused ? 'block' : 'none';
  if (!paused) return;

  $('dev-sync-copy').textContent = latestStatus?.syncMode === 'off'
    ? 'Live sync is disabled by your local terminal setting. Run ./scripts/set_focuslink_sync_mode.sh on, then rebuild and reload the extension before testing against production.'
    : latestStatus?.isPaired
    ? 'This local build is paired, but live sync is disabled until you run ./scripts/set_focuslink_sync_mode.sh on and rebuild.'
    : 'This local build is disabled for live sync until you run ./scripts/set_focuslink_sync_mode.sh on and rebuild.';
}

async function refreshStatusFromSW(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (result.type === 'STATUS') {
      latestStatus = result;
      applyDevSyncGuard();
    }
  } catch {
    latestStatus = null;
    $('dev-sync-card').style.display = 'none';
  }
}

async function renderFromConfig(): Promise<void> {
  const config = await getConfig();
  const liveSyncPaused = latestStatus?.liveSyncEnabled === false;

  $('device-id').textContent = config.extensionDeviceId;
  await renderWarningControls(config);
  renderReviewControlsVisibility();
  syncReviewActionAvailability(Boolean(config.groupId && config.extensionDeviceToken));

  if (config.groupId) {
    qrFlowActive = false;
    hidePairingTopSitesConsent();
    renderLinked(config.groupId);
  } else if (qrFlowActive || pairingStartInFlight) {
    // QR code is already visible or being requested — don't restart the flow.
  } else if (config.pairing?.status === 'pending') {
    const stored = await chrome.storage.local.get('config');
    const pairing = stored.config?.pairing;
    if (pairing?.pairingToken && !liveSyncPaused) {
      await startQRFlow();
    } else {
      renderUnlinked();
    }
  } else {
    renderUnlinked();
  }

  renderDomains(config.lastBlockList ?? []);
  updateBlockedSitesStatus(config.lastBlockList ?? []);
  await renderSuggestions(config.lastBlockList ?? []);
}

function renderReviewControlsVisibility(): void {
  const btn = $('btn-review-controls');
  btn.className = reviewRevealVisible ? 'btn-secondary review-btn visible' : 'btn-secondary review-btn';
}

function syncReviewActionAvailability(isPaired: boolean): void {
  const trigger = $('btn-review-controls') as HTMLButtonElement;
  trigger.disabled = false;
  ($('btn-review-connect-demo') as HTMLButtonElement).style.display = isPaired ? 'none' : 'block';
  for (const id of ['btn-review-install-instagram', 'btn-review-open-5m', 'btn-review-open-now', 'btn-review-still-now']) {
    ($(id) as HTMLButtonElement).disabled = !isPaired || reviewActionInFlight;
  }
}

function noteReviewTitleTap(): void {
  const now = Date.now();
  if (now - reviewTapStartedAt > REVIEW_TAP_WINDOW_MS) {
    reviewTapStartedAt = now;
    reviewTapCount = 0;
  }
  reviewTapCount += 1;

  if (reviewTapCount >= REVIEW_TAP_TARGET) {
    reviewRevealVisible = true;
    renderReviewControlsVisibility();
    reviewTapCount = 0;
    reviewTapStartedAt = 0;
  }
}

function setReviewModalOpen(open: boolean): void {
  $('review-overlay').className = open ? 'review-overlay visible' : 'review-overlay';
  if (!open) {
    $('review-status').textContent = '';
    $('review-status').className = 'status-hint subtle review-status';
  }
}

function setReviewStatus(message: string, tone: 'subtle' | 'success' | 'error'): void {
  const el = $('review-status');
  el.textContent = message;
  el.className = `status-hint ${tone === 'error' ? 'subtle' : tone} review-status`;
  if (tone === 'error') {
    el.style.color = '#b91c1c';
  } else {
    el.style.color = '';
  }
}

function setReviewButtonsDisabled(disabled: boolean): void {
  for (const id of ['btn-review-connect-demo', 'btn-review-install-instagram', 'btn-review-open-5m', 'btn-review-open-now', 'btn-review-still-now', 'btn-review-cancel', 'btn-review-close']) {
    ($(id) as HTMLButtonElement).disabled = disabled;
  }
}

function getFocusLinkApi(config: Awaited<ReturnType<typeof getConfig>>): FocusLinkAPI {
  if (!config.groupId || !config.extensionDeviceToken) {
    throw new Error('This browser must be paired before review controls can be used.');
  }
  return new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);
}

async function runReviewAction(action: 'open-5m' | 'open-now' | 'still-now'): Promise<void> {
  if (reviewActionInFlight) return;

  const config = await getConfig();
  let api: FocusLinkAPI;
  try {
    api = getFocusLinkApi(config);
  } catch (error) {
    setReviewStatus(error instanceof Error ? error.message : 'Pairing is required before using review controls.', 'error');
    return;
  }

  reviewActionInFlight = true;
  setReviewButtonsDisabled(true);
  setReviewStatus('Updating review state…', 'subtle');

  try {
    if (action === 'open-5m') await api.setReviewOpenForFiveMinutes();
    if (action === 'open-now') await api.setReviewOpenNow();
    if (action === 'still-now') await api.setReviewStillNow();

    setReviewStatus('Review state updated. Syncing now…', 'success');
    await chrome.runtime.sendMessage({ type: 'POLL_NOW', force: true, source: `extension:review.${action}.sync` });
    await refreshStatusFromSW();
    await renderFromConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update review state.';
    setReviewStatus(message, 'error');
    setReviewButtonsDisabled(false);
    reviewActionInFlight = false;
    return;
  }

  setReviewButtonsDisabled(false);
  reviewActionInFlight = false;
}

async function installReviewInstagram(): Promise<void> {
  if (reviewActionInFlight) return;

  const config = await getConfig();
  let api: FocusLinkAPI;
  try {
    api = getFocusLinkApi(config);
  } catch (error) {
    setReviewStatus(error instanceof Error ? error.message : 'Pairing is required before using review controls.', 'error');
    return;
  }

  reviewActionInFlight = true;
  setReviewButtonsDisabled(true);
  setReviewStatus('Adding instagram.com to the synced blocked list…', 'subtle');

  try {
    await api.installReviewInstagramBlocklist();
    await chrome.runtime.sendMessage({ type: 'POLL_NOW', force: true, source: 'extension:review.blocklist.install-instagram.sync' });
    await refreshStatusFromSW();
    await renderFromConfig();
    setReviewStatus('instagram.com added. You can now use "Still mode now" and test blocking there.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add instagram.com to the blocked list.';
    setReviewStatus(message, 'error');
  } finally {
    setReviewButtonsDisabled(false);
    reviewActionInFlight = false;
    syncReviewActionAvailability(Boolean((await getConfig()).groupId && (await getConfig()).extensionDeviceToken));
  }
}

async function connectReviewerDemoMode(): Promise<void> {
  if (reviewActionInFlight) return;

  const config = await getConfig();
  reviewActionInFlight = true;
  setReviewButtonsDisabled(true);
  setReviewStatus('Connecting reviewer demo…', 'subtle');

  try {
    const result = await connectReviewDemo(WORKER_URL, config.extensionDeviceId);
    await setConfig({
      groupId: result.groupId,
      extensionDeviceToken: result.extensionDeviceToken,
      pairing: null,
      lastFocusState: null,
      lastBlockList: [],
      lastBlockListVersion: 0,
      blockListFetchedAt: 0,
    });
    await chrome.runtime.sendMessage({ type: 'POLL_NOW', force: true, source: 'extension:review.demo.connect.sync' });
    await refreshStatusFromSW();
    await renderFromConfig();
    setReviewStatus('Reviewer demo connected. You can now add instagram.com and change modes.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect reviewer demo.';
    setReviewStatus(message, 'error');
  } finally {
    reviewActionInFlight = false;
    setReviewButtonsDisabled(false);
    syncReviewActionAvailability(Boolean((await getConfig()).groupId && (await getConfig()).extensionDeviceToken));
  }
}

async function init(): Promise<void> {
  await refreshStatusFromSW();
  // Render from cache immediately
  await renderFromConfig();
  if (!hasTrackedOptionsOpened) {
    hasTrackedOptionsOpened = true;
    void trackEvent('extension_options_opened', { surface: 'options' });
  }

  if (!listenersRegistered) {
    listenersRegistered = true;

    // Listen for pairing/auth events from the service worker
    chrome.runtime.onMessage.addListener((msg: SWMessageResult) => {
      if (msg.type === 'PAIRING_COMPLETE') onPairingComplete();
      if (msg.type === 'PAIRING_EXPIRED')  onPairingExpired();
      if (msg.type === 'UNLINKED')         renderUnlinked();
    });

    // Re-render whenever the service worker updates the stored config.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.config) {
        void renderFromConfig();
      }
    });
  }

  // Settings is an explicit sync surface, so bypass popup rate limiting here.
  if (latestStatus?.liveSyncEnabled !== false) {
    await refreshDomains();
  }
}

async function refreshDomains(): Promise<void> {
  if (latestStatus?.liveSyncEnabled === false) {
    await renderFromConfig();
    await refreshStatusFromSW();
    return;
  }

  if (refreshDomainsInFlight) return;
  refreshDomainsInFlight = true;

  const btn = $('btn-refresh-domains') as HTMLButtonElement;
  const originalLabel = btn.textContent ?? 'Refresh';
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  setBlockedSitesStatus('Refreshing your browser block list…', 'subtle');
  void trackEvent('extension_blocklist_refresh_started', { surface: 'options' });

  try {
    await chrome.runtime.sendMessage({ type: 'POLL_NOW', force: true, source: 'extension:options.refresh-domains' });
  } catch {
    // Keep current cached state visible if the worker is temporarily unavailable.
  } finally {
    await renderFromConfig();
    btn.textContent = originalLabel;
    btn.disabled = false;
    refreshDomainsInFlight = false;
  }
}

async function hasPermission(permission: 'scripting' | 'topSites'): Promise<boolean> {
  return chrome.permissions.contains({ permissions: [permission] });
}

function hidePairingTopSitesConsent(): void {
  $('pairing-top-sites-consent').style.display = 'none';
}

async function maybePromptTopSitesBeforePairing(): Promise<boolean> {
  const config = await getConfig();
  if (config.topSitesPromptShown) return false;

  const granted = await hasPermission('topSites');
  if (granted) {
    await setConfig({ topSitesPromptShown: true });
    return false;
  }

  hidePairingTopSitesConsent();
  $('pairing-top-sites-consent').style.display = 'block';
  $('btn-pair').style.display = 'none';
  return true;
}

async function getTopSitesDomains(): Promise<string[]> {
  const granted = await hasPermission('topSites');
  if (!granted) return [];

  let domains: string[] = [];
  try {
    const topSites = await chrome.topSites.get();
    const seen = new Set<string>();
    for (const site of topSites) {
      try {
        const hostname = new URL(site.url).hostname.toLowerCase().replace(/^www\./, '');
        if (!hostname || seen.has(hostname)) continue;
        if (hostname.startsWith('chrome') || hostname === 'newtab') continue;
        seen.add(hostname);
        domains.push(hostname);
        if (domains.length >= 20) break;
      } catch { /* invalid URL */ }
    }
  } catch { /* permission missing or API unavailable */ }
  return domains;
}

async function updateConfig(partial: Record<string, unknown>): Promise<void> {
  await setConfig(partial);
}

function setBlockedSitesStatus(message: string, tone: 'subtle' | 'success'): void {
  const el = $('blocked-sites-status');
  el.textContent = message;
  el.className = `status-hint ${tone}`;
}

function updateBlockedSitesStatus(domains: string[]): void {
  const count = domains.length;
  if (refreshDomainsInFlight) return;
  if (count > 0) {
    setBlockedSitesStatus(
      `${count} site${count === 1 ? '' : 's'} synced. Browser list updated just now.`,
      'success',
    );
    if (!hasTrackedBlockListVisible) {
      hasTrackedBlockListVisible = true;
      void trackEvent('extension_blocklist_visible', { domain_count: count, surface: 'options' });
    }
    return;
  }
  setBlockedSitesStatus('No blocked sites synced yet. Add them in the zeyt app or refresh again.', 'subtle');
}

function getPairingBrowserLabel(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platformRaw = (
    nav.userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
  ).toLowerCase();

  if (platformRaw.includes('mac')) return 'Chrome on Mac';
  if (platformRaw.includes('win')) return 'Chrome on Windows';
  if (platformRaw.includes('linux')) return 'Chrome on Linux';
  if (platformRaw.includes('android')) return 'Chrome on Android';
  if (platformRaw.includes('iphone') || platformRaw.includes('ipad') || platformRaw.includes('ios')) {
    return 'Chrome on iPhone';
  }
  return 'Chrome';
}

function renderLinked(groupId: string): void {
  const badge = $('pairing-state');
  badge.textContent = `Linked — group: ${groupId.slice(0, 8)}…`;
  badge.className = 'badge badge-linked';
  $('pairing-hint').textContent = 'Your phone app is connected. The block list syncs automatically.';
  $('btn-pair').style.display = 'none';
  $('qr-section').style.display = 'none';
  ($('btn-unpair') as HTMLButtonElement).disabled = false;
}

function renderUnlinked(): void {
  const badge = $('pairing-state');
  badge.textContent = 'Not linked';
  badge.className = 'badge badge-unlinked';
  $('pairing-hint').textContent = 'Scan the QR code below with the zeyt app on your phone to link this browser.';
  $('btn-pair').style.display = '';
  $('qr-section').style.display = 'none';
  ($('btn-unpair') as HTMLButtonElement).disabled = true;
}

async function startQRFlow(): Promise<void> {
  if (qrFlowActive || pairingStartInFlight) return;
  if (await maybePromptTopSitesBeforePairing()) return;

  pairingStartInFlight = true;
  ($('btn-pair') as HTMLButtonElement).disabled = true;
  ($('qr-error') as HTMLElement).style.display = 'none';
  hidePairingTopSitesConsent();

  let result: SWMessageResult | undefined;
  try {
    result = await chrome.runtime.sendMessage({ type: 'START_PAIRING' });
  } catch {
    pairingStartInFlight = false;
    ($('btn-pair') as HTMLButtonElement).disabled = false;
    const errEl = $('qr-error') as HTMLElement;
    errEl.textContent = 'Could not reach the extension background. Please try again.';
    errEl.style.display = '';
    return;
  }

  if (!result || result.type !== 'PAIRING_STARTED') {
    pairingStartInFlight = false;
    ($('btn-pair') as HTMLButtonElement).disabled = false;
    const errEl = $('qr-error') as HTMLElement;
    errEl.textContent = result?.type === 'ERROR' ? (result as any).message : 'Failed to start pairing.';
    errEl.style.display = '';
    return;
  }

  $('qr-section').style.display = 'block';
  $('btn-pair').style.display = 'none';

  // If granted, bake top sites into the pairing QR so the phone can offer them in one scan.
  const domains = await getTopSitesDomains();

  let qrString = result.qrPayload;
  if (domains.length > 0) {
    try {
      const payload = JSON.parse(qrString) as Record<string, unknown>;
      qrString = JSON.stringify({ ...payload, d: domains, n: getPairingBrowserLabel() });
    } catch { /* keep original payload */ }
  } else {
    try {
      const payload = JSON.parse(qrString) as Record<string, unknown>;
      qrString = JSON.stringify({ ...payload, n: getPairingBrowserLabel() });
    } catch { /* keep original payload */ }
  }

  const canvas = $('qr-canvas') as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, qrString, { width: 200, margin: 1 });
  qrFlowActive = true;
  pairingStartInFlight = false;
  void trackEvent('extension_pair_qr_shown', {
    suggested_domain_count: domains.length,
    surface: 'options',
  });

  const timerEl = $('qr-timer');
  const expiresAt = result.expiresAt;
  const tick = () => {
    const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    timerEl.textContent = s > 0 ? `Expires in ${s}s` : 'Expired';
  };
  tick();
  qrTimerInterval = setInterval(tick, 1000);
}

function onPairingComplete(): void {
  qrFlowActive = false;
  pairingStartInFlight = false;
  if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
  $('qr-section').style.display = 'block';
  ($('qr-canvas') as HTMLCanvasElement).style.display = 'none';
  ($('qr-timer') as HTMLElement).style.display = 'none';
  ($('qr-success') as HTMLElement).style.display = '';
  void trackEvent('extension_pair_completed', { surface: 'options' });
  setTimeout(() => init(), 1500);
}

function onPairingExpired(): void {
  qrFlowActive = false;
  pairingStartInFlight = false;
  if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
  renderUnlinked();
  const errEl = $('qr-error') as HTMLElement;
  errEl.textContent = 'QR code expired. Click "Show QR Code" to try again.';
  errEl.style.display = '';
}

function renderDomains(domains: string[]): void {
  const list = $('domain-list');
  const empty = $('domain-empty');
  if (domains.length === 0) {
    list.style.display = 'none';
    empty.style.display = '';
  } else {
    list.style.display = 'flex';
    empty.style.display = 'none';
    list.innerHTML = domains
      .map(d => `<span class="domain-tag">${d}</span>`)
      .join('');
  }
}

async function renderSuggestions(blockList: string[]): Promise<void> {
  const granted = await hasPermission('topSites');
  if (!granted) {
    $('suggestions-card').style.display = 'none';
    return;
  }

  let sites: chrome.topSites.MostVisitedURL[];
  try {
    sites = await chrome.topSites.get();
  } catch {
    return; // API unavailable
  }

  // Extract root domain (strip www.), deduplicate, skip extension/chrome pages
  const blocked = new Set(blockList.map(d => d.toLowerCase()));
  const seen = new Set<string>();
  const domains: { domain: string; isBlocked: boolean }[] = [];

  for (const site of sites) {
    try {
      const hostname = new URL(site.url).hostname.toLowerCase().replace(/^www\./, '');
      if (!hostname || seen.has(hostname)) continue;
      if (hostname.startsWith('chrome') || hostname === 'newtab') continue;
      seen.add(hostname);
      const isBlocked = blocked.has(hostname) || blockList.some(d => hostname.endsWith(`.${d}`));
      domains.push({ domain: hostname, isBlocked });
    } catch { /* invalid URL */ }
  }

  if (domains.length === 0) return;

  // Sort: blocked first, then alphabetical
  domains.sort((a, b) => Number(b.isBlocked) - Number(a.isBlocked) || a.domain.localeCompare(b.domain));

  const card = $('suggestions-card');
  const list = $('suggestions-list');
  const body = $('suggestions-body');
  const toggleBtn = $('btn-toggle-suggestions') as HTMLButtonElement;

  list.innerHTML = domains
    .map(({ domain, isBlocked }) =>
      `<span class="suggestion-tag ${isBlocked ? 'blocked' : ''}" title="${isBlocked ? 'Already blocked' : 'Not yet blocked'}">${isBlocked ? '✓ ' : ''}${domain}</span>`
    )
    .join('');

  // Restore visibility preference
  const { suggestionsVisible } = await chrome.storage.local.get('suggestionsVisible');
  const visible = suggestionsVisible === true;
  body.style.display = visible ? '' : 'none';
  toggleBtn.textContent = visible ? 'Hide' : 'Show';
  card.style.display = '';

  // "Scan to add" button — QR encodes non-blocked suggestions as a zeyt deeplink
  const nonBlocked = domains.filter(d => !d.isBlocked).map(d => d.domain);
  const suggestBtn = $('btn-suggest-qr') as HTMLButtonElement;
  const suggestQrSection = $('suggest-qr-section');
  const suggestQrClose = $('btn-suggest-qr-close');

  if (nonBlocked.length > 0) {
    suggestBtn.style.display = 'block';
    suggestBtn.onclick = async () => {
      const deeplink = `zeyt://suggest?domains=${nonBlocked.join(',')}`;
      const canvas = $('suggest-qr-canvas') as HTMLCanvasElement;
      await QRCode.toCanvas(canvas, deeplink, { width: 180, margin: 1 });
      suggestQrSection.style.display = 'block';
      suggestBtn.style.display = 'none';
    };
    suggestQrClose.onclick = () => {
      suggestQrSection.style.display = 'none';
      suggestBtn.style.display = 'block';
    };
  } else {
    suggestBtn.style.display = 'none';
  }

  toggleBtn.onclick = async () => {
    const nowVisible = body.style.display === 'none';
    body.style.display = nowVisible ? 'block' : 'none';
    toggleBtn.textContent = nowVisible ? 'Hide' : 'Show';
    await chrome.storage.local.set({ suggestionsVisible: nowVisible });
  };
}

async function renderWarningControls(config: Awaited<ReturnType<typeof getConfig>>): Promise<void> {
  const toggle = $('warning-toggle') as HTMLInputElement;
  const toggleLabel = toggle.closest('label') as HTMLLabelElement | null;
  const prompt = $('warning-setup-prompt');
  const hint = $('warning-setting-hint');
  const status = $('warning-setting-status');
  const hasScripting = await hasPermission('scripting');

  warningToggleSyncInProgress = true;
  toggle.checked = config.oneMinuteWarningEnabled && hasScripting;
  toggle.disabled = false;
  warningToggleSyncInProgress = false;

  if (!config.warningPromptShown) {
    prompt.style.display = 'block';
    if (toggleLabel) toggleLabel.style.display = 'none';
    hint.textContent = 'Choose whether zeyt should show an in-page warning before open mode ends.';
  } else {
    prompt.style.display = 'none';
    if (toggleLabel) toggleLabel.style.display = 'flex';
    hint.textContent = 'Show a small in-page warning when open mode is about to end.';
  }

  if (config.oneMinuteWarningEnabled && hasScripting) {
    status.textContent = 'Enabled. zeyt can show the warning inside the current page.';
    status.className = 'status-hint success';
  } else if (config.oneMinuteWarningEnabled && !hasScripting) {
    status.textContent = 'Disabled until page-access permission is granted again.';
    status.className = 'status-hint subtle';
  } else {
    status.textContent = 'Off. Blocking still works normally without this.';
    status.className = 'status-hint subtle';
  }
}

async function setOneMinuteWarningEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    const granted = await chrome.permissions.request({ permissions: ['scripting'] });
    await updateConfig({
      warningPromptShown: true,
      oneMinuteWarningEnabled: granted,
    });
    return;
  }

  await updateConfig({
    warningPromptShown: true,
    oneMinuteWarningEnabled: false,
  });
}

$('btn-pair').addEventListener('click', () => startQRFlow());
$('btn-refresh-domains').addEventListener('click', () => {
  void refreshDomains();
});
$('settings-title').addEventListener('click', () => noteReviewTitleTap());
($('btn-review-controls') as HTMLButtonElement).addEventListener('click', () => setReviewModalOpen(true));
($('btn-review-connect-demo') as HTMLButtonElement).addEventListener('click', () => {
  void connectReviewerDemoMode();
});
($('btn-review-close') as HTMLButtonElement).addEventListener('click', () => setReviewModalOpen(false));
($('btn-review-cancel') as HTMLButtonElement).addEventListener('click', () => setReviewModalOpen(false));
($('review-overlay') as HTMLDivElement).addEventListener('click', (event) => {
  if (event.target === $('review-overlay')) setReviewModalOpen(false);
});
($('btn-review-open-5m') as HTMLButtonElement).addEventListener('click', () => {
  void runReviewAction('open-5m');
});
($('btn-review-install-instagram') as HTMLButtonElement).addEventListener('click', () => {
  void installReviewInstagram();
});
($('btn-review-open-now') as HTMLButtonElement).addEventListener('click', () => {
  void runReviewAction('open-now');
});
($('btn-review-still-now') as HTMLButtonElement).addEventListener('click', () => {
  void runReviewAction('still-now');
});

($('btn-top-sites-allow') as HTMLButtonElement).addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ permissions: ['topSites'] });
  await updateConfig({ topSitesPromptShown: true });
  if (!granted) {
    const errEl = $('qr-error') as HTMLElement;
    errEl.textContent = 'Top sites access was not granted. Pairing will continue without suggestions.';
    errEl.style.display = '';
  }
  hidePairingTopSitesConsent();
  void startQRFlow();
});

($('btn-top-sites-skip') as HTMLButtonElement).addEventListener('click', async () => {
  await updateConfig({ topSitesPromptShown: true });
  hidePairingTopSitesConsent();
  void startQRFlow();
});

($('btn-warning-allow') as HTMLButtonElement).addEventListener('click', async () => {
  await setOneMinuteWarningEnabled(true);
  await renderFromConfig();
});

($('btn-warning-skip') as HTMLButtonElement).addEventListener('click', async () => {
  await setOneMinuteWarningEnabled(false);
  await renderFromConfig();
});

($('warning-toggle') as HTMLInputElement).addEventListener('change', async (event) => {
  if (warningToggleSyncInProgress) return;
  const checked = (event.currentTarget as HTMLInputElement).checked;
  await setOneMinuteWarningEnabled(checked);
  await renderFromConfig();
});

$('btn-unpair').addEventListener('click', async () => {
  const confirmed = confirm(
    'This will unlink your phone app. You will need to scan a new QR code to reconnect. Continue?',
  );
  if (!confirmed) return;

  await clearPairing();
  await chrome.runtime.sendMessage({ type: 'UNPAIR' });
  renderUnlinked();
});

init();
