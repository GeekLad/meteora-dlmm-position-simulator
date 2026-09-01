/**
 * Load and stack historical DLMM liquidity txs for open positions.
 *
 * Discovery: Meteora Data API `/positions/{address}/historical`
 * Detail: Solana RPC + `@geeklad/meteora-dlmm-liquidity-tx-parser`
 */

import type { DlmmInstruction, DlmmStrategy } from '@geeklad/meteora-dlmm-liquidity-tx-parser';
import {
  getPriceFromId,
  type SimulatedBin,
  type Strategy,
} from './dlmm';
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
  stackLiquidityTransactions,
  type LiquiditySlice,
  type ReplayOptions,
  type SimulatedTransaction,
} from './position-transactions';
import { getParsedTransaction, mapWithThrottle } from './solana-rpc';
import {
  readCachedInstructions,
  writeCachedInstructions,
} from './tx-cache';

const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';
const REQUEST_GAP_MS = 40;
/** Gap between signature fetches on top of the shared RPC rate limiter. */
const RPC_GAP_MS = 400;
const SHAPE_ABS_TOLERANCE = 1e-6;
const SHAPE_REL_TOLERANCE = 0.02;
/** Retry a second pass for signatures that failed transiently on the first sweep. */
const HISTORY_RETRY_PASSES = 2;

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

function parseTransactionSafe(
  parse: Awaited<ReturnType<typeof loadParseMeteoraTransaction>>,
  tx: Parameters<Awaited<ReturnType<typeof loadParseMeteoraTransaction>>>[0]
): { instructions: DlmmInstruction[]; error?: string } {
  try {
    return { instructions: parse(tx, true) };
  } catch (error) {
    return {
      instructions: [],
      error: error instanceof Error ? error.message : 'parse failed',
    };
  }
}

function mapApiEventType(eventType: string): DlmmInstruction['type'] {
  switch (eventType) {
    case 'remove': return 'RemoveLiquidity';
    case 'claim_fee': return 'ClaimFees';
    case 'claim_reward': return 'ClaimRewards';
    default: return 'AddLiquidity';
  }
}

function synthesizeInstructionsFromApi(
  signature: string,
  apiEvents: MeteoraPositionEvent[]
): DlmmInstruction[] {
  return apiEvents.map(api => ({
    signature,
    signer: api.userAddress,
    slot: api.slot,
    timestamp: new Date(api.blockTime > 1e12 ? api.blockTime : api.blockTime * 1000),
    fee: 0,
    type: mapApiEventType(api.eventType),
    position: api.positionAddress,
    pool: api.poolAddress,
  }));
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

function instructionAmounts(
  event: PositionHistoryEvent,
  baseDecimals: number,
  quoteDecimals: number
): { base: number; quote: number } {
  const fromParserBase = rawToUi(event.instruction.amount_x, baseDecimals);
  const fromParserQuote = rawToUi(event.instruction.amount_y, quoteDecimals);
  if (fromParserBase > 0 || fromParserQuote > 0) {
    return { base: fromParserBase, quote: fromParserQuote };
  }
  if (event.api) {
    return { base: event.api.amountX, quote: event.api.amountY };
  }
  return { base: 0, quote: 0 };
}

interface SequentialStackResult {
  slices: LiquiditySlice[];
  stackedTxs: SimulatedTransaction[];
  claimedFees: ClaimedFeesSummary;
  initialPrice: number;
  initialActiveBinId: number;
}

function orderEventsForStack(events: PositionHistoryEvent[]): PositionHistoryEvent[] {
  const grouped = new Map<string, PositionHistoryEvent[]>();
  const order: string[] = [];
  for (const event of events) {
    const key = `${event.signature}:${event.positionAddress}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(event);
  }
  const result: PositionHistoryEvent[] = [];
  for (const key of order) {
    const group = grouped.get(key)!;
    const isRebalance = group.some(event =>
      event.instruction.type === 'AddLiquidity' && group.some(other => other.instruction.type === 'RemoveLiquidity')
    );
    if (isRebalance) {
      // On-chain rebalance withdraws old bins then deposits the new shape.
      result.push(
        ...group.filter(event => event.instruction.type === 'RemoveLiquidity'),
        ...group.filter(event => event.instruction.type === 'AddLiquidity'),
        ...group.filter(event =>
          event.instruction.type !== 'RemoveLiquidity' && event.instruction.type !== 'AddLiquidity'
        )
      );
    } else {
      result.push(...group);
    }
  }
  return result;
}

/** Convert parsed history events into unified liquidity txs, then stack them. */
function stackPositionsSequentially(
  events: PositionHistoryEvent[],
  replay: ReplayOptions,
  currentPrice: number,
  _knownPositions: string[]
): SequentialStackResult {
  const pendingRange = new Map<string, { lowerBinId: number; upperBinId: number }>();
  const opened = new Set<string>();
  const txs: SimulatedTransaction[] = [];
  const claimedFees: ClaimedFeesSummary = { base: 0, quote: 0, usd: 0 };
  let lastPrice = 0;

  for (const event of orderEventsForStack(events)) {
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
      claimedFees.base += rawToUi(ix.amount_x, replay.baseDecimals);
      claimedFees.quote += rawToUi(ix.amount_y, replay.quoteDecimals);
      if (event.api) claimedFees.usd += event.api.totalUsd;
      continue;
    }

    if (ix.type === 'ClosePosition') continue;
    if (ix.type !== 'AddLiquidity' && ix.type !== 'RemoveLiquidity') continue;

    const onChainActive = ix.active_bin_id;
    const activeSimId = onChainActive != null ? toSimulatorBinId(onChainActive) : 0;
    const price = activeSimId
      ? getPriceFromId(
          activeSimId,
          replay.binStep,
          replay.baseDecimals,
          replay.quoteDecimals,
          replay.applyDecimalAdjustment
        )
      : lastPrice;
    if (price > 0) lastPrice = price;

    const rangeFromIx =
      ix.lower_bin_id != null && ix.upper_bin_id != null
        ? {
            lowerBinId: toSimulatorBinId(ix.lower_bin_id),
            upperBinId: toSimulatorBinId(ix.upper_bin_id),
          }
        : pendingRange.get(positionAddress);
    if (!rangeFromIx || rangeFromIx.upperBinId < rangeFromIx.lowerBinId) continue;

    const amounts = instructionAmounts(event, replay.baseDecimals, replay.quoteDecimals);
    const lowerPrice = getPriceFromId(
      rangeFromIx.lowerBinId,
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    const upperPrice = getPriceFromId(
      rangeFromIx.upperBinId,
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    const timestamp = event.timestamp instanceof Date
      ? event.timestamp.getTime()
      : new Date(event.timestamp).getTime();

    const bins = (ix.bins ?? []).map(bin => ({
      binId: toSimulatorBinId(bin.bin_id),
      weight: bin.weight,
      baseAmount: bin.amount_x != null ? rawToUi(bin.amount_x, replay.baseDecimals) : undefined,
      quoteAmount: bin.amount_y != null ? rawToUi(bin.amount_y, replay.quoteDecimals) : undefined,
      bps: bin.bps,
    }));
    const rebalanceAdds = (ix.rebalance?.adds ?? []).map(add => ({
      minDeltaId: add.min_delta_id,
      maxDeltaId: add.max_delta_id,
      x0: add.x0,
      y0: add.y0,
      deltaX: add.delta_x,
      deltaY: add.delta_y,
      favorXInActiveId: add.favor_x_in_active_id,
      bitFlag: add.bit_flag,
    }));
    const rebalanceRemoves = (ix.rebalance?.removes ?? []).map(remove => ({
      minBinId: remove.min_bin_id != null ? toSimulatorBinId(remove.min_bin_id) : undefined,
      maxBinId: remove.max_bin_id != null ? toSimulatorBinId(remove.max_bin_id) : undefined,
      bps: remove.bps,
    }));

    if (ix.type === 'AddLiquidity') {
      const isFirst = !opened.has(positionAddress);
      txs.push({
        id: `hist-${event.signature}-${txs.length}`,
        type: isFirst ? 'add-position' : 'add-liquidity',
        price: price || lowerPrice,
        strategy: strategyFromParser(ix.strategy),
        baseAmount: amounts.base,
        quoteAmount: amounts.quote,
        lowerPrice,
        upperPrice,
        positionAddress,
        removeBps: 0,
        source: 'historical',
        signature: event.signature,
        slot: event.slot,
        timestamp,
        bins: bins.length ? bins : undefined,
        rebalanceAdds: rebalanceAdds.length ? rebalanceAdds : undefined,
      });
      opened.add(positionAddress);
      pendingRange.set(positionAddress, rangeFromIx);
      continue;
    }

    const removeBpsFromSegments = rebalanceRemoves.length > 0
      ? Math.max(...rebalanceRemoves.map(segment => segment.bps))
      : (bins.find(bin => (bin.bps ?? 0) > 0)?.bps ?? 0);

    txs.push({
      id: `hist-${event.signature}-${txs.length}`,
      type: 'remove-liquidity',
      price: price || lowerPrice,
      strategy: strategyFromParser(ix.strategy),
      baseAmount: amounts.base,
      quoteAmount: amounts.quote,
      lowerPrice,
      upperPrice,
      positionAddress,
      removeBps: removeBpsFromSegments,
      source: 'historical',
      signature: event.signature,
      slot: event.slot,
      timestamp,
      bins: bins.length ? bins : undefined,
      rebalanceRemoves: rebalanceRemoves.length ? rebalanceRemoves : undefined,
    });
  }

  const stacked = stackLiquidityTransactions(txs, replay, currentPrice);
  return {
    slices: stacked.slices,
    stackedTxs: stacked.transactions,
    claimedFees,
    initialPrice: stacked.initialPrice,
    initialActiveBinId: stacked.initialActiveBinId,
  };
}

/**
 * Within one signature, match on-chain / parser physical order:
 * create → remove → add → claims → close. Rebalances emit remove then add;
 * sorting add before remove previously stacked deposits onto inventory that
 * should already have been withdrawn.
 */
function instructionOrder(type: string): number {
  switch (type) {
    case 'CreatePosition': return 0;
    case 'RemoveLiquidity': return 1;
    case 'AddLiquidity': return 2;
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
  const parsedSignatures = new Set<string>();

  const ingestSignature = async (signature: string): Promise<'ok' | 'missing' | 'error'> => {
    try {
      let parsed = await readCachedInstructions(signature);
      if (!parsed) {
        const raw = await getParsedTransaction(signature);
        if (!raw) {
          const fallback = synthesizeInstructionsFromApi(signature, apiBySignature.get(signature) ?? []);
          if (fallback.length === 0) return 'missing';
          parsed = fallback;
        } else {
          const result = parseTransactionSafe(parseMeteoraTransaction, raw);
          if (result.error) {
            parseErrors.push(`${signature}: ${result.error}`);
          }
          parsed = result.instructions.length > 0
            ? result.instructions
            : synthesizeInstructionsFromApi(signature, apiBySignature.get(signature) ?? []);
          if (parsed.length === 0) return 'error';
          if (result.instructions.length > 0) {
            await writeCachedInstructions(signature, parsed);
          }
        }
      }
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
      parsedSignatures.add(signature);
      return 'ok';
    } catch (error) {
      parseErrors.push(
        `${signature}: ${error instanceof Error ? error.message : 'parse failed'}`
      );
      return 'error';
    }
  };

  let pending = signatures;
  for (let pass = 0; pass < HISTORY_RETRY_PASSES && pending.length > 0; pass++) {
    if (pass > 0) {
      // Let rate-limit cooldowns expire before the retry sweep.
      await sleep(2_500 * pass);
      // Drop sticky errors from the prior pass; retry may succeed.
      for (let i = parseErrors.length - 1; i >= 0; i--) {
        if (pending.some(signature => parseErrors[i].startsWith(`${signature}:`))) {
          parseErrors.splice(i, 1);
        }
      }
    }
    const failedThisPass: string[] = [];
    await mapWithThrottle(pending, async (signature) => {
      if (parsedSignatures.has(signature)) return;
      const result = await ingestSignature(signature);
      if (result !== 'ok') failedThisPass.push(signature);
    }, RPC_GAP_MS);
    pending = failedThisPass;
  }

  for (const signature of signatures) {
    if (!parsedSignatures.has(signature)) missingSignatures.push(signature);
  }

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

/** Adopt live bin inventory while keeping stacked deposit cost basis. */
export function adoptOnChainShapeWithCost(
  onChainBins: SimulatedBin[],
  totalCost: number
): SimulatedBin[] {
  if (onChainBins.length === 0) return [];
  const shaped = onChainBins.map(bin => {
    const display = bin.currentTokenType === 'quote'
      ? bin.currentAmount
      : bin.currentAmount * bin.price;
    return {
      ...bin,
      initialTokenType: bin.currentTokenType,
      initialAmount: bin.currentAmount,
      initialDisplayValue: display,
      initialValueInQuote: bin.currentValueInQuote,
    };
  });
  return applyCostBasisToBins(shaped, totalCost);
}

const SHAPE_BIN_ABS_VALUE_TOLERANCE = 0.25;
const SHAPE_BIN_REL_VALUE_TOLERANCE = 0.0025;

function shapeDistributionOk(
  comparison: ReturnType<typeof compareBinShapes>
): boolean {
  // Token-side flips (live SOL vs stacked USDC in the same bin) are never OK.
  for (const bin of comparison.bins) {
    const liveSideFlip =
      (bin.liveBase > 1e-6 && bin.stackedQuote > 1e-6)
      || (bin.liveQuote > 1e-6 && bin.stackedBase > 1e-6);
    if (liveSideFlip) return false;
  }
  const onChainValue = comparison.bins.reduce(
    (sum, bin) => sum + bin.liveQuote + bin.liveBase * bin.price,
    0
  );
  const stackedValue = comparison.bins.reduce(
    (sum, bin) => sum + bin.stackedQuote + bin.stackedBase * bin.price,
    0
  );
  const totalVal = Math.max(onChainValue, stackedValue, 1);
  const worst = comparison.worstByAbsValue[0];
  if (worst && Math.abs(worst.dValue) > Math.max(SHAPE_BIN_ABS_VALUE_TOLERANCE, totalVal * 0.001)) {
    return false;
  }
  const sumAbs = comparison.bins.reduce((sum, bin) => sum + Math.abs(bin.dValue), 0);
  return sumAbs <= Math.max(0.5, totalVal * SHAPE_BIN_REL_VALUE_TOLERANCE);
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

/** Bin-by-bin live vs stacked comparison for diagnosing shape drift. */
export function compareBinShapes(
  stackedBins: SimulatedBin[],
  onChainBins: SimulatedBin[]
): {
  stacked: { base: number; quote: number };
  onChain: { base: number; quote: number };
  bins: Array<{
    id: number;
    price: number;
    liveBase: number;
    liveQuote: number;
    stackedBase: number;
    stackedQuote: number;
    dBase: number;
    dQuote: number;
    dValue: number;
  }>;
  worstByAbsValue: Array<{
    id: number;
    price: number;
    dBase: number;
    dQuote: number;
    dValue: number;
    liveBase: number;
    liveQuote: number;
    stackedBase: number;
    stackedQuote: number;
  }>;
} {
  const amountFor = (bin: SimulatedBin | undefined, side: 'base' | 'quote'): number => {
    if (!bin) return 0;
    return bin.currentTokenType === side ? bin.currentAmount : 0;
  };
  const liveMap = new Map<number, SimulatedBin>();
  const stackedMap = new Map<number, SimulatedBin>();
  for (const bin of onChainBins) liveMap.set(bin.id, bin);
  for (const bin of stackedBins) stackedMap.set(bin.id, bin);
  const ids = [...new Set([...liveMap.keys(), ...stackedMap.keys()])].sort((a, b) => a - b);
  const bins = ids.map(id => {
    const live = liveMap.get(id);
    const stacked = stackedMap.get(id);
    const price = live?.price ?? stacked?.price ?? 0;
    const liveBase = amountFor(live, 'base');
    const liveQuote = amountFor(live, 'quote');
    const stackedBase = amountFor(stacked, 'base');
    const stackedQuote = amountFor(stacked, 'quote');
    const dBase = stackedBase - liveBase;
    const dQuote = stackedQuote - liveQuote;
    return {
      id,
      price,
      liveBase,
      liveQuote,
      stackedBase,
      stackedQuote,
      dBase,
      dQuote,
      dValue: dQuote + dBase * price,
    };
  });
  const worstByAbsValue = [...bins]
    .sort((a, b) => Math.abs(b.dValue) - Math.abs(a.dValue))
    .slice(0, 25);
  return {
    stacked: binsToAmounts(stackedBins, true),
    onChain: binsToAmounts(onChainBins, true),
    bins,
    worstByAbsValue,
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

  const replayActiveBinId = currentActiveBinId;
  const replay: ReplayOptions = {
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    activeBinId: replayActiveBinId,
  };

  const sequential = stackPositionsSequentially(
    events,
    replay,
    currentPrice,
    positionAddresses
  );
  const stackedTxs = sequential.stackedTxs;
  const historicalSlices = sequential.slices;
  const positionBins = binsByPosition(historicalSlices, replay);
  const combinedBins = historicalSlices.length
    ? combineSliceBins(historicalSlices, {
        ...replay,
        activeBinId: sequential.initialActiveBinId || replay.activeBinId,
      })
    : [];

  const stackedAtCurrent = historicalSlices.length
    ? combineSliceBins(historicalSlices, {
        ...replay,
        activeBinId: currentActiveBinId || sequential.initialActiveBinId,
      })
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

  const distribution = stackedAtCurrent.length && onChainForValidation.length
    ? compareBinShapes(stackedAtCurrent, onChainForValidation)
    : null;

  // Prefer live on-chain bin shares when the stack diverges on totals or
  // per-bin weights; keep historical deposit cost for entry / P&L.
  const shouldAdoptOnChainShape =
    onChainForValidation.length > 0
    && historicalSlices.length > 0
    && (shapeValidation.onChainBase > 0 || shapeValidation.onChainQuote > 0)
    && (
      !shapeValidation.totalsOk
      || (distribution != null && !shapeDistributionOk(distribution))
    );

  if (shouldAdoptOnChainShape) {
    const costByPosition = new Map<string, number>();
    for (const slice of historicalSlices) {
      costByPosition.set(
        slice.positionAddress,
        (costByPosition.get(slice.positionAddress) ?? 0) + costBasis(slice.bins, slice.scale)
      );
    }
    const totalStackedCost = [...costByPosition.values()].reduce((sum, value) => sum + value, 0);

    finalPositionBins = {};
    for (const address of positionAddresses) {
      const live = onChainByPosition[address] ?? [];
      const cost = costByPosition.get(address) ?? 0;
      finalPositionBins[address] = live.length
        ? adoptOnChainShapeWithCost(live, cost)
        : (positionBins[address] ?? []);
    }

    const adoptedCombined = onChainCombined.length
      ? adoptOnChainShapeWithCost(onChainCombined, totalStackedCost)
      : adoptOnChainShapeWithCost(onChainForValidation, totalStackedCost);

    finalSlices = historicalSlices.map(slice => {
      const live = finalPositionBins[slice.positionAddress] ?? [];
      if (live.length === 0) return slice;
      return {
        ...slice,
        bins: live,
        minPrice: live[0]?.price ?? slice.minPrice,
        maxPrice: live[live.length - 1]?.price ?? slice.maxPrice,
        lowerBinId: live[0]?.id ?? slice.lowerBinId,
        upperBinId: live[live.length - 1]?.id ?? slice.upperBinId,
      };
    });
    finalCombined = adoptedCombined;
    reconciledToOnChain = true;

    const before = distribution;
    const baseScale = before && before.stacked.base > 1e-12
      ? before.onChain.base / before.stacked.base
      : 1;
    const quoteScale = before && before.stacked.quote > 1e-12
      ? before.onChain.quote / before.stacked.quote
      : 1;
    shapeValidation = {
      ...shapeValidation,
      ok: true,
      totalsOk: true,
      stackedBase: shapeValidation.onChainBase,
      stackedQuote: shapeValidation.onChainQuote,
      message: shapeValidation.totalsOk
        ? 'Stacked history cost kept; live on-chain bin shares used for shape.'
        : `Stacked history aligned to live bin shares (base ×${baseScale.toFixed(4)}, quote ×${quoteScale.toFixed(4)}).`,
    };
  }

  return {
    events,
    eventsByPosition,
    stackedTxs,
    historicalSlices: finalSlices,
    positionBins: finalPositionBins,
    combinedBins: finalCombined,
    initialPrice: sequential.initialPrice,
    initialActiveBinId: sequential.initialActiveBinId,
    claimedFees: sequential.claimedFees,
    shapeValidation,
    reconciledToOnChain,
    parseErrors,
    missingSignatures,
  };
}

