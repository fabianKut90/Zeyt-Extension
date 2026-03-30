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

function renderDevGuard(status: Extract<SWMessageResult, { type: 'STATUS' }>): void {
  const banner = $('dev-sync-banner');
  if (!status.isDevBuild || status.liveSyncEnabled) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  $('dev-sync-text').textContent = 'Live sync is disabled in this dev build. Run ./scripts/set_focuslink_sync_mode.sh on, then rebuild/reload before testing production sync.';
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
    renderDevGuard(cached);
  }

  // Background poll — silently refreshes state + block list
  if (cached.type === 'STATUS' && cached.liveSyncEnabled) {
    sendToSW({ type: 'POLL_NOW' }).catch(() => {});
  }
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
