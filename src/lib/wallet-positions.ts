/**
 * Wallet DLMM position loading
 *
 * Uses Meteora's public Data API (no RPC) to fetch a wallet's open positions,
 * group them by trading pair, then by pool, and reconstruct bin liquidity
 * for combined price simulation.
 */

import {
  getInitialBinsForBinRange,
  mergeSimulatedBins,
  type SimulatedBin,
  type Strategy,
} from './dlmm';
import { fetchPoolByAddress, type MeteoraPair } from './meteora-api';
import { toSimulatorBinId } from './dlmm-sdk-wrapper';

const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';
const REQUEST_GAP_MS = 40;

export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
}

export function shortenAddress(address: string, chars = 4): string {
  const trimmed = address.trim();
  if (trimmed.length <= chars * 2 + 3) return trimmed;
  return `${trimmed.slice(0, chars)}…${trimmed.slice(-chars)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function pick<T>(obj: Record<string, unknown> | null | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key] as T;
    }
  }
  return undefined;
}

function tokenAmount(container: unknown): number {
  if (!container || typeof container !== 'object') return 0;
  const rec = container as Record<string, unknown>;
  return num(pick(rec, 'amount', 'Amount'));
}

export interface WalletPoolSummary {
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXIcon: string;
  tokenYIcon: string;
  binStep: number;
  baseFee: number;
  poolPrice: number;
  listPositions: string[];
  openPositionCount: number;
  balancesUsd: number;
  pnlUsd: number;
  pnlPctChange: number;
  unclaimedFeesUsd: number;
  totalDepositUsd: number;
  outOfRange: boolean;
  positionsOutOfRange: string[];
}

export interface WalletPositionDetail {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  minPrice: number;
  maxPrice: number;
  poolActiveBinId: number;
  poolActivePrice: number;
  isOutOfRange: boolean;
  createdAt: number | null;
  baseAmount: number;
  quoteAmount: number;
  valueUsd: number;
  pnlUsd: number;
  pnlPctChange: number;
  unclaimedFeesUsd: number;
}

export interface PairGroup {
  pairKey: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXIcon: string;
  tokenYIcon: string;
  poolCount: number;
  positionCount: number;
  balancesUsd: number;
  pnlUsd: number;
  unclaimedFeesUsd: number;
  pools: WalletPoolSummary[];
}

export interface OpenPortfolio {
  wallet: string;
  totalPositions: number;
  totalBalancesUsd: number;
  totalPnlUsd: number;
  pairs: PairGroup[];
}

export interface LoadedPoolSimulation {
  pool: MeteoraPair;
  summary: WalletPoolSummary;
  positions: WalletPositionDetail[];
  bins: SimulatedBin[];
  combinedBaseAmount: number;
  combinedQuoteAmount: number;
  combinedLowerPrice: number;
  combinedUpperPrice: number;
  activePrice: number;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Meteora API ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function normalizePool(raw: Record<string, unknown>): WalletPoolSummary {
  const listPositions = (pick<string[]>(raw, 'listPositions', 'list_positions') ?? []).filter(Boolean);
  const positionsOutOfRange = (pick<string[]>(raw, 'positionsOutOfRange', 'positions_out_of_range') ?? []).filter(Boolean);
  const tokenX = str(pick(raw, 'tokenX', 'token_x'), 'TOKEN');
  const tokenY = str(pick(raw, 'tokenY', 'token_y'), 'TOKEN');

  return {
    poolAddress: str(pick(raw, 'poolAddress', 'pool_address')),
    tokenX,
    tokenY,
    tokenXMint: str(pick(raw, 'tokenXMint', 'token_x_mint')),
    tokenYMint: str(pick(raw, 'tokenYMint', 'token_y_mint')),
    tokenXIcon: str(pick(raw, 'tokenXIcon', 'token_x_icon')),
    tokenYIcon: str(pick(raw, 'tokenYIcon', 'token_y_icon')),
    binStep: num(pick(raw, 'binStep', 'bin_step')),
    baseFee: num(pick(raw, 'baseFee', 'base_fee')),
    poolPrice: num(pick(raw, 'poolPrice', 'pool_price', 'currentPrice', 'current_price')),
    listPositions,
    openPositionCount: num(pick(raw, 'openPositionCount', 'open_position_count'), listPositions.length),
    balancesUsd: num(pick(raw, 'balances')),
    pnlUsd: num(pick(raw, 'pnl')),
    pnlPctChange: num(pick(raw, 'pnlPctChange', 'pnl_pct_change')),
    unclaimedFeesUsd: num(pick(raw, 'unclaimedFees', 'unclaimed_fees')),
    totalDepositUsd: num(pick(raw, 'totalDeposit', 'total_deposit')),
    outOfRange: Boolean(pick(raw, 'outOfRange', 'out_of_range')),
    positionsOutOfRange,
  };
}

function pairKeyFor(tokenX: string, tokenY: string): string {
  return `${tokenX}-${tokenY}`;
}

export function groupPoolsByPair(pools: WalletPoolSummary[]): PairGroup[] {
  const groups = new Map<string, PairGroup>();

  for (const pool of pools) {
    const pairKey = pairKeyFor(pool.tokenX, pool.tokenY);
    let group = groups.get(pairKey);
    if (!group) {
      group = {
        pairKey,
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        tokenXMint: pool.tokenXMint,
        tokenYMint: pool.tokenYMint,
        tokenXIcon: pool.tokenXIcon,
        tokenYIcon: pool.tokenYIcon,
        poolCount: 0,
        positionCount: 0,
        balancesUsd: 0,
        pnlUsd: 0,
        unclaimedFeesUsd: 0,
        pools: [],
      };
      groups.set(pairKey, group);
    }

    group.pools.push(pool);
    group.poolCount += 1;
    group.positionCount += pool.openPositionCount || pool.listPositions.length;
    group.balancesUsd += pool.balancesUsd;
    group.pnlUsd += pool.pnlUsd;
    group.unclaimedFeesUsd += pool.unclaimedFeesUsd;
    if (!group.tokenXIcon && pool.tokenXIcon) group.tokenXIcon = pool.tokenXIcon;
    if (!group.tokenYIcon && pool.tokenYIcon) group.tokenYIcon = pool.tokenYIcon;
  }

  for (const group of groups.values()) {
    group.pools.sort((a, b) => b.balancesUsd - a.balancesUsd);
  }

  return Array.from(groups.values()).sort((a, b) => b.balancesUsd - a.balancesUsd);
}

export async function fetchOpenPortfolio(wallet: string): Promise<OpenPortfolio> {
  const trimmed = wallet.trim();
  const pools: WalletPoolSummary[] = [];
  let page = 1;
  let totalPositions = 0;
  let hasNext = true;

  while (hasNext) {
    const url = new URL('/portfolio/open', METEORA_API_BASE);
    url.searchParams.set('user', trimmed);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '50');
    url.searchParams.set('sort_by', 'current_balances');
    url.searchParams.set('sort_direction', 'desc');

    const data = await fetchJson<Record<string, unknown>>(url.toString());
    const rawPools = (pick<Record<string, unknown>[]>(data, 'pools') ?? []);
    pools.push(...rawPools.map(normalizePool).filter(p => p.poolAddress));
    totalPositions = num(pick(data, 'totalPositions', 'total_positions'), totalPositions);
    const reportedHasNext = pick<boolean>(data, 'hasNext', 'has_next');
    hasNext = reportedHasNext ?? rawPools.length >= 50;
    page += 1;
    if (page > 40) break;
    if (hasNext) await sleep(REQUEST_GAP_MS);
  }

  const pairs = groupPoolsByPair(pools);
  const totalBalancesUsd = pairs.reduce((sum, pair) => sum + pair.balancesUsd, 0);
  const totalPnlUsd = pairs.reduce((sum, pair) => sum + pair.pnlUsd, 0);

  return {
    wallet: trimmed,
    totalPositions: totalPositions || pairs.reduce((sum, pair) => sum + pair.positionCount, 0),
    totalBalancesUsd,
    totalPnlUsd,
    pairs,
  };
}

function normalizePosition(raw: Record<string, unknown>): WalletPositionDetail | null {
  const positionAddress = str(pick(raw, 'positionAddress', 'position_address'));
  if (!positionAddress) return null;

  const unrealized = (pick<Record<string, unknown>>(raw, 'unrealizedPnl', 'unrealized_pnl') ?? {}) as Record<string, unknown>;
  const feeXUsd = num(
    pick(
      (pick<Record<string, unknown>>(unrealized, 'unclaimedFeeTokenX', 'unclaimed_fee_token_x') ?? {}) as Record<string, unknown>,
      'usd'
    )
  );
  const feeYUsd = num(
    pick(
      (pick<Record<string, unknown>>(unrealized, 'unclaimedFeeTokenY', 'unclaimed_fee_token_y') ?? {}) as Record<string, unknown>,
      'usd'
    )
  );

  const isClosed = Boolean(pick(raw, 'isClosed', 'is_closed'));
  if (isClosed) return null;

  // Data API returns on-chain bin IDs (bin 0 = price 1.0 in lamports).
  // The simulator's price helpers use bin 262144 as that reference.
  return {
    positionAddress,
    lowerBinId: toSimulatorBinId(num(pick(raw, 'lowerBinId', 'lower_bin_id'))),
    upperBinId: toSimulatorBinId(num(pick(raw, 'upperBinId', 'upper_bin_id'))),
    minPrice: num(pick(raw, 'minPrice', 'min_price')),
    maxPrice: num(pick(raw, 'maxPrice', 'max_price')),
    poolActiveBinId: toSimulatorBinId(num(pick(raw, 'poolActiveBinId', 'pool_active_bin_id'))),
    poolActivePrice: num(pick(raw, 'poolActivePrice', 'pool_active_price')),
    isOutOfRange: Boolean(pick(raw, 'isOutOfRange', 'is_out_of_range')),
    createdAt: num(pick(raw, 'createdAt', 'created_at')) || null,
    baseAmount: tokenAmount(pick(unrealized, 'balanceTokenX', 'balance_token_x')),
    quoteAmount: tokenAmount(pick(unrealized, 'balanceTokenY', 'balance_token_y')),
    valueUsd: num(pick(unrealized, 'balances', 'balancesUsd', 'balances_usd')),
    pnlUsd: num(pick(raw, 'pnlUsd', 'pnl_usd', 'pnl')),
    pnlPctChange: num(pick(raw, 'pnlPctChange', 'pnl_pct_change')),
    unclaimedFeesUsd: feeXUsd + feeYUsd,
  };
}

export async function fetchPoolPositions(
  poolAddress: string,
  wallet: string
): Promise<WalletPositionDetail[]> {
  const positions: WalletPositionDetail[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = new URL(`/positions/${poolAddress}/pnl`, METEORA_API_BASE);
    url.searchParams.set('user', wallet.trim());
    url.searchParams.set('status', 'open');
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '100');

    const data = await fetchJson<Record<string, unknown>>(url.toString());
    const rawPositions = pick<Record<string, unknown>[]>(data, 'positions') ?? [];
    for (const raw of rawPositions) {
      const parsed = normalizePosition(raw);
      if (parsed) {
        positions.push(parsed);
      }
    }
    const reportedHasNext = pick<boolean>(data, 'hasNext', 'has_next');
    hasNext = reportedHasNext ?? rawPositions.length >= 100;
    page += 1;
    if (page > 20) break;
    if (hasNext) await sleep(REQUEST_GAP_MS);
  }

  return positions.sort((a, b) => b.valueUsd - a.valueUsd);
}

export function reconstructCombinedBins(options: {
  positions: WalletPositionDetail[];
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  fallbackActiveBinId: number;
  strategy?: Strategy;
}): SimulatedBin[] {
  const {
    positions,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    fallbackActiveBinId,
    strategy = 'spot',
  } = options;

  const perPosition = positions
    .filter(position => {
      const hasRange = Number.isFinite(position.lowerBinId)
        && Number.isFinite(position.upperBinId)
        && position.upperBinId >= position.lowerBinId;
      const hasLiquidity = position.baseAmount > 0 || position.quoteAmount > 0;
      return hasRange && hasLiquidity;
    })
    .map(position =>
      getInitialBinsForBinRange({
        binStep,
        minBinId: position.lowerBinId,
        maxBinId: position.upperBinId,
        activeBinId: position.poolActiveBinId || fallbackActiveBinId,
        baseAmount: position.baseAmount,
        quoteAmount: position.quoteAmount,
        strategy,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment,
      })
    )
    .filter(bins => bins.length > 0);

  const activeBinId = positions.find(p => p.poolActiveBinId)?.poolActiveBinId ?? fallbackActiveBinId;

  return mergeSimulatedBins(perPosition, {
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    activeBinId,
    fillGaps: true,
  });
}

export async function loadPoolSimulation(options: {
  wallet: string;
  summary: WalletPoolSummary;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
}): Promise<LoadedPoolSimulation> {
  const { wallet, summary, baseDecimals, quoteDecimals, applyDecimalAdjustment } = options;

  const [pool, positions] = await Promise.all([
    fetchPoolByAddress(summary.poolAddress),
    fetchPoolPositions(summary.poolAddress, wallet),
  ]);

  if (!pool) {
    throw new Error('Could not load pool metadata');
  }

  const activeBinId =
    positions.find(p => p.poolActiveBinId)?.poolActiveBinId ??
    0;
  const fallbackActive = activeBinId || 0;

  const bins = reconstructCombinedBins({
    positions,
    binStep: pool.bin_step || summary.binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    fallbackActiveBinId: fallbackActive,
  });

  const combinedBaseAmount = positions.reduce((sum, p) => sum + p.baseAmount, 0);
  const combinedQuoteAmount = positions.reduce((sum, p) => sum + p.quoteAmount, 0);
  const minBinId = positions.length ? Math.min(...positions.map(p => p.lowerBinId)) : 0;
  const maxBinId = positions.length ? Math.max(...positions.map(p => p.upperBinId)) : 0;
  const combinedLowerPrice = bins.length ? bins[0].price : 0;
  const combinedUpperPrice = bins.length ? bins[bins.length - 1].price : 0;
  const activePrice =
    positions.find(p => p.poolActivePrice)?.poolActivePrice ||
    pool.current_price ||
    summary.poolPrice;

  return {
    pool,
    summary,
    positions,
    bins,
    combinedBaseAmount,
    combinedQuoteAmount,
    combinedLowerPrice,
    combinedUpperPrice,
    activePrice,
    minBinId,
    maxBinId,
    activeBinId: fallbackActive,
  };
}
