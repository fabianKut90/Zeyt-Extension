/**
 * Popup script — runs fresh on every popup open.
 * Status-only view. Pairing happens in Settings (options page).
 */
import type { SWMessage, SWMessageResult } from '../types';

const $ = (id: string) => document.getElementById(id)!;

function show(viewId: string): void {
  for (const id of ['view-paired', 'view-unlinked', 'view-loading']) {
    ($(id) as HTMLElement).style.display = id === viewId ? '' : 'none';
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function sendToSW(message: SWMessage): Promise<SWMessageResult> {
  return chrome.runtime.sendMessage(message);
}

async function init(): Promise<void> {
  // Render immediately from cached state — no network wait
  const cached = await sendToSW({ type: 'GET_STATUS' });
  if (cached.type === 'STATUS') {
    cached.isPaired ? renderPaired(cached) : show('view-unlinked');
  }

  // Background poll — silently refreshes state + block list
  sendToSW({ type: 'POLL_NOW' }).catch(() => {});
}

function renderPaired(status: Extract<SWMessageResult, { type: 'STATUS' }>): void {
  show('view-paired');

  if (status.isBlocking) {
    document.body.className = 'still-mode';
    $('state-eyebrow').textContent = 'Active';
    $('state-title').textContent   = 'Still mode';
    const since = status.startedAt ? `Since ${formatTime(status.startedAt)}` : 'Distracting sites are blocked.';
    $('state-sub').textContent     = since;
    $('unlock-chip').style.display = 'inline-flex';
  } else {
    document.body.className = 'open-mode';
    $('state-eyebrow').textContent = 'Status';
    $('state-title').textContent   = 'Open mode';
    const until = status.endsAt ? `Until ${formatTime(status.endsAt)}` : 'No active focus session.';
    $('state-sub').textContent     = until;
    $('unlock-chip').style.display = 'none';
  }

  if (status.syncIssue) {
    $('state-sub').textContent += ' · sync issue';
  }
}

// ─── Button wiring ────────────────────────────────────────────────────────────

$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();
