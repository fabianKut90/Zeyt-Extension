/**
 * zeyt Service Worker (MV3)
 *
 * Two separate concerns, two separate cadences:
 *
 * 1. BLOCK LIST (what to block) — refreshed once per day + on popup open.
 *    Stored locally. Never fetched per navigation.
 *
 * 2. BLOCK STATE (are we blocking right now?) — fetched on demand only when
 *    the user navigates to a URL that is in the local block list.
 *    This is the only moment it matters.
 *
 * Cloudflare free tier math (~1,200 users):
 *   Block list:  1 req/user/day  ×  30 days  =      30 req/month
 *   State check: ~10 req/user/day × 30 days  =     300 req/month
 *   Total: ~330 req/user/month → 400k limit → ~1,200 users
 *
 * Unblocking flow: phone unlocks → user tries blocked site → blocked.html
 * auto-check fires → POLL_NOW → isBlocking: false → rules cleared → reload.
 */

import { getConfig, setConfig, clearPairing, shouldFailClosed } from './storage';
import { FocusLinkAPI, startPairing, checkPairingStatus, APIError } from './api';
import { updateBlockRules, clearBlockRules } from './rules';
import type { FocusStateSnapshot, SWMessage, SWMessageResult } from './types';

// Worker URL is fixed per deployment — users never configure this
export const WORKER_URL = 'https://focus.zeyt.io';

// In-memory: track previous blocking state to detect transitions
let _wasBlocking = false;

const BLOCKLIST_ALARM   = 'zeyt_blocklist';
const PAIRING_ALARM     = 'zeyt_pair_poll';

const PAIR_POLL_INTERVAL_S    = 3;
const BLOCKLIST_REFRESH_MS    = 24 * 60 * 60_000; // 24 hours
const STALE_THRESHOLD_MS      = 4  * 60 * 60_000; // 4 hours (fail-closed guard)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(BLOCKLIST_ALARM, { periodInMinutes: 24 * 60 });
  await maybeRefreshBlockList();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(BLOCKLIST_ALARM, { periodInMinutes: 24 * 60 });
  await maybeRefreshBlockList();
});

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BLOCKLIST_ALARM) await refreshBlockList();
  if (alarm.name === PAIRING_ALARM)   await pollPairingStatus();
});

// ─── Navigation trigger ───────────────────────────────────────────────────────
// Check block state only when the user navigates to a URL in the block list.
// If rules are already active, declarativeNetRequest redirects to blocked.html
// before onUpdated fires — so this only triggers when the extension doesn't
// yet know it should be blocking (the exact moment that matters).

chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const config = await getConfig();
  const blockList = config.lastBlockList ?? [];
  if (blockList.length === 0) return;
  try {
    const hostname = new URL(tab.url).hostname;
    const relevant = blockList.some(d => hostname === d || hostname.endsWith(`.${d}`));
    if (relevant) await pollFocusState();
  } catch { /* invalid URL — ignore */ }
});

// ─── Block list ───────────────────────────────────────────────────────────────

async function maybeRefreshBlockList(): Promise<void> {
  const config = await getConfig();
  if (!config.groupId || !config.extensionDeviceToken) return;
  const age = Date.now() - (config.blockListFetchedAt ?? 0);
  if (age > BLOCKLIST_REFRESH_MS) await refreshBlockList();
}

async function refreshBlockList(): Promise<void> {
  const config = await getConfig();
  if (!config.groupId || !config.extensionDeviceToken) return;
  const api = new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);
  try {
    const blockList = await api.getBlockList();
    await setConfig({
      lastBlockList: blockList.domains,
      lastBlockListVersion: blockList.version,
      blockListFetchedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[zeyt] Block list refresh failed:', err);
  }
}

// ─── Focus state ──────────────────────────────────────────────────────────────

async function pollFocusState(): Promise<void> {
  const config = await getConfig();
  if (!config.groupId || !config.extensionDeviceToken) return;

  const api = new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);

  try {
    const state = await api.getFocusState(config.lastFocusState?.version ?? undefined);

    if (state === null) {
      // 304 Not Modified — state unchanged, but re-apply with current block list
      // (block list may have been refreshed independently since last apply)
      if (config.lastFocusState) {
        await setConfig({ lastFocusState: { ...config.lastFocusState, fetchedAt: Date.now() } });
        await applyFocusState(config.lastFocusState.isBlocking, config.lastBlockList ?? []);
      }
      return;
    }

    const snapshot: FocusStateSnapshot = {
      isBlocking: state.isBlocking,
      sessionId: state.sessionId,
      endsAt: state.endsAt,
      blockListVersion: state.blockListVersion,
      version: state.version,
      fetchedAt: Date.now(),
    };

    await setConfig({ lastFocusState: snapshot });
    await applyFocusState(state.isBlocking, config.lastBlockList ?? []);
  } catch (err) {
    console.error('[zeyt] State poll failed:', err);
    await applyFailClosed();
    await setBadge('!', '#f59e0b');
  }
}

async function applyFocusState(isBlocking: boolean, domains: string[]): Promise<void> {
  if (isBlocking) {
    await updateBlockRules(domains);
    await setBadge('ON', '#ef4444');
    // On transition to blocking: redirect any already-open tabs that match the block list.
    // declarativeNetRequest only intercepts new navigations — existing tabs need explicit redirect.
    if (!_wasBlocking) {
      await redirectMatchingTabs(domains);
    }
  } else {
    await clearBlockRules();
    await setBadge('', '#6b7280');
  }
  _wasBlocking = isBlocking;
}

async function redirectMatchingTabs(domains: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const blockedPage = chrome.runtime.getURL('blocked.html');

  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    if (tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://')) continue;
    try {
      const hostname = new URL(tab.url).hostname;
      const isBlocked = domains.some(d => hostname === d || hostname.endsWith(`.${d}`));
      if (isBlocked) {
        await chrome.tabs.update(tab.id, {
          url: `${blockedPage}?url=${encodeURIComponent(tab.url)}`,
        });
      }
    } catch { /* invalid URL — ignore */ }
  }
}

async function applyFailClosed(): Promise<void> {
  const config = await getConfig();
  const snapshot = config.lastFocusState;
  if (!snapshot) return;
  if (shouldFailClosed(snapshot, STALE_THRESHOLD_MS)) {
    console.warn('[zeyt] Fail-closed: maintaining block rules due to stale state');
    await setBadge('!', '#f59e0b');
  }
}

// ─── Pairing ──────────────────────────────────────────────────────────────────

async function pollPairingStatus(): Promise<void> {
  const config = await getConfig();

  if (!config.pairing || config.pairing.status !== 'pending') {
    await chrome.alarms.clear(PAIRING_ALARM);
    return;
  }

  if (Date.now() > config.pairing.expiresAt) {
    await setConfig({ pairing: null });
    await chrome.alarms.clear(PAIRING_ALARM);
    await notifyPopup({ type: 'PAIRING_EXPIRED' });
    return;
  }

  try {
    const result = await checkPairingStatus(
      WORKER_URL,
      config.pairing.groupId,
      config.pairing.pairingToken,
    );

    if (result.status === 'completed' && result.extensionDeviceToken) {
      await setConfig({
        groupId: config.pairing.groupId,
        extensionDeviceToken: result.extensionDeviceToken,
        pairing: { ...config.pairing, status: 'completed' },
      });
      await chrome.alarms.clear(PAIRING_ALARM);
      await notifyPopup({ type: 'PAIRING_COMPLETE' });
      // After pairing: fetch block list + state immediately
      await refreshBlockList();
      await pollFocusState();
    } else if (result.status === 'expired') {
      await setConfig({ pairing: null });
      await chrome.alarms.clear(PAIRING_ALARM);
      await notifyPopup({ type: 'PAIRING_EXPIRED' });
    }
  } catch (err) {
    console.error('[zeyt] Pairing poll failed:', err);
  }
}

// ─── Message handler (from popup / options / blocked.html) ────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: SWMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: SWMessageResult) => void,
  ) => {
    (async () => {
      switch (message.type) {
        case 'START_PAIRING': {
          sendResponse(await handleStartPairing());
          break;
        }
        case 'GET_STATUS': {
          sendResponse(await handleGetStatus());
          break;
        }
        case 'POLL_NOW': {
          // Popup opened or blocked.html "Check now" — fetch both list and state
          await refreshBlockList();
          await pollFocusState();
          sendResponse(await handleGetStatus());
          break;
        }
        case 'UNPAIR': {
          await clearPairing();
          await clearBlockRules();
          await setBadge('', '#6b7280');
          sendResponse({ type: 'UNLINKED' });
          break;
        }
      }
    })();
    return true;
  },
);

async function handleStartPairing(): Promise<SWMessageResult> {
  const config = await getConfig();
  try {
    const result = await startPairing(WORKER_URL, config.extensionDeviceId);
    await setConfig({
      pairing: {
        pairingToken: result.pairingToken,
        groupId: result.groupId,
        expiresAt: result.expiresAt,
        status: 'pending',
      },
    });
    chrome.alarms.create(PAIRING_ALARM, { periodInMinutes: PAIR_POLL_INTERVAL_S / 60 });
    return { type: 'PAIRING_STARTED', qrPayload: result.qrPayload, expiresAt: result.expiresAt };
  } catch (err) {
    const msg = err instanceof APIError ? err.message : 'Failed to start pairing';
    return { type: 'ERROR', message: msg };
  }
}

async function handleGetStatus(): Promise<SWMessageResult> {
  const config = await getConfig();
  const snapshot = config.lastFocusState;
  const stale = snapshot ? Date.now() - snapshot.fetchedAt > STALE_THRESHOLD_MS : false;

  return {
    type: 'STATUS',
    isPaired: !!(config.groupId && config.extensionDeviceToken),
    isBlocking: snapshot?.isBlocking ?? false,
    pairingStatus: config.pairing?.status ?? null,
    endsAt: snapshot?.endsAt ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    syncIssue: stale,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setBadge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

async function notifyPopup(message: SWMessageResult): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup may be closed — ignore
  }
}
