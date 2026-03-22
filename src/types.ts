// Subset of backend types used by extension

export interface FocusState {
  isBlocking: boolean;
  sessionId: string | null;
  startedAt: number | null;
  endsAt: number | null;
  unlockedAt: number | null;
  blockListVersion: number;
  version: number;
  updatedAt: number;
}

export interface BlockList {
  domains: string[];
  version: number;
  updatedAt: number;
}

export interface QRPayload {
  v: 1;
  g: string;   // groupId
  t: string;   // pairingToken
  u: string;   // worker base URL
}

// ─── Extension local storage ──────────────────────────────────────────────────

export interface PairingInProgress {
  pairingToken: string;
  groupId: string;
  expiresAt: number;
  status: 'pending' | 'completed';
}

export interface StoredConfig {
  extensionDeviceId: string;          // stable, generated once, never changes
  groupId: string | null;
  extensionDeviceToken: string | null;
  lastFocusState: FocusStateSnapshot | null;
  lastBlockList: string[];
  lastBlockListVersion: number;
  blockListFetchedAt: number;         // timestamp of last block list fetch (0 = never)
  pairing: PairingInProgress | null;
}

export interface FocusStateSnapshot {
  isBlocking: boolean;
  sessionId: string | null;
  startedAt: number | null;
  endsAt: number | null;
  blockListVersion: number;
  version: number;
  fetchedAt: number;   // local timestamp of last successful fetch
}

// ─── Service worker messages ──────────────────────────────────────────────────

export type SWMessage =
  | { type: 'START_PAIRING' }
  | { type: 'GET_STATUS' }
  | { type: 'POLL_NOW' }   // triggered by popup open — immediate fresh fetch
  | { type: 'UNPAIR' };

export type SWMessageResult =
  | { type: 'PAIRING_STARTED'; qrPayload: string; expiresAt: number }
  | { type: 'STATUS'; isPaired: boolean; isBlocking: boolean; pairingStatus: string | null; startedAt: number | null; endsAt: number | null; fetchedAt: number | null; syncIssue: boolean }
  | { type: 'PAIRING_COMPLETE' }
  | { type: 'PAIRING_EXPIRED' }
  | { type: 'UNLINKED' }
  | { type: 'ERROR'; message: string };
