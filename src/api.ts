import type { FocusState, BlockList } from './types';

const FOCUSLINK_CLIENT_HEADER = 'X-FocusLink-Client';
const FOCUSLINK_SOURCE_HEADER = 'X-FocusLink-Source';
const FOCUSLINK_CLIENT = 'extension';

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

const REQUEST_TIMEOUT_MS = 10_000;

/** Wrap a fetch call with an AbortController timeout. */
function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
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

  private async request<T>(path: string, init?: RequestInit, source = 'extension:request'): Promise<T> {
    const resp = await fetchWithTimeout(`${this.groupBase}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.deviceToken}`,
        [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
        [FOCUSLINK_SOURCE_HEADER]: source,
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
  async getFocusState(currentVersion?: number, source = 'extension:state'): Promise<FocusState | null> {
    const headers: Record<string, string> = {};
    if (currentVersion !== undefined) {
      headers['If-None-Match'] = `"${currentVersion}"`;
    }

    const resp = await fetchWithTimeout(`${this.groupBase}/state`, {
      headers: {
        Authorization: `Bearer ${this.deviceToken}`,
        [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
        [FOCUSLINK_SOURCE_HEADER]: source,
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

  async getBlockList(currentVersion?: number, source = 'extension:blocklist'): Promise<BlockList | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deviceToken}`,
      [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
      [FOCUSLINK_SOURCE_HEADER]: source,
    };
    if (currentVersion !== undefined) {
      headers['If-None-Match'] = `"${currentVersion}"`;
    }

    const resp = await fetchWithTimeout(`${this.groupBase}/blocklist`, { headers });

    if (resp.status === 304) return null;

    if (!resp.ok) {
      const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
        error: 'UNKNOWN',
        message: `HTTP ${resp.status}`,
      });
      throw new APIError(body.error, body.message, resp.status);
    }

    return parseJson<BlockList>(resp);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request('/device/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }, 'extension:device.revoke');
  }

  async setReviewOpenNow(): Promise<void> {
    await this.request('/review/open-now', { method: 'POST' }, 'extension:review.open-now');
  }

  async setReviewOpenForFiveMinutes(): Promise<void> {
    await this.request('/review/open-5m', { method: 'POST' }, 'extension:review.open-5m');
  }

  async setReviewStillNow(): Promise<void> {
    await this.request('/review/still-now', { method: 'POST' }, 'extension:review.still-now');
  }

  async installReviewInstagramBlocklist(): Promise<void> {
    await this.request('/review/blocklist/install-instagram', { method: 'POST' }, 'extension:review.blocklist.install-instagram');
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
  source = 'extension:pairing.start',
): Promise<PairStartResult> {
  const resp = await fetchWithTimeout(`${workerUrl}/pair/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
      [FOCUSLINK_SOURCE_HEADER]: source,
    },
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
  source = 'extension:pairing.status',
): Promise<PairStatusResult> {
  const resp = await fetchWithTimeout(
    `${workerUrl}/groups/${groupId}/pair/status?token=${encodeURIComponent(pairingToken)}`,
    {
      headers: {
        [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
        [FOCUSLINK_SOURCE_HEADER]: source,
      },
    },
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

export interface ReviewDemoConnectResult {
  groupId: string;
  extensionDeviceToken: string;
}

export async function connectReviewDemo(
  workerUrl: string,
  extensionDeviceId: string,
): Promise<ReviewDemoConnectResult> {
  const resp = await fetchWithTimeout(`${workerUrl}/review/demo/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [FOCUSLINK_CLIENT_HEADER]: FOCUSLINK_CLIENT,
      [FOCUSLINK_SOURCE_HEADER]: 'extension:review.demo.connect',
    },
    body: JSON.stringify({ extensionDeviceId }),
  });

  if (!resp.ok) {
    const body = await parseJsonOrDefault<{ error: string; message: string }>(resp, {
      error: 'UNKNOWN',
      message: `HTTP ${resp.status}`,
    });
    throw new APIError(body.error, body.message, resp.status);
  }

  return parseJson<ReviewDemoConnectResult>(resp);
}
