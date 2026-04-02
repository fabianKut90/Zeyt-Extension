import type { StoredConfig, FocusStateSnapshot } from './types';

const CONFIG_KEY = 'config';

function generateDeviceId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const DEFAULTS: StoredConfig = {
  extensionDeviceId: generateDeviceId(),
  groupId: null,
  extensionDeviceToken: null,
  focuslinkLiveSyncEnabled: true,
  topSitesPromptShown: false,
  warningPromptShown: false,
  oneMinuteWarningEnabled: false,
  lastBuildId: null,
  lastFocusState: null,
  lastBlockList: [],
  lastBlockListVersion: 0,
  blockListFetchedAt: 0,
  pairing: null,
};

export async function getConfig(): Promise<StoredConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  if (!result[CONFIG_KEY]) {
    // First run: generate a stable extensionDeviceId and persist it
    const config: StoredConfig = { ...DEFAULTS, extensionDeviceId: generateDeviceId() };
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    return config;
  }
  return result[CONFIG_KEY] as StoredConfig;
}

export async function setConfig(partial: Partial<StoredConfig>): Promise<void> {
  const current = await getConfig();
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...current, ...partial } });
}

export async function clearPairing(): Promise<void> {
  await setConfig({
    groupId: null,
    extensionDeviceToken: null,
    lastFocusState: null,
    lastBlockList: [],
    lastBlockListVersion: 0,
    blockListFetchedAt: 0,
    pairing: null,
  });
}

export function isSyncing(snapshot: FocusStateSnapshot | null, thresholdMs = 90_000): boolean {
  if (!snapshot) return false;
  return Date.now() - snapshot.fetchedAt < thresholdMs;
}

export function shouldFailClosed(
  snapshot: FocusStateSnapshot | null,
  thresholdMs = 90_000,
): boolean {
  if (!snapshot) return false;
  const stale = Date.now() - snapshot.fetchedAt > thresholdMs;
  return snapshot.isBlocking && stale;
}
