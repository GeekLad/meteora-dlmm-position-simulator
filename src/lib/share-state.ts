import type { Strategy } from './dlmm';
import { newTxId, type SimulatedTransaction, type SimulatedTxType } from './position-transactions';

export interface ShareSnapshot {
  pool: string | null;
  wallet: string | null;
  currentPrice: number | null;
  initialPrice: number | null;
  transactions: SimulatedTransaction[];
}

export interface ShareInput {
  poolAddress?: string | null;
  wallet?: string | null;
  currentPrice: number | '';
  initialPrice: number | '';
  transactions?: SimulatedTransaction[];
}

const STRATEGIES: ReadonlySet<string> = new Set(['spot', 'bid-ask', 'curve']);

const TX_TYPE_TO_CODE: Record<SimulatedTxType, string> = {
  'add-position': 'p',
  'add-liquidity': 'a',
  'remove-liquidity': 'r',
};

const TX_CODE_TO_TYPE: Record<string, SimulatedTxType> = {
  p: 'add-position',
  a: 'add-liquidity',
  r: 'remove-liquidity',
};

interface CompactTx {
  t: string;
  a: string;
  p: number;
  s?: string;
  b?: number;
  q?: number;
  l?: number;
  u?: number;
  r?: number;
  i?: string;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function compactNumber(value: number): number | undefined {
  return Number.isFinite(value) && value !== 0 ? value : undefined;
}

function parseStrategy(value: unknown): Strategy {
  return typeof value === 'string' && STRATEGIES.has(value) ? (value as Strategy) : 'spot';
}

function toCompactTx(tx: SimulatedTransaction): CompactTx {
  const compact: CompactTx = {
    t: TX_TYPE_TO_CODE[tx.type] ?? 'p',
    a: tx.positionAddress,
    p: tx.price,
  };
  if (tx.strategy && tx.strategy !== 'spot') compact.s = tx.strategy;
  const base = compactNumber(tx.baseAmount);
  if (base != null) compact.b = base;
  const quote = compactNumber(tx.quoteAmount);
  if (quote != null) compact.q = quote;
  const lower = compactNumber(tx.lowerPrice);
  if (lower != null) compact.l = lower;
  const upper = compactNumber(tx.upperPrice);
  if (upper != null) compact.u = upper;
  if (tx.removeBps) compact.r = tx.removeBps;
  if (tx.id) compact.i = tx.id;
  return compact;
}

function fromCompactTx(raw: unknown, index: number): SimulatedTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as CompactTx;
  const type = TX_CODE_TO_TYPE[item.t];
  if (!type) return null;
  const address = typeof item.a === 'string' ? item.a.trim() : '';
  if (!address) return null;
  const price = positiveNumber(item.p);
  if (price == null) return null;

  return {
    id: typeof item.i === 'string' && item.i ? item.i : `tx-share-${index}-${newTxId()}`,
    type,
    price,
    strategy: parseStrategy(item.s),
    baseAmount: finiteNumber(item.b) ?? 0,
    quoteAmount: finiteNumber(item.q) ?? 0,
    lowerPrice: finiteNumber(item.l) ?? 0,
    upperPrice: finiteNumber(item.u) ?? 0,
    positionAddress: address,
    removeBps: Math.max(0, finiteNumber(item.r) ?? 0),
  };
}

function encodeTransactions(transactions: SimulatedTransaction[]): string | null {
  if (!transactions.length) return null;
  try {
    return JSON.stringify(transactions.map(toCompactTx));
  } catch {
    return null;
  }
}

function decodeTransactions(raw: string | null): SimulatedTransaction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => fromCompactTx(item, index))
      .filter((tx): tx is SimulatedTransaction => tx != null);
  } catch {
    return [];
  }
}

export function parseShareSearchParams(searchParams: { get(name: string): string | null }): ShareSnapshot {
  const pool = searchParams.get('pool')?.trim() || null;
  const wallet = searchParams.get('wallet')?.trim() || null;
  return {
    pool,
    wallet,
    currentPrice: positiveNumber(searchParams.get('currentPrice')),
    initialPrice: positiveNumber(searchParams.get('initialPrice')),
    transactions: decodeTransactions(searchParams.get('txs')),
  };
}

export function buildShareSearchParams(input: ShareInput): URLSearchParams {
  const searchParams = new URLSearchParams();
  const pool = input.poolAddress?.trim();
  if (pool) searchParams.set('pool', pool);

  const wallet = input.wallet?.trim();
  if (wallet) searchParams.set('wallet', wallet);

  if (typeof input.initialPrice === 'number' && input.initialPrice > 0) {
    searchParams.set('initialPrice', String(input.initialPrice));
  }

  if (
    typeof input.currentPrice === 'number'
    && input.currentPrice > 0
    && input.currentPrice !== input.initialPrice
  ) {
    searchParams.set('currentPrice', String(input.currentPrice));
  }

  const txs = encodeTransactions(input.transactions ?? []);
  if (txs) searchParams.set('txs', txs);

  return searchParams;
}

export function buildShareUrl(baseUrl: string, input: ShareInput): string {
  const query = buildShareSearchParams(input).toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

export function hasShareOverlay(share: ShareSnapshot): boolean {
  return share.transactions.length > 0 || share.currentPrice != null || share.initialPrice != null;
}

export function hasShareTarget(share: ShareSnapshot): boolean {
  return !!(share.pool || share.wallet);
}
