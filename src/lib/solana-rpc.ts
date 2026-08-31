/**
 * Shared Solana JSON-RPC helpers for browser use.
 * Tries multiple public endpoints; historical getParsedTransaction often needs
 * mainnet-beta (or another archive-capable RPC) when publicnode returns null.
 */

import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';

const BUILTIN_RPC_URLS = [
  // Archive-capable; works from Node and often from browsers (CORS *).
  'https://solana.leorpc.com/?api_key=FREE',
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

const DEFAULT_GAP_MS = 80;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Some public RPCs advertise Access-Control-Allow-Origin: * but omit
 * Access-Control-Allow-Headers for `content-type` / `solana-client`. Strip
 * those so browser preflight succeeds (body is still JSON).
 */
function corsSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined);
  headers.delete('solana-client');
  headers.delete('Solana-Client');
  // Avoid triggering a CORS preflight disallow on content-type for picky RPCs.
  if (headers.get('content-type')?.includes('application/json')) {
    headers.delete('content-type');
  }
  return fetch(input, { ...init, headers });
}

export async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (const url of configuredRpcUrls()) {
    try {
      const response = await corsSafeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!response.ok) {
        lastError = new Error(`RPC ${response.status}`);
        continue;
      }
      const json = await response.json() as { result?: T; error?: { message?: string } };
      if (json.error) {
        lastError = new Error(json.error.message || 'RPC error');
        continue;
      }
      return json.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('RPC failed');
    }
  }
  throw lastError ?? new Error('RPC unavailable');
}

/**
 * Fetch a parsed transaction via @solana/web3.js so account keys are PublicKey
 * instances (required by `@geeklad/meteora-dlmm-liquidity-tx-parser`).
 * Tries each RPC until one returns a non-null result.
 */
export async function getParsedTransaction(
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  let sawSuccess = false;
  let lastError: Error | null = null;
  for (const url of configuredRpcUrls()) {
    try {
      const connection = new Connection(url, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: corsSafeFetch,
        httpHeaders: {},
      });
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      sawSuccess = true;
      if (tx != null) return tx;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('RPC failed');
    }
  }
  if (!sawSuccess && lastError) throw lastError;
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
