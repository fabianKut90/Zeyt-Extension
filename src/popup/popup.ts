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
  const result = await sendToSW({ type: 'POLL_NOW' });
  if (result.type !== 'STATUS') return;

  if (result.isPaired) {
    renderPaired(result);
  } else if (result.pairingStatus === 'pending') {
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

  if (status.isBlocking) {
    document.body.className = 'still-mode';
    $('state-eyebrow').textContent = 'Active';
    $('state-title').textContent   = 'Still mode';
    $('state-sub').textContent     = 'Distracting sites are blocked on this Mac.';
    $('unlock-chip').style.display = 'inline-flex';
  } else {
    document.body.className = 'open-mode';
    $('state-eyebrow').textContent = 'Status';
    $('state-title').textContent   = 'Open mode';
    $('state-sub').textContent     = 'No active focus session.';
    $('unlock-chip').style.display = 'none';
  }

  if (status.syncIssue) {
    $('state-sub').textContent += ' (sync issue — check connection)';
  }
}

async function renderPairingQR(qrPayload: string, expiresAt: number): Promise<void> {
  show('view-pairing');
  document.body.className = 'open-mode';

  const canvas = $('qr-canvas') as HTMLCanvasElement;
  const qrWrap = $('qr-wrap');
  qrWrap.style.display = 'flex';
  await QRCode.toCanvas(canvas, qrPayload, { width: 220, margin: 1 });

  const timerEl = $('qr-timer');
  const tick = () => {
    const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    timerEl.textContent = s > 0 ? `Expires in ${s}s` : 'Expired';
  };
  tick();
  const interval = setInterval(tick, 1000);
  window.addEventListener('unload', () => clearInterval(interval), { once: true });

  chrome.runtime.onMessage.addListener((msg: SWMessageResult) => {
    if (msg.type === 'PAIRING_COMPLETE') { clearInterval(interval); init(); }
    if (msg.type === 'PAIRING_EXPIRED')  { clearInterval(interval); show('view-unlinked'); }
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

$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();
