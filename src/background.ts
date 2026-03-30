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
import type { FocusStateSnapshot, StoredConfig, SWMessage, SWMessageResult } from './types';

// Worker URL is fixed per deployment — users never configure this
export const WORKER_URL = 'https://focus.zeyt.io';
const FOCUSLINK_DEV_BUILD = process.env.FOCUSLINK_DEV_BUILD === 'true';
const FOCUSLINK_BUILD_ID = process.env.FOCUSLINK_BUILD_ID || 'prod';
const FOCUSLINK_SYNC_MODE = (
  process.env.FOCUSLINK_SYNC_MODE === 'off'
  || process.env.FOCUSLINK_SYNC_MODE === 'on'
)
  ? process.env.FOCUSLINK_SYNC_MODE
  : 'manual';

// In-memory: track previous blocking state to detect transitions
let _wasBlocking = false;

// In-memory: rate-limit tab-switch state polls (max 1 per hour while browsing)
let _lastPollAt = 0;
const POLL_RATE_LIMIT_MS = 60 * 60_000; // 1 hour — timed sessions handled by alarm

// In-memory: rate-limit POLL_NOW from popup/options (max 1 per 5 min)
let _lastPollNowAt = 0;
const POLL_NOW_RATE_LIMIT_MS = 5 * 60_000;

const BLOCKLIST_ALARM   = 'zeyt_blocklist';
const PAIRING_ALARM     = 'zeyt_pair_poll';
const TRANSITION_ALARM  = 'zeyt_state_transition';
const WARN_ALARM        = 'zeyt_warn'; // fires 1 min before open session ends
const STATE_POLL_ALARM  = 'zeyt_state_poll'; // periodic poll while in open mode

const PAIR_POLL_INTERVAL_S    = 10;
const BLOCKLIST_REFRESH_MS    = 24 * 60 * 60_000; // 24 hours
const STALE_THRESHOLD_MS      = 4  * 60 * 60_000; // 4 hours (fail-closed guard)
const STATE_POLL_INTERVAL_MIN = 15;              // safety poll for indefinite open mode only

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncRuntimeState({ refreshOnResume: true });
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRuntimeState({ refreshOnResume: true });
});

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;

  if (alarm.name === BLOCKLIST_ALARM)  await refreshBlockList();
  if (alarm.name === PAIRING_ALARM)    await pollPairingStatus();
  if (alarm.name === TRANSITION_ALARM) {
    // Block optimistically first — session has ended, phone may not have pushed yet.
    // pollFocusState() will confirm (or undo if the session was extended on the phone).
    const cfg = await getConfig();
    await applyFocusState(true, cfg.lastBlockList ?? []);
    await pollFocusState();
  }
  if (alarm.name === WARN_ALARM)       await injectWarningToast();
  if (alarm.name === STATE_POLL_ALARM) {
    // Periodic background poll — catches the open→blocking transition when no
    // tab navigation or focus change has occurred (e.g. user already has a
    // blocked site open when the phone locks).
    // Only fires when we think we're NOT blocking; declarativeNetRequest + TRANSITION_ALARM
    // handle the blocking→open direction.
    if (!config.groupId || !config.extensionDeviceToken) return;
    if (!config.lastFocusState?.isBlocking) {
      // Timed open sessions already have an exact transition alarm.
      if (config.lastFocusState?.endsAt != null) return;
      await pollFocusState();
    }
  }
});

// ─── Navigation trigger ───────────────────────────────────────────────────────
// Check block state only when the user navigates to a URL in the block list.
// If rules are already active, declarativeNetRequest redirects to blocked.html
// before onUpdated fires — so this only triggers when the extension doesn't
// yet know it should be blocking (the exact moment that matters).

chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;
  const blockList = config.lastBlockList ?? [];
  if (blockList.length === 0) return;
  try {
    const hostname = new URL(tab.url).hostname;
    const relevant = blockList.some(d => hostname === d || hostname.endsWith(`.${d}`));
    if (relevant) await pollFocusState();
  } catch { /* invalid URL — ignore */ }
});

// ─── Window focus trigger ─────────────────────────────────────────────────────
// Catches the open → still transition: when still mode starts on the phone,
// the extension has no blocking rules yet so onUpdated never fires.
//
// We poll once when the user brings Chrome to the foreground — but ONLY when
// the extension currently thinks it's in Open mode (isBlocking=false). If
// we're already blocking, onUpdated + blocked.html "Check now" handles the
// still → open direction, so no extra requests needed.
//
// Rate-limited to once per 15 min to avoid hammering if the user switches
// windows frequently. Real-world: ~2-4 polls/day during open mode.

async function rateLimitedPoll(): Promise<void> {
  const now = Date.now();
  if (now - _lastPollAt < POLL_RATE_LIMIT_MS) return;
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;
  if (!config.groupId || !config.extensionDeviceToken) return;
  // Skip if already blocking — onUpdated + blocked.html covers that direction
  if (config.lastFocusState?.isBlocking) return;
  // Skip if a known end time exists — transition alarm fires at exactly the right moment
  if (config.lastFocusState?.endsAt != null) return;
  _lastPollAt = now;
  await pollFocusState();
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) rateLimitedPoll();
});

// ─── Block list ───────────────────────────────────────────────────────────────

async function maybeRefreshBlockList(): Promise<void> {
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;
  if (!config.groupId || !config.extensionDeviceToken) return;
  const age = Date.now() - (config.blockListFetchedAt ?? 0);
  if (age > BLOCKLIST_REFRESH_MS) await refreshBlockList();
}

async function refreshBlockList(): Promise<void> {
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;
  if (!config.groupId || !config.extensionDeviceToken) return;
  const api = new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);
  try {
    const blockList = await api.getBlockList(config.lastBlockListVersion ?? undefined);
    if (blockList === null) return; // 304 Not Modified — already up to date
    await setConfig({
      lastBlockList: blockList.domains,
      lastBlockListVersion: blockList.version,
      blockListFetchedAt: Date.now(),
    });
  } catch (err) {
    if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
      await clearPairing();
      await clearBlockRules();
      await setStateIcon('uncoupled');
      return;
    }
    console.warn('[zeyt] Block list refresh failed:', err);
  }
}

// ─── Focus state ──────────────────────────────────────────────────────────────

async function scheduleTransitionAlarm(endsAt: number | null): Promise<void> {
  await chrome.alarms.clear(TRANSITION_ALARM);
  await chrome.alarms.clear(WARN_ALARM);
  if (endsAt === null) return;

  const delayMs = endsAt - Date.now();
  if (delayMs <= 0) {
    // Session already ended — poll immediately to get fresh state
    await pollFocusState();
    return;
  }

  // Chrome alarms minimum is 1 min; sub-minute sessions fire ~1 min late (acceptable)
  chrome.alarms.create(TRANSITION_ALARM, { delayInMinutes: Math.max(1, delayMs / 60_000) });

  // Warn 1 minute before session ends — only worth showing if there's >2 min left
  const warnDelayMs = delayMs - 60_000;
  if (warnDelayMs > 60_000) {
    chrome.alarms.create(WARN_ALARM, { delayInMinutes: warnDelayMs / 60_000 });
  }
}

// ─── 1-minute warning toast ────────────────────────────────────────────────────
// Injects a small branded overlay into all visible tabs when the open session
// is about to expire. Self-contained: no content script file needed.

async function injectWarningToast(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => {
          const ID = 'zeyt-warning-toast';
          if (document.getElementById(ID)) return; // already shown

          const toast = document.createElement('div');
          toast.id = ID;
          toast.innerHTML = `
            <span style="font-size:15px;line-height:1">⏱</span>
            <span><strong style="font-weight:700">1 minute left</strong> · zeyt open mode ends soon</span>
            <button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0;margin-left:4px;opacity:.7;line-height:1">×</button>
          `;
          Object.assign(toast.style, {
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%) translateY(-80px)',
            zIndex: '2147483647',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: '#3A4F3F',
            color: '#F5F0E8',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '14px',
            padding: '12px 18px',
            borderRadius: '100px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
            transition: 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1)',
            whiteSpace: 'nowrap',
          });
          document.body.appendChild(toast);

          // Animate in
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              toast.style.transform = 'translateX(-50%) translateY(0)';
            });
          });

          // Auto-dismiss after 5s
          setTimeout(() => {
            toast.style.transform = 'translateX(-50%) translateY(-80px)';
            toast.style.transition = 'transform 0.3s ease-in';
            setTimeout(() => toast.remove(), 350);
          }, 5_000);
        },
      });
    } catch {
      // Tab may have navigated or be restricted — ignore
    }
  }
}

async function pollFocusState(): Promise<void> {
  const config = await getConfig();
  if (!config.focuslinkLiveSyncEnabled) return;
  if (!config.groupId || !config.extensionDeviceToken) return;

  const api = new FocusLinkAPI(WORKER_URL, config.groupId, config.extensionDeviceToken);

  try {
    const state = await api.getFocusState(config.lastFocusState?.version ?? undefined);

    if (state === null) {
      // 304 Not Modified — state unchanged, but re-apply with current block list
      // (block list may have been refreshed independently since last apply)
      if (config.lastFocusState) {
        await setConfig({ lastFocusState: { ...config.lastFocusState, fetchedAt: Date.now() } });
        await scheduleTransitionAlarm(config.lastFocusState.endsAt);
        await applyFocusState(config.lastFocusState.isBlocking, config.lastBlockList ?? []);
      }
      return;
    }

    const snapshot: FocusStateSnapshot = {
      isBlocking: state.isBlocking,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      endsAt: state.endsAt,
      blockListVersion: state.blockListVersion,
      version: state.version,
      fetchedAt: Date.now(),
    };

    await setConfig({ lastFocusState: snapshot });
    await scheduleTransitionAlarm(snapshot.endsAt);
    await applyFocusState(state.isBlocking, config.lastBlockList ?? []);
  } catch (err) {
    if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
      // Credentials rejected — app was uninstalled or device revoked
      await clearPairing();
      await clearBlockRules();
      await setStateIcon('uncoupled');
      await notifyPopup({ type: 'UNLINKED' });
      return;
    }
    console.error('[zeyt] State poll failed:', err);
    await applyFailClosed();
    await setBadge('!', '#f59e0b');
  }
}

async function applyFocusState(isBlocking: boolean, domains: string[]): Promise<void> {
  if (isBlocking) {
    await updateBlockRules(domains);
    await setStateIcon('still');
    // On transition to blocking: redirect any already-open tabs that match the block list.
    // declarativeNetRequest only intercepts new navigations — existing tabs need explicit redirect.
    if (!_wasBlocking) {
      await redirectMatchingTabs(domains);
    }
  } else {
    await clearBlockRules();
    await setStateIcon('open');
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
  if (!config.focuslinkLiveSyncEnabled) {
    await chrome.alarms.clear(PAIRING_ALARM);
    return;
  }

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
          // Popup opened or blocked.html "Check now" — fetch state (and block list if stale)
          // Rate-limited: blocked.html "Check now" bypasses the limit via force flag
          const now = Date.now();
          const cfg = await getConfig();
          if (cfg.focuslinkLiveSyncEnabled && (message.force || now - _lastPollNowAt > POLL_NOW_RATE_LIMIT_MS)) {
            _lastPollNowAt = now;
            // Only refresh block list if it's more than 1 hour old — the 24h alarm handles
            // scheduled refreshes; refreshing on every poll wastes DO requests.
            if (now - (cfg.blockListFetchedAt ?? 0) > 60 * 60_000) {
              await refreshBlockList();
            }
            await pollFocusState();
          }
          sendResponse(await handleGetStatus());
          break;
        }
        case 'RESUME_LIVE_SYNC': {
          await setConfig({ focuslinkLiveSyncEnabled: true });
          await syncRuntimeState({ refreshOnResume: true });
          sendResponse(await handleGetStatus());
          break;
        }
        case 'UNPAIR': {
          await chrome.alarms.clear(TRANSITION_ALARM);
          await chrome.alarms.clear(WARN_ALARM);
          await clearPairing();
          await clearBlockRules();
          await setStateIcon('uncoupled');
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
  if (!config.focuslinkLiveSyncEnabled) {
    return { type: 'ERROR', message: 'Live sync is paused in this dev build. Resume live sync to pair against production.' };
  }
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
    const isServerError = err instanceof APIError && err.status >= 500;
    const msg = isServerError
      ? 'The zeyt server is temporarily unavailable — please try again in a few minutes.'
      : err instanceof APIError
      ? err.message
      : 'Failed to start pairing.';
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
    startedAt: snapshot?.startedAt ?? null,
    endsAt: snapshot?.endsAt ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    syncIssue: stale,
    liveSyncEnabled: config.focuslinkLiveSyncEnabled,
    isDevBuild: FOCUSLINK_DEV_BUILD,
    syncMode: FOCUSLINK_DEV_BUILD ? FOCUSLINK_SYNC_MODE : 'on',
  };
}

async function syncRuntimeState(
  { refreshOnResume = false }: { refreshOnResume?: boolean } = {},
): Promise<StoredConfig> {
  let config = await getConfig();
  const next: Partial<StoredConfig> = {};

  if (config.lastBuildId !== FOCUSLINK_BUILD_ID) {
    next.lastBuildId = FOCUSLINK_BUILD_ID;
  }

  if (FOCUSLINK_DEV_BUILD) {
    if (FOCUSLINK_SYNC_MODE === 'off') {
      if (config.focuslinkLiveSyncEnabled !== false) {
        next.focuslinkLiveSyncEnabled = false;
      }
    } else if (FOCUSLINK_SYNC_MODE === 'on') {
      if (config.focuslinkLiveSyncEnabled !== true) {
        next.focuslinkLiveSyncEnabled = true;
      }
    } else if (
      config.lastBuildId !== FOCUSLINK_BUILD_ID
      || typeof config.focuslinkLiveSyncEnabled !== 'boolean'
    ) {
      next.focuslinkLiveSyncEnabled = false;
    }
  } else if (config.focuslinkLiveSyncEnabled !== true) {
    next.focuslinkLiveSyncEnabled = true;
  }

  if (Object.keys(next).length > 0) {
    await setConfig(next);
    config = { ...config, ...next };
  }

  if (!config.focuslinkLiveSyncEnabled) {
    await chrome.alarms.clear(BLOCKLIST_ALARM);
    await chrome.alarms.clear(STATE_POLL_ALARM);
    await chrome.alarms.clear(PAIRING_ALARM);
    await chrome.alarms.clear(TRANSITION_ALARM);
    await chrome.alarms.clear(WARN_ALARM);
    await clearBlockRules();
    await setStateIcon(config.groupId && config.extensionDeviceToken ? 'open' : 'uncoupled');
    return config;
  }

  if (config.groupId && config.extensionDeviceToken) {
    chrome.alarms.create(BLOCKLIST_ALARM, { periodInMinutes: 24 * 60 });
    chrome.alarms.create(STATE_POLL_ALARM, { periodInMinutes: STATE_POLL_INTERVAL_MIN });
  } else {
    await chrome.alarms.clear(BLOCKLIST_ALARM);
    await chrome.alarms.clear(STATE_POLL_ALARM);
  }

  if (config.pairing?.status === 'pending') {
    chrome.alarms.create(PAIRING_ALARM, { periodInMinutes: PAIR_POLL_INTERVAL_S / 60 });
  } else {
    await chrome.alarms.clear(PAIRING_ALARM);
  }

  await initIcon();

  if (refreshOnResume && config.groupId && config.extensionDeviceToken) {
    await maybeRefreshBlockList();
    await pollFocusState();
  }

  return config;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Icon states ─────────────────────────────────────────────────────────────
// Draws the zeyt logo on an OffscreenCanvas with different color schemes
// for each connection/blocking state, then applies via chrome.action.setIcon.

type IconState = 'uncoupled' | 'still' | 'open';

const ICON_COLORS: Record<IconState, { bg: string; z: string; dot: string }> = {
  uncoupled: { bg: '#F59E0B', z: '#1C1C1E', dot: '#F59E0B' }, // amber — attention-grabbing, not aggressive
  still:     { bg: '#3A4F3F', z: '#C4956A', dot: '#3A4F3F' }, // dark green + gold — matches app still mode
  open:      { bg: '#F5EDE0', z: '#3A4F3F', dot: '#F5EDE0' }, // warm cream + dark green — matches app open mode
};

const LOGO_MARK = 'M660.355 765C662.92 765.001 665.44 764.329 667.663 763.051C669.886 761.774 671.734 759.936 673.022 757.722C674.31 755.507 674.992 752.994 675 750.434C675.008 747.874 674.342 745.356 673.069 743.133L548.685 525.989L519.494 576.882L591.693 702.924C592.966 705.146 593.632 707.664 593.624 710.224C593.615 712.784 592.933 715.298 591.646 717.512C590.358 719.726 588.51 721.564 586.287 722.842C584.064 724.119 581.544 724.791 578.978 724.79L439.686 724.752C437.12 724.751 434.6 724.077 432.378 722.799C430.156 721.52 428.309 719.681 427.022 717.466C425.736 715.251 425.055 712.737 425.048 710.177C425.042 707.617 425.709 705.1 426.983 702.878L668.981 280.956C670.256 278.734 670.923 276.216 670.916 273.656C670.909 271.096 670.229 268.582 668.942 266.367C667.656 264.152 665.809 262.313 663.587 261.034C661.364 259.756 658.844 259.082 656.279 259.082C541.608 259.05 477.316 259.032 362.645 259C360.08 258.999 357.56 259.671 355.337 260.949C353.114 262.226 351.266 264.064 349.978 266.278C348.691 268.493 348.008 271.006 348 273.566C347.992 276.126 348.658 278.644 349.931 280.867L474.315 498.011L503.506 447.118L431.307 321.076C430.034 318.854 429.368 316.336 429.376 313.776C429.385 311.216 430.067 308.702 431.354 306.488C432.642 304.274 434.49 302.436 436.713 301.158C438.936 299.881 441.456 299.209 444.022 299.21L583.314 299.249C585.88 299.249 588.4 299.923 590.622 301.201C592.844 302.48 594.691 304.319 595.978 306.534C597.264 308.749 597.945 311.263 597.952 313.823C597.958 316.383 597.291 318.9 596.017 321.122L354.019 743.044C352.744 745.266 352.077 747.784 352.084 750.344C352.091 752.904 352.771 755.418 354.058 757.633C355.344 759.848 357.191 761.687 359.413 762.966C361.636 764.244 364.156 764.918 366.721 764.918L660.355 765Z';

async function setStateIcon(state: IconState): Promise<void> {
  const c = ICON_COLORS[state];
  const sizes = [16, 48, 128] as const;
  const imageData: Record<number, ImageData> = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const scale = size / 1024;
    ctx.scale(scale, scale);

    // Background rounded rect
    ctx.beginPath();
    ctx.roundRect(0, 0, 1024, 1024, 50);
    ctx.fillStyle = c.bg;
    ctx.fill();

    // Brand mark
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.z;
    ctx.fill(new Path2D(LOGO_MARK));

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }

  await chrome.action.setIcon({
    imageData: imageData as unknown as { [size: number]: ImageData },
  });
  await chrome.action.setBadgeText({ text: '' });
}

async function initIcon(): Promise<void> {
  const config = await getConfig();
  if (config.groupId && config.extensionDeviceToken) {
    await setStateIcon(config.lastFocusState?.isBlocking ? 'still' : 'open');
  } else {
    await setStateIcon('uncoupled');
  }
}

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
