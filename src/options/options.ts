import QRCode from 'qrcode';
import { getConfig, clearPairing } from '../storage';
import type { SWMessageResult } from '../types';
import { trackEvent } from '../analytics';

const $ = (id: string) => document.getElementById(id)!;

let qrTimerInterval: ReturnType<typeof setInterval> | null = null;
let qrFlowActive = false;          // true while QR code is displayed — prevents re-render loops
let pairingStartInFlight = false;  // true while requesting a new pairing session
let refreshDomainsInFlight = false;
let listenersRegistered = false;
let hasTrackedBlockListVisible = false;
let hasTrackedOptionsOpened = false;
let latestStatus: Extract<SWMessageResult, { type: 'STATUS' }> | null = null;

function applyDevSyncGuard(): void {
  const paused = !!(latestStatus?.isDevBuild && !latestStatus.liveSyncEnabled);
  $('dev-sync-card').style.display = paused ? 'block' : 'none';
  if (!paused) return;

  $('dev-sync-copy').textContent = latestStatus?.syncMode === 'off'
    ? 'Live sync is disabled by your local terminal setting. Run the enable command, then rebuild and reload the extension before testing against production.'
    : latestStatus?.isPaired
    ? 'This development build is paired, but live sync is paused until you explicitly resume it.'
    : 'This development build is paused by default. Resume live sync before pairing this browser against production.';
  $('btn-resume-live-sync').style.display = latestStatus?.syncMode === 'manual' ? 'block' : 'none';
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

  if (config.groupId) {
    qrFlowActive = false;
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
    await chrome.runtime.sendMessage({ type: 'POLL_NOW', force: true });
  } catch {
    // Keep current cached state visible if the worker is temporarily unavailable.
  } finally {
    await renderFromConfig();
    btn.textContent = originalLabel;
    btn.disabled = false;
    refreshDomainsInFlight = false;
  }
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

  pairingStartInFlight = true;
  ($('btn-pair') as HTMLButtonElement).disabled = true;
  ($('qr-error') as HTMLElement).style.display = 'none';

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

  // Try to bake top sites into the pairing QR so the phone can offer them in one scan
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
  } catch { /* topSites permission not granted — domains stays empty */ }

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

async function resumeLiveSync(): Promise<void> {
  const btn = $('btn-resume-live-sync') as HTMLButtonElement;
  const originalLabel = btn.textContent ?? 'Resume live sync';
  btn.disabled = true;
  btn.textContent = 'Resuming…';
  try {
    await chrome.runtime.sendMessage({ type: 'RESUME_LIVE_SYNC' });
    await renderFromConfig();
    await refreshStatusFromSW();
  } finally {
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
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

$('btn-pair').addEventListener('click', () => startQRFlow());
$('btn-resume-live-sync').addEventListener('click', () => {
  void resumeLiveSync();
});
$('btn-refresh-domains').addEventListener('click', () => {
  void refreshDomains();
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
