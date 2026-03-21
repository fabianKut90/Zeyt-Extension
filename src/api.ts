import type { FocusState, BlockList } from './types';

export class APIError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'APIError';
  }
}

// DOM's Response.json() returns Promise<any> without generics — helper for typed parsing
async function parseJson<T>(resp: Response): Promise<T> {
  return resp.json() as Promise<T>;
}

async function parseJsonOrDefault<T>(
  resp: Response,
  fallback: T,
): Promise<T> {
  try {
    return await parseJson<T>(resp);
  } catch {
    return fallback;
  }
}

export class FocusLinkAPI {
  constructor(
    private readonly baseUrl: string,
    private readonly groupId: string,
    private readonly deviceToken: string,
  ) {}

  private get groupBase(): string {
    return `${this.baseUrl}/groups/${this.groupId}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await fetch(`${this.groupBase}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.deviceToken}`,
        ...init?.headers,
      },
    });

    if (!resp.ok) {
      const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
        error: 'UNKNOWN',
        message: `HTTP ${resp.status}`,
      });
      throw new APIError(body.error, body.message, resp.status);
    }

    return parseJson<T>(resp);
  }

  /**
   * Fetch focus state. Sends If-None-Match to avoid redundant JSON parsing.
   * Returns null if server responded 304 (unchanged).
   */
  async getFocusState(currentVersion?: number): Promise<FocusState | null> {
    const headers: Record<string, string> = {};
    if (currentVersion !== undefined) {
      headers['If-None-Match'] = `"${currentVersion}"`;
    }

    const resp = await fetch(`${this.groupBase}/state`, {
      headers: {
        Authorization: `Bearer ${this.deviceToken}`,
        ...headers,
      },
    });

    if (resp.status === 304) return null; // Not Modified

    if (!resp.ok) {
      const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
        error: 'UNKNOWN',
        message: `HTTP ${resp.status}`,
      });
      throw new APIError(body.error, body.message, resp.status);
    }

    return parseJson<FocusState>(resp);
  }

  async getBlockList(): Promise<BlockList> {
    return this.request<BlockList>('/blocklist');
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request('/device/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    });
  }
}

// ─── Pairing (unauthenticated) ────────────────────────────────────────────────

export interface PairStartResult {
  groupId: string;
  pairingToken: string;
  expiresAt: number;
  qrPayload: string;
}

export async function startPairing(
  workerUrl: string,
  extensionDeviceId: string,
): Promise<PairStartResult> {
  const resp = await fetch(`${workerUrl}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extensionDeviceId }),
  });

  if (!resp.ok) {
    const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
      error: 'UNKNOWN',
      message: `HTTP ${resp.status}`,
    });
    throw new APIError(body.error, body.message, resp.status);
  }

  return parseJson<PairStartResult>(resp);
}

export interface PairStatusResult {
  status: 'pending' | 'completed' | 'expired';
  extensionDeviceToken?: string;
  groupId?: string;
}

export async function checkPairingStatus(
  workerUrl: string,
  groupId: string,
  pairingToken: string,
): Promise<PairStatusResult> {
  const resp = await fetch(
    `${workerUrl}/groups/${groupId}/pair/status?token=${encodeURIComponent(pairingToken)}`,
  );

  if (!resp.ok) {
    const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
      error: 'UNKNOWN',
      message: `HTTP ${resp.status}`,
    });
    throw new APIError(body.error, body.message, resp.status);
  }

  return parseJson<PairStatusResult>(resp);
}
