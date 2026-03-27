import QRCode from 'qrcode';
import { getConfig, clearPairing } from '../storage';
import type { SWMessageResult } from '../types';

const $ = (id: string) => document.getElementById(id)!;

let qrTimerInterval: ReturnType<typeof setInterval> | null = null;

async function renderFromConfig(): Promise<void> {
  const config = await getConfig();

  $('device-id').textContent = config.extensionDeviceId;

  if (config.groupId) {
    renderLinked(config.groupId);
  } else if (config.pairing?.status === 'pending') {
    const stored = await chrome.storage.local.get('config');
    const pairing = stored.config?.pairing;
    if (pairing?.pairingToken) {
      await startQRFlow();
    } else {
      renderUnlinked();
    }
  } else {
    renderUnlinked();
  }

  renderDomains(config.lastBlockList ?? []);
  await renderSuggestions(config.lastBlockList ?? []);
}

async function init(): Promise<void> {
  // Render from cache immediately
  await renderFromConfig();

  // Listen for pairing/auth events from the service worker
  chrome.runtime.onMessage.addListener((msg: SWMessageResult) => {
    if (msg.type === 'PAIRING_COMPLETE') onPairingComplete();
    if (msg.type === 'PAIRING_EXPIRED')  onPairingExpired();
    if (msg.type === 'UNLINKED')         renderUnlinked();
  });

  // Background poll — re-render after it completes so 401 auto-unpair is reflected
  chrome.runtime.sendMessage({ type: 'POLL_NOW' })
    .then(() => renderFromConfig())
    .catch(() => {});
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
  ($('btn-pair') as HTMLButtonElement).disabled = true;
  ($('qr-error') as HTMLElement).style.display = 'none';

  let result: SWMessageResult | undefined;
  try {
    result = await chrome.runtime.sendMessage({ type: 'START_PAIRING' });
  } catch {
    ($('btn-pair') as HTMLButtonElement).disabled = false;
    const errEl = $('qr-error') as HTMLElement;
    errEl.textContent = 'Could not reach the extension background. Please try again.';
    errEl.style.display = '';
    return;
  }

  if (!result || result.type !== 'PAIRING_STARTED') {
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
      qrString = JSON.stringify({ ...payload, d: domains });
    } catch { /* keep original payload */ }
  }

  const canvas = $('qr-canvas') as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, qrString, { width: 200, margin: 1 });

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
  if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
  $('qr-section').style.display = 'block';
  ($('qr-canvas') as HTMLCanvasElement).style.display = 'none';
  ($('qr-timer') as HTMLElement).style.display = 'none';
  ($('qr-success') as HTMLElement).style.display = '';
  setTimeout(() => init(), 1500);
}

function onPairingExpired(): void {
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
