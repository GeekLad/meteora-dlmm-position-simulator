/**
 * Load and stack historical DLMM liquidity txs for open positions.
 *
 * Discovery: Meteora Data API `/positions/{address}/historical`
 * Detail: Solana RPC + `@geeklad/meteora-dlmm-liquidity-tx-parser`
 */

import type { DlmmInstruction, DlmmStrategy } from '@geeklad/meteora-dlmm-liquidity-tx-parser';
import { getPriceFromId, type SimulatedBin, type Strategy } from './dlmm';
import { toSimulatorBinId } from './dlmm-sdk-wrapper';
import {
  analyzeCurrentBins,
  binsToAmounts,
  cloneBins,
  combineSliceBins,
  costBasis,
  replayTransactions,
  simulateSlices,
  slicesCostBasis,
  type LiquiditySlice,
  type ReplayOptions,
  type SimulatedTransaction,
} from './position-transactions';
import { getParsedTransaction, mapWithThrottle } from './solana-rpc';

const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';
const REQUEST_GAP_MS = 40;
const RPC_GAP_MS = 120;
const SHAPE_ABS_TOLERANCE = 1e-6;
const SHAPE_REL_TOLERANCE = 0.02;

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

export interface MeteoraPositionEvent {
  signature: string;
  ixIndex: number;
  eventType: string;
  positionAddress: string;
  blockTime: number;
  slot: number;
  poolAddress: string;
  userAddress: string;
  tokenX: string;
  tokenY: string;
  amountX: number;
  amountY: number;
  amountXUsd: number;
  amountYUsd: number;
  totalUsd: number;
  createdAt: string;
}

export interface PositionHistoryEvent {
  signature: string;
  slot: number;
  timestamp: Date;
  positionAddress: string;
  poolAddress: string;
  instruction: DlmmInstruction;
  api?: MeteoraPositionEvent;
}

export interface ClaimedFeesSummary {
  base: number;
  quote: number;
  usd: number;
}

export interface ShapeValidation {
  ok: boolean;
  /** Totals (base/quote inventory) within tolerance. */
  totalsOk: boolean;
  maxAbsDiffBase: number;
  maxAbsDiffQuote: number;
  stackedBase: number;
  stackedQuote: number;
  onChainBase: number;
  onChainQuote: number;
  message: string;
}

export interface LoadedPositionHistory {
  events: PositionHistoryEvent[];
  eventsByPosition: Record<string, PositionHistoryEvent[]>;
  /** Chronological liquidity txs used for stacking (claims excluded). */
  stackedTxs: SimulatedTransaction[];
  historicalSlices: LiquiditySlice[];
  positionBins: Record<string, SimulatedBin[]>;
  combinedBins: SimulatedBin[];
  initialPrice: number;
  initialActiveBinId: number;
  claimedFees: ClaimedFeesSummary;
  shapeValidation: ShapeValidation;
  /**
   * True when strategy replay totals matched on-chain but per-bin weights did not,
   * so the live share shape was used with historical cost basis applied.
   */
  reconciledToOnChain: boolean;
  parseErrors: string[];
  missingSignatures: string[];
}

export interface HistoryLoadOptions {
  positionAddresses: string[];
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  /** Simulator-space active bin id (already offset). */
  currentActiveBinId: number;
  currentPrice: number;
  /** On-chain bins by position for validation (simulator space). */
  onChainByPosition?: Record<string, SimulatedBin[]>;
  onChainCombined?: SimulatedBin[];
}

function normalizeApiEvent(raw: Record<string, unknown>): MeteoraPositionEvent | null {
  const signature = str(raw.signature);
  const positionAddress = str(raw.positionAddress ?? raw.position_address);
  if (!signature || !positionAddress) return null;
  return {
    signature,
    ixIndex: num(raw.ixIndex ?? raw.ix_index),
    eventType: str(raw.eventType ?? raw.event_type),
    positionAddress,
    blockTime: num(raw.blockTime ?? raw.block_time),
    slot: num(raw.slot),
    poolAddress: str(raw.poolAddress ?? raw.pool_address),
    userAddress: str(raw.userAddress ?? raw.user_address),
    tokenX: str(raw.tokenX ?? raw.token_x),
    tokenY: str(raw.tokenY ?? raw.token_y),
    amountX: num(raw.amountX ?? raw.amount_x),
    amountY: num(raw.amountY ?? raw.amount_y),
    amountXUsd: num(raw.amountXUsd ?? raw.amount_x_usd),
    amountYUsd: num(raw.amountYUsd ?? raw.amount_y_usd),
    totalUsd: num(raw.totalUsd ?? raw.total_usd),
    createdAt: str(raw.createdAt ?? raw.created_at),
  };
}

export async function fetchPositionHistoricalEvents(
  positionAddress: string
): Promise<MeteoraPositionEvent[]> {
  const url = new URL(`/positions/${positionAddress}/historical`, METEORA_API_BASE);
  url.searchParams.set('order_direction', 'asc');
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Meteora historical API ${response.status}: ${response.statusText}`);
  }
  const data = await response.json() as { events?: Record<string, unknown>[] };
  return (data.events ?? [])
    .map(normalizeApiEvent)
    .filter((event): event is MeteoraPositionEvent => event != null);
}

async function loadParseMeteoraTransaction() {
  const mod = await import('@geeklad/meteora-dlmm-liquidity-tx-parser');
  return mod.parseMeteoraTransaction;
}

function strategyFromParser(strategy: DlmmStrategy | undefined): Strategy {
  if (strategy === 'Curve') return 'curve';
  if (strategy === 'BidAsk') return 'bid-ask';
  return 'spot';
}

function rawToUi(amount: number | undefined, decimals: number): number {
  if (!(amount != null) || !Number.isFinite(amount)) return 0;
  return amount / Math.pow(10, decimals);
}

function instructionOrder(type: string): number {
  switch (type) {
    case 'CreatePosition': return 0;
    case 'AddLiquidity': return 1;
    case 'RemoveLiquidity': return 2;
    case 'ClaimFees': return 3;
    case 'ClaimRewards': return 4;
    case 'ClosePosition': return 5;
    default: return 9;
  }
}

function sortHistoryEvents(events: PositionHistoryEvent[]): PositionHistoryEvent[] {
  return [...events].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    if (a.signature !== b.signature) return a.signature.localeCompare(b.signature);
    const order = instructionOrder(a.instruction.type) - instructionOrder(b.instruction.type);
    if (order !== 0) return order;
    return a.timestamp.getTime() - b.timestamp.getTime();
  });
}

/**
 * Fetch API history for each position, parse unique signatures via RPC + parser,
 * and return chronologically ordered position-scoped instructions.
 */
export async function fetchParsedPositionHistory(
  positionAddresses: string[]
): Promise<{
  events: PositionHistoryEvent[];
  eventsByPosition: Record<string, PositionHistoryEvent[]>;
  missingSignatures: string[];
  parseErrors: string[];
}> {
  const apiByPosition: Record<string, MeteoraPositionEvent[]> = {};
  const apiBySignature = new Map<string, MeteoraPositionEvent[]>();

  for (let i = 0; i < positionAddresses.length; i++) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    const address = positionAddresses[i];
    try {
      const events = await fetchPositionHistoricalEvents(address);
      apiByPosition[address] = events;
      for (const event of events) {
        const list = apiBySignature.get(event.signature) ?? [];
        list.push(event);
        apiBySignature.set(event.signature, list);
      }
    } catch (error) {
      apiByPosition[address] = [];
      console.warn('Failed to load historical events for', address, error);
    }
  }

  const signatures = [...apiBySignature.keys()];
  const parseMeteoraTransaction = await loadParseMeteoraTransaction();
  const missingSignatures: string[] = [];
  const parseErrors: string[] = [];
  const events: PositionHistoryEvent[] = [];
  const wanted = new Set(positionAddresses);

  await mapWithThrottle(signatures, async (signature) => {
    try {
      const raw = await getParsedTransaction(signature);
      if (!raw) {
        missingSignatures.push(signature);
        return;
      }
      const parsed = parseMeteoraTransaction(raw);
      const apiEvents = apiBySignature.get(signature) ?? [];
      for (const instruction of parsed) {
        if (!wanted.has(instruction.position)) continue;
        const apiMatch =
          apiEvents.find(event =>
            event.positionAddress === instruction.position
            && event.slot === instruction.slot
          )
          ?? apiEvents.find(event => event.positionAddress === instruction.position)
          ?? apiEvents[0];
        events.push({
          signature: instruction.signature,
          slot: instruction.slot,
          timestamp: instruction.timestamp instanceof Date
            ? instruction.timestamp
            : new Date(instruction.timestamp),
          positionAddress: instruction.position,
          poolAddress: instruction.pool ?? apiMatch?.poolAddress ?? '',
          instruction,
          api: apiMatch,
        });
      }
    } catch (error) {
      parseErrors.push(
        `${signature}: ${error instanceof Error ? error.message : 'parse failed'}`
      );
    }
  }, RPC_GAP_MS);

  const sorted = sortHistoryEvents(events);
  const eventsByPosition: Record<string, PositionHistoryEvent[]> = {};
  for (const address of positionAddresses) eventsByPosition[address] = [];
  for (const event of sorted) {
    if (!eventsByPosition[event.positionAddress]) {
      eventsByPosition[event.positionAddress] = [];
    }
    eventsByPosition[event.positionAddress].push(event);
  }

  return { events: sorted, eventsByPosition, missingSignatures, parseErrors };
}

interface PendingRange {
  lowerBinId: number;
  upperBinId: number;
}

function toSimulatedTxs(
  events: PositionHistoryEvent[],
  options: {
    baseDecimals: number;
    quoteDecimals: number;
    binStep: number;
    applyDecimalAdjustment: boolean;
  }
): {
  stackedTxs: SimulatedTransaction[];
  claimedFees: ClaimedFeesSummary;
  initialActiveBinId: number;
  initialPrice: number;
} {
  const pendingRange = new Map<string, PendingRange>();
  const opened = new Set<string>();
  const stackedTxs: SimulatedTransaction[] = [];
  const claimedFees: ClaimedFeesSummary = { base: 0, quote: 0, usd: 0 };
  let initialActiveBinId = 0;
  let initialPrice = 0;

  for (const event of events) {
    const ix = event.instruction;
    const positionAddress = event.positionAddress;

    if (ix.type === 'CreatePosition') {
      if (ix.lower_bin_id != null && ix.upper_bin_id != null) {
        pendingRange.set(positionAddress, {
          lowerBinId: toSimulatorBinId(ix.lower_bin_id),
          upperBinId: toSimulatorBinId(ix.upper_bin_id),
        });
      }
      continue;
    }

    if (ix.type === 'ClaimFees' || ix.type === 'ClaimRewards') {
      claimedFees.base += rawToUi(ix.amount_x, options.baseDecimals);
      claimedFees.quote += rawToUi(ix.amount_y, options.quoteDecimals);
      if (event.api) claimedFees.usd += event.api.totalUsd;
      continue;
    }

    if (ix.type === 'ClosePosition') {
      continue;
    }

    if (ix.type !== 'AddLiquidity' && ix.type !== 'RemoveLiquidity') {
      continue;
    }

    const onChainActive = ix.active_bin_id;
    const activeSimId = onChainActive != null ? toSimulatorBinId(onChainActive) : 0;
    const price = activeSimId
      ? getPriceFromId(
          activeSimId,
          options.binStep,
          options.baseDecimals,
          options.quoteDecimals,
          options.applyDecimalAdjustment
        )
      : 0;

    const rangeFromIx =
      ix.lower_bin_id != null && ix.upper_bin_id != null
        ? {
            lowerBinId: toSimulatorBinId(ix.lower_bin_id),
            upperBinId: toSimulatorBinId(ix.upper_bin_id),
          }
        : pendingRange.get(positionAddress);

    const baseAmount = rawToUi(ix.amount_x, options.baseDecimals);
    const quoteAmount = rawToUi(ix.amount_y, options.quoteDecimals);

    if (ix.type === 'AddLiquidity') {
      if (!(initialPrice > 0) && price > 0) {
        initialPrice = price;
        initialActiveBinId = activeSimId;
      }

      const lowerBinId = rangeFromIx?.lowerBinId;
      const upperBinId = rangeFromIx?.upperBinId;
      if (lowerBinId == null || upperBinId == null || upperBinId < lowerBinId) {
        continue;
      }

      const lowerPrice = getPriceFromId(
        lowerBinId,
        options.binStep,
        options.baseDecimals,
        options.quoteDecimals,
        options.applyDecimalAdjustment
      );
      const upperPrice = getPriceFromId(
        upperBinId,
        options.binStep,
        options.baseDecimals,
        options.quoteDecimals,
        options.applyDecimalAdjustment
      );

      const isFirst = !opened.has(positionAddress);
      stackedTxs.push({
        id: `hist-${event.signature}-${stackedTxs.length}`,
        type: isFirst ? 'add-position' : 'add-liquidity',
        price: price > 0 ? price : lowerPrice,
        strategy: strategyFromParser(ix.strategy),
        baseAmount,
        quoteAmount,
        lowerPrice,
        upperPrice,
        positionAddress,
        removeBps: 0,
      });
      opened.add(positionAddress);
      pendingRange.set(positionAddress, { lowerBinId, upperBinId });
      continue;
    }

    // RemoveLiquidity
    const lowerBinId = rangeFromIx?.lowerBinId;
    const upperBinId = rangeFromIx?.upperBinId;
    const lowerPrice = lowerBinId != null
      ? getPriceFromId(
          lowerBinId,
          options.binStep,
          options.baseDecimals,
          options.quoteDecimals,
          options.applyDecimalAdjustment
        )
      : 0;
    const upperPrice = upperBinId != null
      ? getPriceFromId(
          upperBinId,
          options.binStep,
          options.baseDecimals,
          options.quoteDecimals,
          options.applyDecimalAdjustment
        )
      : 0;

    stackedTxs.push({
      id: `hist-${event.signature}-${stackedTxs.length}`,
      type: 'remove-liquidity',
      price: price > 0 ? price : (lowerPrice || 0),
      strategy: 'spot',
      baseAmount,
      quoteAmount,
      lowerPrice: lowerPrice || 0,
      upperPrice: upperPrice || 0,
      positionAddress,
      // Filled after we can measure against stacked state; placeholder full remove if empty.
      removeBps: 10000,
    });
  }

  return { stackedTxs, claimedFees, initialActiveBinId, initialPrice };
}

/**
 * Fill removeBps by measuring removed amounts against the then-current stacked position.
 */
function refineRemoveBps(
  stackedTxs: SimulatedTransaction[],
  replay: ReplayOptions
): SimulatedTransaction[] {
  const refined: SimulatedTransaction[] = [];
  for (let i = 0; i < stackedTxs.length; i++) {
    const tx = stackedTxs[i];
    if (tx.type !== 'remove-liquidity') {
      refined.push(tx);
      continue;
    }

    const prior = replayTransactions([], refined, replay);
    const targets = prior.filter(slice => slice.positionAddress === tx.positionAddress && slice.scale > 0);
    if (targets.length === 0) {
      refined.push({ ...tx, removeBps: 10000 });
      continue;
    }

    const atPrice = simulateSlices(targets, tx.price > 0 ? tx.price : 1e-12, replay);
    const current = binsToAmounts(atPrice, true);
    const currentValue = current.value;
    const removeValue =
      (tx.quoteAmount || 0)
      + (tx.baseAmount || 0) * (tx.price > 0 ? tx.price : 0);

    let bps = 10000;
    if (currentValue > 1e-12 && removeValue > 0) {
      bps = Math.max(0, Math.min(10000, Math.round((removeValue / currentValue) * 10000)));
    } else if (current.base + current.quote <= 1e-12) {
      bps = 10000;
    } else if (tx.baseAmount > 0 || tx.quoteAmount > 0) {
      // Fall back to amount ratios when value is unreliable.
      const baseRatio = current.base > 1e-12 ? tx.baseAmount / current.base : 0;
      const quoteRatio = current.quote > 1e-12 ? tx.quoteAmount / current.quote : 0;
      const ratio = Math.max(baseRatio, quoteRatio);
      bps = Math.max(0, Math.min(10000, Math.round(ratio * 10000)));
    }

    refined.push({ ...tx, removeBps: bps });
  }
  return refined;
}

/**
 * Replay historical add-position txs as real (non-simulated) wallet positions.
 * Existing replayTransactions marks add-position as simulated; remap afterward.
 */
function stackHistoricalSlices(
  stackedTxs: SimulatedTransaction[],
  replay: ReplayOptions,
  knownPositions: string[]
): LiquiditySlice[] {
  const slices = replayTransactions([], stackedTxs, replay);
  const known = new Set(knownPositions);
  return slices.map(slice => {
    if (!known.has(slice.positionAddress)) return slice;
    return {
      ...slice,
      isSimulatedPosition: false,
      id: slice.id.startsWith('hist-') ? slice.id : `historical-${slice.id}`,
    };
  });
}

function binsByPosition(
  slices: LiquiditySlice[],
  replay: ReplayOptions
): Record<string, SimulatedBin[]> {
  const addresses = [...new Set(slices.map(slice => slice.positionAddress))];
  const result: Record<string, SimulatedBin[]> = {};
  for (const address of addresses) {
    const group = slices.filter(slice => slice.positionAddress === address && slice.scale > 0);
    result[address] = group.length ? combineSliceBins(group, replay) : [];
  }
  return result;
}

function tokenTotals(bins: SimulatedBin[], useCurrent: boolean): { base: number; quote: number } {
  return binsToAmounts(bins, useCurrent);
}

function totalsWithinTolerance(
  stacked: number,
  onChain: number
): boolean {
  const abs = Math.abs(stacked - onChain);
  return (
    abs <= SHAPE_ABS_TOLERANCE
    || abs <= Math.max(onChain, stacked) * SHAPE_REL_TOLERANCE
    || (onChain < SHAPE_ABS_TOLERANCE && stacked < SHAPE_ABS_TOLERANCE)
  );
}

/**
 * Spread a known historical cost basis across live on-chain bin inventory so
 * the chart matches chain shares while deposits still drive P&L.
 */
export function applyCostBasisToBins(
  bins: SimulatedBin[],
  totalCost: number
): SimulatedBin[] {
  if (bins.length === 0) return [];
  const weights = bins.map(bin => Math.max(0, bin.currentValueInQuote || bin.initialValueInQuote || 0));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (!(totalCost > 0) || weightSum <= 0) {
    return bins.map(bin => ({ ...bin, initialValueInQuote: 0 }));
  }
  return bins.map((bin, index) => ({
    ...bin,
    initialValueInQuote: totalCost * (weights[index] / weightSum),
  }));
}

export function validateStackedShape(
  stackedBins: SimulatedBin[],
  onChainBins: SimulatedBin[],
  currentPrice: number
): ShapeValidation {
  const stackedSim = stackedBins.length ? stackedBins : [];
  const stacked = tokenTotals(stackedSim, true);
  const onChain = tokenTotals(onChainBins, true);

  const maxAbsDiffBase = Math.abs(stacked.base - onChain.base);
  const maxAbsDiffQuote = Math.abs(stacked.quote - onChain.quote);
  const totalsOk =
    totalsWithinTolerance(stacked.base, onChain.base)
    && totalsWithinTolerance(stacked.quote, onChain.quote);

  const message = totalsOk
    ? `Stacked history inventory matches on-chain at price ${currentPrice}.`
    : `Stacked history inventory diverges from on-chain (Δbase=${maxAbsDiffBase.toPrecision(4)}, Δquote=${maxAbsDiffQuote.toPrecision(4)}).`;

  return {
    ok: totalsOk,
    totalsOk,
    maxAbsDiffBase,
    maxAbsDiffQuote,
    stackedBase: stacked.base,
    stackedQuote: stacked.quote,
    onChainBase: onChain.base,
    onChainQuote: onChain.quote,
    message,
  };
}

export async function loadPositionHistory(
  options: HistoryLoadOptions
): Promise<LoadedPositionHistory> {
  const {
    positionAddresses,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    currentActiveBinId,
    currentPrice,
    onChainByPosition = {},
    onChainCombined = [],
  } = options;

  const emptyValidation: ShapeValidation = {
    ok: false,
    totalsOk: false,
    maxAbsDiffBase: 0,
    maxAbsDiffQuote: 0,
    stackedBase: 0,
    stackedQuote: 0,
    onChainBase: 0,
    onChainQuote: 0,
    message: 'No historical liquidity transactions loaded.',
  };

  if (positionAddresses.length === 0) {
    return {
      events: [],
      eventsByPosition: {},
      stackedTxs: [],
      historicalSlices: [],
      positionBins: {},
      combinedBins: [],
      initialPrice: 0,
      initialActiveBinId: 0,
      claimedFees: { base: 0, quote: 0, usd: 0 },
      shapeValidation: emptyValidation,
      reconciledToOnChain: false,
      parseErrors: [],
      missingSignatures: [],
    };
  }

  const { events, eventsByPosition, missingSignatures, parseErrors } =
    await fetchParsedPositionHistory(positionAddresses);

  const mapped = toSimulatedTxs(events, {
    baseDecimals,
    quoteDecimals,
    binStep,
    applyDecimalAdjustment,
  });

  // Reconstruction stays on the first-deposit active bin so cost basis is
  // preserved; current price is applied via simulateSlices for validation/display.
  const replayActiveBinId = mapped.initialActiveBinId || currentActiveBinId;
  const replay: ReplayOptions = {
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    activeBinId: replayActiveBinId,
  };

  const stackedTxs = refineRemoveBps(mapped.stackedTxs, replay);
  const historicalSlices = stackHistoricalSlices(stackedTxs, replay, positionAddresses);
  const positionBins = binsByPosition(historicalSlices, replay);
  const combinedBins = historicalSlices.length
    ? combineSliceBins(historicalSlices, replay)
    : [];

  const stackedAtCurrent = historicalSlices.length
    ? simulateSlices(
        historicalSlices,
        currentPrice > 0 ? currentPrice : mapped.initialPrice || 1e-12,
        replay
      )
    : [];

  const onChainForValidation = onChainCombined.length
    ? onChainCombined.map(bin => ({ ...bin }))
    : Object.values(onChainByPosition).flatMap(bins => cloneBins(bins));

  let shapeValidation = stackedAtCurrent.length && onChainForValidation.length
    ? validateStackedShape(stackedAtCurrent, onChainForValidation, currentPrice)
    : {
        ...emptyValidation,
        stackedBase: analyzeCurrentBins(stackedAtCurrent).totalBase,
        stackedQuote: analyzeCurrentBins(stackedAtCurrent).totalQuote,
        message: stackedAtCurrent.length
          ? 'Stacked history built; on-chain bins unavailable for validation.'
          : emptyValidation.message,
        ok: false,
        totalsOk: false,
      };

  let finalSlices = historicalSlices;
  let finalPositionBins = positionBins;
  let finalCombined = combinedBins;
  let reconciledToOnChain = false;

  // Strategy-weight replay often matches inventory totals but not live share
  // weights. When totals agree, adopt on-chain bin shape and keep historical cost.
  if (
    shapeValidation.totalsOk
    && Object.keys(onChainByPosition).length > 0
    && historicalSlices.length > 0
  ) {
    const histCost = slicesCostBasis(historicalSlices);
    const reconciled: LiquiditySlice[] = [];
    const nextPositionBins: Record<string, SimulatedBin[]> = {};

    for (const address of positionAddresses) {
      const onChainBins = onChainByPosition[address] ?? [];
      if (onChainBins.length === 0) continue;
      const addressCost = historicalSlices
        .filter(slice => slice.positionAddress === address)
        .reduce((sum, slice) => sum + costBasis(slice.bins, slice.scale), 0);
      const costForAddress = addressCost > 0
        ? addressCost
        : histCost / Math.max(1, positionAddresses.length);
      const priced = applyCostBasisToBins(cloneBins(onChainBins), costForAddress);
      nextPositionBins[address] = priced;
      const host = historicalSlices.find(slice => slice.positionAddress === address);
      reconciled.push({
        id: `historical-onchain-${address}`,
        positionAddress: address,
        isSimulatedPosition: false,
        openedAtPrice: mapped.initialPrice || host?.openedAtPrice || currentPrice,
        bins: priced,
        scale: 1,
        minPrice: priced[0]?.price ?? host?.minPrice ?? 0,
        maxPrice: priced[priced.length - 1]?.price ?? host?.maxPrice ?? 0,
        lowerBinId: priced[0]?.id ?? host?.lowerBinId ?? 0,
        upperBinId: priced[priced.length - 1]?.id ?? host?.upperBinId ?? 0,
      });
    }

    if (reconciled.length > 0) {
      finalSlices = reconciled;
      finalPositionBins = nextPositionBins;
      finalCombined = combineSliceBins(reconciled, replay);
      reconciledToOnChain = true;
      shapeValidation = {
        ...shapeValidation,
        ok: true,
        message: `${shapeValidation.message} Bin weights reconciled to on-chain shares; cost basis kept from deposit history.`,
      };
    }
  }

  return {
    events,
    eventsByPosition,
    stackedTxs,
    historicalSlices: finalSlices,
    positionBins: finalPositionBins,
    combinedBins: finalCombined,
    initialPrice: mapped.initialPrice,
    initialActiveBinId: mapped.initialActiveBinId,
    claimedFees: mapped.claimedFees,
    shapeValidation,
    reconciledToOnChain,
    parseErrors,
    missingSignatures,
  };
}

