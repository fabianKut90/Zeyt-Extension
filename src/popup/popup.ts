/**
 * Popup script — runs fresh on every popup open.
 * Communicates with the service worker via chrome.runtime.sendMessage.
 */
import QRCode from 'qrcode';
import type { SWMessage, SWMessageResult } from '../types';

const $ = (id: string) => document.getElementById(id)!;

function show(viewId: string): void {
  for (const id of ['view-paired', 'view-pairing', 'view-unlinked', 'view-loading']) {
    ($(id) as HTMLElement).style.display = id === viewId ? '' : 'none';
  }
}

async function sendToSW(message: SWMessage): Promise<SWMessageResult> {
  return chrome.runtime.sendMessage(message);
}

async function init(): Promise<void> {
  const result = await sendToSW({ type: 'GET_STATUS' });
  if (result.type !== 'STATUS') return;

  if (result.isPaired) {
    renderPaired(result);
  } else if (result.pairingStatus === 'pending') {
    // Pairing in progress — show QR from stored session
    const config = await chrome.storage.local.get('config');
    const pairing = config.config?.pairing;
    if (pairing) {
      await renderPairingQR(pairing.qrPayload ?? '', pairing.expiresAt);
    } else {
      show('view-unlinked');
    }
  } else {
    show('view-unlinked');
  }
}

function renderPaired(status: Extract<SWMessageResult, { type: 'STATUS' }>): void {
  show('view-paired');

  const focusBadge = $('focus-badge');
  const focusHint = $('focus-hint');

  if (status.isBlocking) {
    const endsText = status.endsAt
      ? ` until ${new Date(status.endsAt).toLocaleTimeString()}`
      : ' (NFC unlock required)';
    focusBadge.innerHTML = `<span class="badge badge-blocking">Blocking${endsText}</span>`;
    focusHint.textContent = 'Websites in your block list are currently blocked.';
  } else {
    focusBadge.innerHTML = `<span class="badge badge-idle">Idle</span>`;
    focusHint.textContent = 'No active focus session.';
  }

  if (status.syncIssue) {
    focusBadge.innerHTML += ` <span class="badge badge-warning">Sync issue</span>`;
  }
}

async function renderPairingQR(qrPayload: string, expiresAt: number): Promise<void> {
  show('view-pairing');
  const canvas = $('qr-canvas') as HTMLCanvasElement;
  const qrWrap = $('qr-wrap');

  qrWrap.style.display = 'flex';
  await QRCode.toCanvas(canvas, qrPayload, { width: 220, margin: 1 });

  // Countdown timer
  const timerEl = $('qr-timer');
  const tick = () => {
    const secondsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    timerEl.textContent = secondsLeft > 0 ? `Expires in ${secondsLeft}s` : 'Expired';
  };
  tick();
  const interval = setInterval(tick, 1000);

  // Listen for pairing completion from SW
  chrome.runtime.onMessage.addListener((msg: SWMessageResult) => {
    if (msg.type === 'PAIRING_COMPLETE') {
      clearInterval(interval);
      init(); // Re-render as paired
    }
    if (msg.type === 'PAIRING_EXPIRED') {
      clearInterval(interval);
      show('view-unlinked');
    }
  });
}

// ─── Button wiring ────────────────────────────────────────────────────────────

$('btn-pair').addEventListener('click', async () => {
  $('btn-pair').setAttribute('disabled', 'true');
  ($('error-msg') as HTMLElement).style.display = 'none';

  const result = await sendToSW({ type: 'START_PAIRING' });

  if (result.type === 'PAIRING_STARTED') {
    await renderPairingQR(result.qrPayload, result.expiresAt);
  } else {
    $('btn-pair').removeAttribute('disabled');
    const errEl = $('error-msg') as HTMLElement;
    errEl.textContent = result.type === 'ERROR' ? result.message : 'Failed to start pairing.';
    errEl.style.display = 'block';
  }
});

$('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
