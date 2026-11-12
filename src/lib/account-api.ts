import { apiRequest, VeniceApiError } from './api.js';
import { requireApiKey } from './config.js';

export type BillingCurrency = 'USD' | 'DIEM' | 'BUNDLED_CREDITS';

export interface BillingBalance {
  canConsume: boolean;
  consumptionCurrency: BillingCurrency | 'VCU' | null;
  balances: {
    diem: number | null;
    usd: number | null;
  };
  diemEpochAllocation: number;
}

export interface BillingUsageEntry {
  amount: number;
  currency: BillingCurrency;
  inferenceDetails: {
    completionTokens: number | null;
    inferenceExecutionTime: number | null;
    promptTokens: number | null;
    requestId: string;
  } | null;
  notes: string;
  pricePerUnitUsd: number;
  sku: string;
  timestamp: string;
  units: number;
}

export type ConsumptionLimits = {
  usd?: number | null;
  diem?: number | null;
};

export interface ApiKeyMetadata {
  apiKeyType: 'INFERENCE' | 'ADMIN';
  consumptionLimits: ConsumptionLimits;
  limitPeriod: 'EPOCH' | 'MONTH' | 'LIFETIME';
  createdAt: string | null;
  description?: string;
  expiresAt: string | null;
  id: string;
  last6Chars: string;
  lastUsedAt: string | null;
  modelPrivacy?: 'ALL' | 'PRIVATE_TEXT' | 'PRIVATE_ONLY';
  ipAllowlist?: string[];
  usage?: {
    trailingSevenDays: {
      usd: string;
      diem: string;
    };
  };
  currentPeriodUsage?: {
    usd: string;
    diem: string;
  };
}

export interface ApiKeyRateLimits {
  accessPermitted: boolean;
  apiTier: {
    id: string;
    isCharged: boolean;
  };
  balances: {
    USD?: number | null;
    DIEM?: number | null;
  };
  keyExpiration: string | null;
  nextEpochBegins: string;
  rateLimits: Array<{
    apiModelId?: string;
    rateLimits: Array<{
      amount: number;
      type: string;
    }>;
  }>;
}

export interface ApiKeyRateLimitLogEntry {
  apiKeyId: string;
  modelId: string;
  rateLimitTier: string;
  rateLimitType: string;
  timestamp: string;
}

const API_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_BILLING_USAGE_PAGES = 100;
export const MAX_BILLING_USAGE_PAGE_SIZE = 1000;

export function assertApiKeyId(id: string): void {
  if (!API_KEY_ID_PATTERN.test(id)) {
    throw new Error(
      'Invalid API key ID. Use the UUID shown by "venice keys list", not the API key secret.'
    );
  }
}

export async function getBillingBalance(): Promise<BillingBalance> {
  return apiRequest<BillingBalance>('/billing/balance', {
    spinnerText: 'Fetching balance...',
  });
}

export async function getBillingUsage(options: {
  startTimestamp: string;
  endTimestamp: string;
  currency?: BillingCurrency;
  pageSize?: number;
}): Promise<BillingUsageEntry[]> {
  const entries: BillingUsageEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  do {
    if (++pages > MAX_BILLING_USAGE_PAGES) {
      const canUseLargerPages =
        (options.pageSize ?? MAX_BILLING_USAGE_PAGE_SIZE) < MAX_BILLING_USAGE_PAGE_SIZE;
      throw new Error(
        `Usage history has more than ${MAX_BILLING_USAGE_PAGES} pages; refusing to fetch more. ` +
        (canUseLargerPages
          ? `Use a shorter --days range or a larger --page-size (at most ${MAX_BILLING_USAGE_PAGE_SIZE}).`
          : 'Use a shorter --days range.')
      );
    }

    const params = new URLSearchParams();
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error('Usage history returned a repeated cursor; refusing to loop indefinitely.');
      }
      seenCursors.add(cursor);
      params.set('cursor', cursor);
    } else {
      params.set('startTimestamp', options.startTimestamp);
      params.set('endTimestamp', options.endTimestamp);
      if (options.currency) params.set('currency', options.currency);
      if (options.pageSize) params.set('pageSize', String(options.pageSize));
    }

    const response: {
      data: BillingUsageEntry[];
      nextCursor: string | null;
    } = await apiRequest(`/billing/usage-history?${params.toString()}`, {
      spinnerText: cursor ? 'Fetching more usage...' : 'Fetching billed usage...',
    });

    entries.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);

  return entries;
}

export async function getBillingAnalytics(lookback: string): Promise<unknown> {
  const params = new URLSearchParams({ lookback });
  return apiRequest(`/billing/usage-analytics?${params.toString()}`, {
    spinnerText: 'Fetching usage analytics...',
  });
}

export async function listApiKeys(): Promise<ApiKeyMetadata[]> {
  const response = await apiRequest<{ data: ApiKeyMetadata[] }>('/api_keys', {
    spinnerText: 'Fetching API keys...',
  });
  return response.data;
}

/**
 * The create request may have reached Venice, so the key may exist although
 * no usable response came back. `keyId` is set when Venice returned the new
 * key's ID but not its secret.
 */
export class ApiKeyCreationError extends Error {
  constructor(message: string, readonly keyId?: string) {
    super(message);
    this.name = 'ApiKeyCreationError';
  }
}

export async function createApiKey(input: {
  apiKeyType: 'INFERENCE' | 'ADMIN';
  description: string;
  expiresAt?: string;
  consumptionLimit?: ConsumptionLimits;
  limitPeriod?: 'EPOCH' | 'MONTH' | 'LIFETIME';
}): Promise<ApiKeyMetadata & { apiKey: string }> {
  // Fail here, before anything is sent, so later failures can mean a key exists.
  requireApiKey();

  let response: unknown;
  try {
    response = await apiRequest<unknown>('/api_keys', {
      method: 'POST',
      body: input,
      spinnerText: 'Creating API key...',
      retries: 0,
    });
  } catch (error) {
    if (wasRefused(error)) throw error;
    // apiRequest errors never quote a successful response, which would hold the secret.
    throw new ApiKeyCreationError(error instanceof Error ? error.message : String(error));
  }

  const created = (response as { data?: unknown } | null)?.data;
  const { id, apiKey } = (created ?? {}) as { id?: unknown; apiKey?: unknown };
  if (typeof id !== 'string' || !API_KEY_ID_PATTERN.test(id)) {
    throw new ApiKeyCreationError('Venice did not return a valid ID for the new API key');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ApiKeyCreationError('Venice did not return the secret for the new API key', id);
  }
  return created as ApiKeyMetadata & { apiKey: string };
}

// apiRequest reports a 401 as a plain Error without the status code.
function wasRefused(error: unknown): boolean {
  if (error instanceof VeniceApiError) {
    return error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500;
  }
  return error instanceof Error && error.message.startsWith('Authentication failed');
}

export async function deleteApiKey(id: string): Promise<void> {
  assertApiKeyId(id);
  const params = new URLSearchParams({ id });
  const response = await apiRequest<{ success: boolean }>(`/api_keys?${params.toString()}`, {
    method: 'DELETE',
    spinnerText: 'Deleting API key...',
    retries: 0,
  });
  if (!response.success) {
    throw new Error('Venice did not confirm API key deletion.');
  }
}

export async function getApiKeyRateLimits(): Promise<ApiKeyRateLimits> {
  const response = await apiRequest<{ data: ApiKeyRateLimits }>('/api_keys/rate_limits', {
    spinnerText: 'Fetching rate limits...',
  });
  return response.data;
}

export async function getApiKey(id: string): Promise<ApiKeyMetadata> {
  assertApiKeyId(id);
  const response = await apiRequest<{ data: ApiKeyMetadata }>(
    `/api_keys/${encodeURIComponent(id)}`,
    { spinnerText: 'Fetching API key...' }
  );
  return response?.data;
}

// Experimental endpoint: the last 50 rate limits the account exceeded.
export async function getApiKeyRateLimitLogs(): Promise<ApiKeyRateLimitLogEntry[]> {
  const response = await apiRequest<{ data: ApiKeyRateLimitLogEntry[] }>('/api_keys/rate_limits/log', {
    spinnerText: 'Fetching rate limit logs...',
  });
  return response?.data;
}
