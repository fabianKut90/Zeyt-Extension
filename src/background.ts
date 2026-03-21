/**
 * zeyt Service Worker (MV3)
 *
 * Responsibilities:
 * - Schedule state polling via chrome.alarms (survives SW restarts)
 * - Poll /state endpoint with ETag to avoid redundant parsing
 * - Apply or clear declarativeNetRequest block rules
 * - Handle pairing: initiate, poll for completion
 * - Fail-closed: maintain block rules when state becomes stale during active block
 */

import { getConfig, setConfig, clearPairing, shouldFailClosed } from './storage';
import { FocusLinkAPI, startPairing, checkPairingStatus, APIError } from './api';
import { updateBlockRules, clearBlockRules } from './rules';
import type { FocusStateSnapshot, SWMessage, SWMessageResult } from './types';

// Worker URL is fixed per deployment — users never configure this
export const WORKER_URL = 'https://focuslink.fabian-kutschera.workers.dev';

const POLL_ALARM = 'zeyt_poll';
const PAIRING_ALARM = 'zeyt_pair_poll';

const POLL_INTERVAL_ACTIVE_S = 15;
const POLL_INTERVAL_IDLE_S = 60;
const PAIR_POLL_INTERVAL_S = 3;
const STALE_THRESHOLD_MS = 90_000; // 90 seconds

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await schedulePoll(POLL_INTERVAL_ACTIVE_S);
  await pollFocusState();
});

chrome.runtime.onStartup.addListener(async () => {
  await schedulePoll(POLL_INTERVAL_ACTIVE_S);
  await pollFocusState();
});

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM) {
    await pollFocusState();
  }
  if (alarm.name === PAIRING_ALARM) {
    await pollPairingStatus();
  }
});

async function schedulePoll(intervalSeconds: number): Promise<void> {
  await chrome.alarms.clear(POLL_ALARM);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: intervalSeconds / 60 });
}

// ─── Focus state polling ──────────────────────────────────────────────────────

async function pollFocusState(): Promise<void> {
  const config = await getConfig();

  if (!config.groupId || !config.extensionDeviceToken) return; // not paired

  const api = new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);

  try {
    const state = await api.getFocusState(config.lastFocusState?.version ?? undefined);

    if (state === null) {
      // 304 Not Modified — just update fetchedAt to record freshness
      if (config.lastFocusState) {
        await setConfig({
          lastFocusState: { ...config.lastFocusState, fetchedAt: Date.now() },
        });
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

    // Refresh block list if version changed
    if (state.blockListVersion !== config.lastBlockListVersion) {
      const blockList = await api.getBlockList();
      await setConfig({
        lastBlockList: blockList.domains,
        lastBlockListVersion: blockList.version,
      });
    }

    await applyFocusState(state.isBlocking, await getEffectiveBlockList());
    await updatePollInterval(state.isBlocking);
  } catch (err) {
    console.error('[zeyt] Poll failed:', err);
    await applyFailClosed();
    await setBadge('!', '#f59e0b'); // yellow warning badge
  }
}

async function applyFocusState(isBlocking: boolean, domains: string[]): Promise<void> {
  if (isBlocking) {
    await updateBlockRules(domains);
    await setBadge('ON', '#ef4444');
  } else {
    await clearBlockRules();
    await setBadge('', '#6b7280');
  }
}

async function applyFailClosed(): Promise<void> {
  const config = await getConfig();
  const snapshot = config.lastFocusState;

  if (!snapshot) return;

  if (shouldFailClosed(snapshot, STALE_THRESHOLD_MS)) {
    // Active block + stale state → keep block rules, do NOT clear
    console.warn('[zeyt] Fail-closed: maintaining block rules due to stale state');
    await setBadge('!', '#f59e0b');
  }
  // If not blocking and state is stale, safe to leave unblocked (already cleared)
}

async function updatePollInterval(isBlocking: boolean): Promise<void> {
  const interval = isBlocking ? POLL_INTERVAL_ACTIVE_S : POLL_INTERVAL_IDLE_S;
  await schedulePoll(interval);
}

async function getEffectiveBlockList(): Promise<string[]> {
  const config = await getConfig();
  return config.lastBlockList;
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
      await pollFocusState(); // immediate sync after pairing
    } else if (result.status === 'expired') {
      await setConfig({ pairing: null });
      await chrome.alarms.clear(PAIRING_ALARM);
      await notifyPopup({ type: 'PAIRING_EXPIRED' });
    }
  } catch (err) {
    console.error('[zeyt] Pairing poll failed:', err);
    // Retry on next alarm tick
  }
}

// ─── Message handler (from popup / options) ───────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: SWMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: SWMessageResult) => void,
  ) => {
    (async () => {
      switch (message.type) {
        case 'START_PAIRING': {
          const result = await handleStartPairing();
          sendResponse(result);
          break;
        }
        case 'GET_STATUS': {
          const result = await handleGetStatus();
          sendResponse(result);
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
    return true; // Keep message channel open for async response
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
    // Poll for completion every 3 seconds
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
