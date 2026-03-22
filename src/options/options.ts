import QRCode from 'qrcode';
import { getConfig, clearPairing } from '../storage';
import type { SWMessageResult } from '../types';

const $ = (id: string) => document.getElementById(id)!;

let qrTimerInterval: ReturnType<typeof setInterval> | null = null;

async function init(): Promise<void> {
  // Refresh block list + state on page open
  chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});

  const config = await getConfig();

  $('device-id').textContent = config.extensionDeviceId;

  if (config.groupId) {
    renderLinked(config.groupId);
  } else if (config.pairing?.status === 'pending') {
    // Pairing already in progress — re-render the QR
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

  // Listen for pairing completion from the service worker
  chrome.runtime.onMessage.addListener((msg: SWMessageResult) => {
    if (msg.type === 'PAIRING_COMPLETE') onPairingComplete();
    if (msg.type === 'PAIRING_EXPIRED')  onPairingExpired();
  });
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

  const result = await chrome.runtime.sendMessage({ type: 'START_PAIRING' }) as SWMessageResult;

  if (result.type !== 'PAIRING_STARTED') {
    ($('btn-pair') as HTMLButtonElement).disabled = false;
    const errEl = $('qr-error') as HTMLElement;
    errEl.textContent = result.type === 'ERROR' ? result.message : 'Failed to start pairing.';
    errEl.style.display = '';
    return;
  }

  $('qr-section').style.display = '';
  $('btn-pair').style.display = 'none';

  const canvas = $('qr-canvas') as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, result.qrPayload, { width: 200, margin: 1 });

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
  $('qr-section').style.display = '';
  ($('qr-canvas') as HTMLCanvasElement).style.display = 'none';
  ($('qr-timer') as HTMLElement).style.display = 'none';
  ($('qr-success') as HTMLElement).style.display = '';
  // Re-init after short delay to show linked state
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
