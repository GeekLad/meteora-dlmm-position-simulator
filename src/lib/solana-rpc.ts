/**
 * Shared Solana JSON-RPC helpers for browser use.
 *
 * Resilient fetching:
 * - Tries multiple endpoints
 * - Global rate limit across all callers
 * - Per-endpoint cooldown after 429 / 415 / 5xx
 * - Exponential backoff retries for transient failures
 * - CORS-safe fetch (some public RPCs reject content-type / solana-client)
 */

import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';

const BUILTIN_RPC_URLS = [
  // Archive-capable; works from Node and often from browsers (CORS *).
  'https://solana.leorpc.com/?api_key=FREE',
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

/** Minimum gap between any two RPC HTTP calls (shared queue). */
const GLOBAL_MIN_INTERVAL_MS = 350;
/** Extra pause after a 429 before that endpoint is tried again. */
const RATE_LIMIT_COOLDOWN_MS = 8_000;
/** Cooldown for hard rejects (415 Unsupported Media Type, etc.). */
const HARD_REJECT_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS_PER_URL = 3;
const DEFAULT_GAP_MS = 350;

type EndpointState = {
  cooldownUntil: number;
  consecutiveFailures: number;
};

const endpointState = new Map<string, EndpointState>();
let nextSlotAt = 0;
let queue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function configuredRpcUrls(): string[] {
  const urls: string[] = [];
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_SOLANA_RPC_URL) {
    urls.push(process.env.NEXT_PUBLIC_SOLANA_RPC_URL);
  }
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem('solanaRpcUrl');
      if (stored && stored.trim()) urls.push(stored.trim());
    } catch {
      // ignore storage access errors
    }
  }
  for (const url of BUILTIN_RPC_URLS) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function getState(url: string): EndpointState {
  let state = endpointState.get(url);
  if (!state) {
    state = { cooldownUntil: 0, consecutiveFailures: 0 };
    endpointState.set(url, state);
  }
  return state;
}

function markSuccess(url: string): void {
  const state = getState(url);
  state.cooldownUntil = 0;
  state.consecutiveFailures = 0;
}

function markFailure(url: string, status?: number, message?: string): void {
  const state = getState(url);
  state.consecutiveFailures += 1;
  const now = Date.now();
  const text = `${status ?? ''} ${message ?? ''}`.toLowerCase();
  const rateLimited =
    status === 429
    || text.includes('429')
    || text.includes('too many')
    || text.includes('rate limit');
  const hardReject =
    status === 415
    || status === 401
    || status === 403
    || text.includes('access forbidden')
    || text.includes('unsupported media');

  if (rateLimited) {
    const backoff = RATE_LIMIT_COOLDOWN_MS * Math.min(4, state.consecutiveFailures);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + backoff);
  } else if (hardReject) {
    state.cooldownUntil = Math.max(state.cooldownUntil, now + HARD_REJECT_COOLDOWN_MS);
  } else if (status && status >= 500) {
    state.cooldownUntil = Math.max(state.cooldownUntil, now + 2_000 * state.consecutiveFailures);
  }
}

function urlsInPreferenceOrder(): string[] {
  const now = Date.now();
  return configuredRpcUrls()
    .map((url, index) => {
      const state = getState(url);
      const cooling = state.cooldownUntil > now;
      return { url, index, cooling, cooldownUntil: state.cooldownUntil, failures: state.consecutiveFailures };
    })
    .sort((a, b) => {
      if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
      if (a.failures !== b.failures) return a.failures - b.failures;
      return a.index - b.index;
    })
    .map(entry => entry.url);
}

/**
 * Serialize RPC traffic so free public endpoints are not stampeded when
 * loading many historical signatures.
 */
async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, nextSlotAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextSlotAt = Date.now() + GLOBAL_MIN_INTERVAL_MS;
    return fn();
  });
  // Keep the queue alive even when a call fails.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function isRetriableError(status?: number, message?: string): boolean {
  if (status === 429 || status === 408 || status === 425) return true;
  if (status != null && status >= 500) return true;
  const text = (message ?? '').toLowerCase();
  return (
    text.includes('429')
    || text.includes('too many')
    || text.includes('rate limit')
    || text.includes('timeout')
    || text.includes('fetch failed')
    || text.includes('network')
    || text.includes('failed to fetch')
  );
}

function backoffMs(attempt: number): number {
  // 500ms, 1.5s, 3.5s (+ jitter)
  const base = 500 * Math.pow(2, attempt) - (attempt === 0 ? 0 : 100);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Some public RPCs advertise Access-Control-Allow-Origin: * but omit
 * Access-Control-Allow-Headers for `content-type` / `solana-client`.
 * Prefer omitting those headers; retry with JSON content-type if we get 415.
 */
function buildCorsSafeFetch(forceJsonContentType: boolean) {
  return function corsSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers ?? undefined);
    headers.delete('solana-client');
    headers.delete('Solana-Client');
    if (forceJsonContentType) {
      headers.set('content-type', 'application/json');
    } else if (headers.get('content-type')?.includes('application/json')) {
      headers.delete('content-type');
    }
    return fetch(input, { ...init, headers });
  };
}

async function fetchJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  forceJsonContentType = false
): Promise<{ ok: true; result: T } | { ok: false; status?: number; message: string }> {
  try {
    const response = await buildCorsSafeFetch(forceJsonContentType)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, message: `RPC ${response.status}` };
    }
    const json = await response.json() as { result?: T; error?: { message?: string; code?: number } };
    if (json.error) {
      const message = json.error.message || 'RPC error';
      const status =
        json.error.code === 429 || /too many|rate limit/i.test(message)
          ? 429
          : undefined;
      return { ok: false, status, message };
    }
    return { ok: true, result: json.result as T };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'RPC failed',
    };
  }
}

export async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  const urls = urlsInPreferenceOrder();

  for (const url of urls) {
    const state = getState(url);
    const waitCooldown = Math.max(0, state.cooldownUntil - Date.now());
    if (waitCooldown > 30_000) {
      // Skip endpoints in a long hard-reject cooldown; try others first.
      continue;
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_URL; attempt++) {
      if (waitCooldown > 0 && attempt === 0) {
        await sleep(Math.min(waitCooldown, RATE_LIMIT_COOLDOWN_MS));
      } else if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
      }

      const outcome = await withRateLimit(() => fetchJsonRpc<T>(url, method, params, false));
      if (outcome.ok) {
        markSuccess(url);
        return outcome.result;
      }

      // 415: retry once with explicit JSON content-type on this endpoint.
      if (outcome.status === 415) {
        const retry = await withRateLimit(() => fetchJsonRpc<T>(url, method, params, true));
        if (retry.ok) {
          markSuccess(url);
          return retry.result;
        }
        markFailure(url, retry.status ?? 415, retry.message);
        lastError = new Error(retry.message);
        break;
      }

      markFailure(url, outcome.status, outcome.message);
      lastError = new Error(outcome.message);
      if (!isRetriableError(outcome.status, outcome.message)) break;
    }
  }

  throw lastError ?? new Error('RPC unavailable');
}

/**
 * Fetch a parsed transaction via @solana/web3.js so account keys are PublicKey
 * instances (required by `@geeklad/meteora-dlmm-liquidity-tx-parser`).
 * Retries with backoff and rotates endpoints on rate limits / transient errors.
 */
export async function getParsedTransaction(
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  let lastError: Error | null = null;
  let sawNullResult = false;
  const urls = urlsInPreferenceOrder();

  for (const url of urls) {
    const state = getState(url);
    if (state.cooldownUntil - Date.now() > 30_000) continue;

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_URL; attempt++) {
      const cooldownWait = Math.max(0, state.cooldownUntil - Date.now());
      if (cooldownWait > 0 && attempt === 0) {
        await sleep(Math.min(cooldownWait, RATE_LIMIT_COOLDOWN_MS));
      } else if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
      }

      try {
        const forceJson = attempt > 0 && /415|unsupported media/i.test(lastError?.message ?? '');
        const tx = await withRateLimit(async () => {
          const connection = new Connection(url, {
            commitment: 'confirmed',
            disableRetryOnRateLimit: true,
            fetch: buildCorsSafeFetch(forceJson),
            httpHeaders: {},
          });
          return connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
        });
        markSuccess(url);
        if (tx != null) return tx;
        sawNullResult = true;
        // Null usually means pruned history on this node — try the next URL.
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'RPC failed';
        const statusMatch = message.match(/\b(429|415|403|401|5\d\d)\b/);
        const status = statusMatch ? Number(statusMatch[1]) : undefined;
        markFailure(url, status, message);
        lastError = error instanceof Error ? error : new Error(message);
        if (!isRetriableError(status, message)) break;
      }
    }
  }

  if (sawNullResult) return null;
  if (lastError) throw lastError;
  return null;
}

export async function mapWithThrottle<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  gapMs = DEFAULT_GAP_MS
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    results.push(await mapper(items[i], i));
  }
  return results;
}

/** Test helper / UI: clear endpoint cooldowns after user provides a new RPC URL. */
export function resetRpcEndpointState(): void {
  endpointState.clear();
  nextSlotAt = 0;
}
