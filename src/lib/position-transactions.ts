import {
  accumulateSimulatedBin,
  binInitialDisplayValue,
  getIdFromPrice,
  getInitialBinsForBinRange,
  getPriceFromId,
  mergeSimulatedBins,
  runSimulation,
  trimEmptyEdgeBins,
  type Analysis,
  type SimulatedBin,
  type Strategy,
} from './dlmm';
import type { WalletPositionDetail } from './wallet-positions';

export type SimulatedTxType = 'add-liquidity' | 'remove-liquidity' | 'add-position';

/** Where a liquidity tx came from — historical (on-chain) or user-simulated. */
export type LiquidityTxSource = 'historical' | 'simulated';

/**
 * Unified liquidity transaction used for both on-chain history and in-app
 * simulations. Historical and simulated txs share this shape so they stack,
 * ledger, and render uniformly.
 */
/** Explicit per-bin distribution from weight / bin-list instructions. */
export interface LiquidityBinSpec {
  /** Simulator-space bin id (on-chain id + offset). */
  binId: number;
  weight?: number;
  /** UI-decimal amounts when the instruction carries them. */
  baseAmount?: number;
  quoteAmount?: number;
  bps?: number;
}

/**
 * Rebalance add segment (from parser `rebalance.adds`).
 * `x0`/`y0`/`delta_*` are liquidity-shape parameters used as relative weights,
 * then normalized to the tx's `baseAmount` / `quoteAmount`.
 */
export interface RebalanceAddSpec {
  minDeltaId: number;
  maxDeltaId: number;
  x0: number;
  y0: number;
  deltaX: number;
  deltaY: number;
  favorXInActiveId: boolean;
  bitFlag: number;
}

export interface RebalanceRemoveSpec {
  minBinId?: number;
  maxBinId?: number;
  bps: number;
}

export interface SimulatedTransaction {
  id: string;
  type: SimulatedTxType;
  price: number;
  strategy: Strategy;
  baseAmount: number;
  quoteAmount: number;
  lowerPrice: number;
  upperPrice: number;
  positionAddress: string;
  removeBps: number;
  /** Defaults to `simulated` when omitted (share links, older state). */
  source?: LiquidityTxSource;
  /** On-chain signature when `source === 'historical'`. */
  signature?: string;
  slot?: number;
  /** Unix ms or ISO string. */
  timestamp?: number | string;
  /** Explicit per-bin list from weight / bin-list instructions. */
  bins?: LiquidityBinSpec[];
  /** Rebalance add segments that define the deposit shape. */
  rebalanceAdds?: RebalanceAddSpec[];
  /** Rebalance remove segments (bps over a bin range). */
  rebalanceRemoves?: RebalanceRemoveSpec[];
}

export function isHistoricalTx(tx: SimulatedTransaction): boolean {
  return tx.source === 'historical';
}

export function isSimulatedTx(tx: SimulatedTransaction): boolean {
  return !isHistoricalTx(tx);
}

export interface LiquiditySlice {
  id: string;
  positionAddress: string;
  isSimulatedPosition: boolean;
  openedAtPrice: number;
  bins: SimulatedBin[];
  scale: number;
  minPrice: number;
  maxPrice: number;
  lowerBinId: number;
  upperBinId: number;
}

export interface ReplayOptions {
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  activeBinId: number;
}

export function cloneBins(bins: SimulatedBin[]): SimulatedBin[] {
  return bins.map(bin => ({ ...bin }));
}

export function scaleBins(bins: SimulatedBin[], scale: number): SimulatedBin[] {
  if (scale === 1) return cloneBins(bins);
  return bins.map(bin => ({
    ...bin,
    initialAmount: bin.initialAmount * scale,
    initialValueInQuote: bin.initialValueInQuote * scale,
    initialDisplayValue: binInitialDisplayValue(bin) * scale,
    currentAmount: bin.currentAmount * scale,
    currentValueInQuote: bin.currentValueInQuote * scale,
  }));
}

export function costBasis(bins: SimulatedBin[], scale = 1): number {
  return bins.reduce((sum, bin) => sum + bin.initialValueInQuote * scale, 0);
}

export interface TxEconomics {
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
}

export interface TransactionLedger {
  perTx: TxEconomics[];
  originalCost: number;
  deposits: number;
  withdrawals: number;
  removedCost: number;
  /** Net base removed and not yet redeployed — the reinvestable credit. */
  removedBase: number;
  /** Base tokens already redeployed by later simulated deposits. */
  reinvestedBase: number;
  /** Quote value of those redeposited tokens at their deposit price. */
  reinvestedValue: number;
  realizedPnl: number;
}

function removalBounds(tx: SimulatedTransaction, replay: ReplayOptions): { minBinId: number; maxBinId: number } {
  if (!(tx.lowerPrice > 0 && tx.upperPrice > 0)) {
    return { minBinId: Number.NEGATIVE_INFINITY, maxBinId: Number.POSITIVE_INFINITY };
  }
  const lo = Math.min(tx.lowerPrice, tx.upperPrice);
  const hi = Math.max(tx.lowerPrice, tx.upperPrice);
  return {
    minBinId: getIdFromPrice(lo, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment),
    maxBinId: getIdFromPrice(hi, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment),
  };
}

/** Cost basis, mark-to-market proceeds, and removed base tokens of a removal at `tx.price`. */
export function measureRemoval(
  targets: LiquiditySlice[],
  tx: SimulatedTransaction,
  replay: ReplayOptions
): { costBasis: number; proceeds: number; removedBase: number } {
  const factorRemoved = Math.min(1, Math.max(0, tx.removeBps / 10000));
  if (factorRemoved <= 0 || targets.length === 0) {
    return { costBasis: 0, proceeds: 0, removedBase: 0 };
  }
  const { minBinId, maxBinId } = removalBounds(tx, replay);
  let costBasisValue = 0;
  let proceeds = 0;
  let removedBase = 0;
  for (const slice of targets) {
    if (slice.scale <= 0) continue;
    const scaled = scaleBins(slice.bins, slice.scale);
    const simulated = runSimulation(scaled, tx.price, slice.openedAtPrice).simulatedBins;
    const coversSlice = minBinId <= slice.lowerBinId && maxBinId >= slice.upperBinId;
    const bins = coversSlice
      ? simulated
      : simulated.filter(bin => bin.id >= minBinId && bin.id <= maxBinId);
    for (const bin of bins) {
      costBasisValue += bin.initialValueInQuote * factorRemoved;
      proceeds += bin.currentValueInQuote * factorRemoved;
      if (bin.currentTokenType === 'base') removedBase += bin.currentAmount * factorRemoved;
    }
  }
  return { costBasis: costBasisValue, proceeds, removedBase };
}

export function summarizeTransactionEconomics(
  baseSlices: LiquiditySlice[],
  transactions: SimulatedTransaction[],
  replay: ReplayOptions
): TransactionLedger {
  const originalCost = slicesCostBasis(baseSlices);
  const perTx: TxEconomics[] = [];
  let deposits = originalCost;
  let withdrawals = 0;
  let removedCost = 0;
  let removedBase = 0;
  let reinvestedBase = 0;
  let reinvestedValue = 0;
  let realizedPnl = 0;
  let slices = replayTransactions(baseSlices, [], replay);

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx.type === 'remove-liquidity') {
      const targets = slices.filter(slice => slice.positionAddress === tx.positionAddress);
      let measured = tx.removeBps > 0
        ? measureRemoval(targets, tx, replay)
        : {
            costBasis: Math.max(0, tx.quoteAmount + tx.baseAmount * (tx.price > 0 ? tx.price : 0)),
            proceeds: Math.max(0, tx.quoteAmount + tx.baseAmount * (tx.price > 0 ? tx.price : 0)),
            removedBase: tx.baseAmount,
          };
      // Amount-only historical removals: derive cost share from full-position mark.
      if (!(tx.removeBps > 0) && targets.length > 0) {
        const before = measureRemoval(targets, { ...tx, removeBps: 10000 }, replay);
        if (before.proceeds > 1e-12) {
          const share = Math.min(1, measured.proceeds / before.proceeds);
          measured = {
            costBasis: before.costBasis * share,
            proceeds: measured.proceeds,
            removedBase: before.removedBase * share,
          };
        }
      }
      const pnl = measured.proceeds - measured.costBasis;
      perTx.push({ costBasis: measured.costBasis, proceeds: measured.proceeds, realizedPnl: pnl });
      withdrawals += measured.proceeds;
      removedCost += measured.costBasis;
      // Only count removals that increase the net credit; removals below
      // what was already reinvested claw the credit back down.
      if (measured.removedBase > reinvestedBase) {
        removedBase += measured.removedBase - reinvestedBase;
        reinvestedBase = 0;
      } else {
        reinvestedBase -= measured.removedBase;
      }
      realizedPnl += pnl;
    } else {
      const next = replayTransactions(baseSlices, transactions.slice(0, i + 1), replay);
      const added = next.filter(slice => slice.id === tx.id);
      const cost = added.reduce((sum, slice) => sum + costBasis(slice.bins, slice.scale), 0);
      perTx.push({ costBasis: cost, proceeds: 0, realizedPnl: 0 });
      deposits += cost;
      // Deposits consume the reinvestable base credit, capped at what was
      // actually removed — quote-only or fresh-capital deposits leave it alone.
      const baseDeposited = added.reduce(
        (sum, slice) => sum + slice.bins.reduce(
          (binSum, bin) => (bin.initialTokenType === 'base' ? binSum + bin.initialAmount * slice.scale : binSum),
          0
        ),
        0
      );
      if (baseDeposited > 1e-9) {
        const consumed = Math.min(baseDeposited, removedBase - reinvestedBase);
        if (consumed > 0) {
          reinvestedBase += consumed;
          // Redeposited tokens were valued when withdrawn; at the deposit tx
          // price they move that much money from pocketed cash into the
          // position. Neither fresh capital nor a withdrawal anymore.
          reinvestedValue += consumed * tx.price;
        }
      }
    }
    slices = replayTransactions(baseSlices, transactions.slice(0, i + 1), replay);
  }

  return {
    perTx,
    originalCost,
    deposits,
    withdrawals,
    removedCost,
    removedBase,
    reinvestedBase,
    reinvestedValue,
    realizedPnl,
  };
}

export function binsToAmounts(bins: SimulatedBin[], useCurrent = false): { base: number; quote: number; value: number } {
  return bins.reduce(
    (acc, bin) => {
      const type = useCurrent ? bin.currentTokenType : bin.initialTokenType;
      const amount = useCurrent ? bin.currentAmount : bin.initialAmount;
      const value = useCurrent ? bin.currentValueInQuote : bin.initialValueInQuote;
      if (type === 'base') acc.base += amount;
      else acc.quote += amount;
      acc.value += value;
      return acc;
    },
    { base: 0, quote: 0, value: 0 }
  );
}

export function analyzeCurrentBins(simulatedBins: SimulatedBin[]): Analysis {
  return simulatedBins.reduce<Analysis>((acc, bin) => {
    if (bin.currentAmount > 1e-12) {
      acc.totalValueInQuote += bin.currentValueInQuote;
      if (bin.currentTokenType === 'base') {
        acc.totalBase += bin.currentAmount;
        acc.baseBins += 1;
      } else {
        acc.totalQuote += bin.currentAmount;
        acc.quoteBins += 1;
      }
    }
    return acc;
  }, {
    totalValueInQuote: 0,
    totalBase: 0,
    totalQuote: 0,
    totalBins: simulatedBins.filter(bin => bin.currentAmount > 1e-12).length,
    baseBins: 0,
    quoteBins: 0,
  });
}

/**
 * Set each bin's cost basis to the LP mark-to-market at `costPrice`.
 * Inventory shape is unchanged; only `initialValueInQuote` is updated so
 * P&L is 0 when the simulated price equals the chosen initial price.
 */
export function repriceCostBasis(bins: SimulatedBin[], costPrice: number): SimulatedBin[] {
  if (!(costPrice > 0) || bins.length === 0) {
    return bins.map(bin => ({ ...bin, initialValueInQuote: 0 }));
  }
  const marked = runSimulation(cloneBins(bins), costPrice, costPrice).simulatedBins;
  const byId = new Map(marked.map(bin => [bin.id, bin]));
  return bins.map(bin => {
    const sim = byId.get(bin.id);
    return {
      ...bin,
      initialValueInQuote:
        bin.initialAmount > 1e-12 && sim
          ? sim.currentValueInQuote
          : 0,
    };
  });
}

export function originalSlices(
  positions: WalletPositionDetail[],
  positionBins: Record<string, SimulatedBin[]>,
  openedAtPrice: number
): LiquiditySlice[] {
  return positions.map(position => ({
    id: `original-${position.positionAddress}`,
    positionAddress: position.positionAddress,
    isSimulatedPosition: position.isSimulated === true,
    openedAtPrice,
    bins: repriceCostBasis(positionBins[position.positionAddress] ?? [], openedAtPrice),
    scale: 1,
    minPrice: position.minPrice,
    maxPrice: position.maxPrice,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
  }));
}

function binsForDeposit(options: {
  tx: SimulatedTransaction;
  minBinId: number;
  maxBinId: number;
  replay: ReplayOptions;
}): SimulatedBin[] {
  const activeBinId = getIdFromPrice(
    options.tx.price,
    options.replay.binStep,
    options.replay.baseDecimals,
    options.replay.quoteDecimals,
    options.replay.applyDecimalAdjustment
  );
  return getInitialBinsForBinRange({
    binStep: options.replay.binStep,
    minBinId: options.minBinId,
    maxBinId: options.maxBinId,
    activeBinId,
    baseAmount: options.tx.baseAmount,
    quoteAmount: options.tx.quoteAmount,
    strategy: options.tx.strategy,
    baseDecimals: options.replay.baseDecimals,
    quoteDecimals: options.replay.quoteDecimals,
    applyDecimalAdjustment: options.replay.applyDecimalAdjustment,
  });
}

export function replayTransactions(
  baseSlices: LiquiditySlice[],
  transactions: SimulatedTransaction[],
  replay: ReplayOptions
): LiquiditySlice[] {
  const replacedSimulated = new Set(
    transactions
      .filter(tx => tx.type === 'add-position')
      .map(tx => tx.positionAddress)
  );
  const slices: LiquiditySlice[] = baseSlices
    .filter(slice => !(slice.isSimulatedPosition && replacedSimulated.has(slice.positionAddress)))
    .map(slice => ({
      ...slice,
      bins: cloneBins(slice.bins),
    }));
  const known = new Set(slices.map(slice => slice.positionAddress));

  for (const tx of transactions) {
    if (tx.type === 'add-position') {
      const minBinId = getIdFromPrice(
        tx.lowerPrice,
        replay.binStep,
        replay.baseDecimals,
        replay.quoteDecimals,
        replay.applyDecimalAdjustment
      );
      const maxBinId = getIdFromPrice(
        tx.upperPrice,
        replay.binStep,
        replay.baseDecimals,
        replay.quoteDecimals,
        replay.applyDecimalAdjustment
      );
      if (maxBinId < minBinId) continue;
      slices.push({
        id: tx.id,
        positionAddress: tx.positionAddress,
        isSimulatedPosition: true,
        openedAtPrice: tx.price,
        bins: binsForDeposit({ tx, minBinId, maxBinId, replay }),
        scale: 1,
        minPrice: getPriceFromId(minBinId, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment),
        maxPrice: getPriceFromId(maxBinId, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment),
        lowerBinId: minBinId,
        upperBinId: maxBinId,
      });
      known.add(tx.positionAddress);
      continue;
    }

    if (!known.has(tx.positionAddress)) continue;
    const targets = slices.filter(slice => slice.positionAddress === tx.positionAddress);
    if (targets.length === 0) continue;

    if (tx.type === 'remove-liquidity') {
      applyRemoveLiquidity(targets, tx, replay);
      continue;
    }

    const host = targets[0];
    slices.push({
      id: tx.id,
      positionAddress: tx.positionAddress,
      isSimulatedPosition: host.isSimulatedPosition,
      openedAtPrice: tx.price,
      bins: binsForDeposit({
        tx,
        minBinId: host.lowerBinId,
        maxBinId: host.upperBinId,
        replay,
      }),
      scale: 1,
      minPrice: host.minPrice,
      maxPrice: host.maxPrice,
      lowerBinId: host.lowerBinId,
      upperBinId: host.upperBinId,
    });
  }

  return slices;
}

function applyRemoveLiquidity(
  targets: LiquiditySlice[],
  tx: SimulatedTransaction,
  replay: ReplayOptions
): void {
  const factor = Math.max(0, 1 - tx.removeBps / 10000);
  const { minBinId, maxBinId } = removalBounds(tx, replay);

  for (const slice of targets) {
    const coversSlice = minBinId <= slice.lowerBinId && maxBinId >= slice.upperBinId;
    if (coversSlice) {
      slice.scale *= factor;
      continue;
    }
    slice.bins = slice.bins.map(bin => (
      bin.id >= minBinId && bin.id <= maxBinId ? scaleBins([bin], factor)[0] : bin
    ));
  }
}

/** Current bins for one position, spanning its official range (empty bins included). */
export function binsForPosition(
  slices: LiquiditySlice[],
  positionAddress: string,
  currentPrice: number,
  replay?: ReplayOptions | null
): SimulatedBin[] {
  const group = slices.filter(slice => slice.positionAddress === positionAddress && slice.scale > 0);
  if (group.length === 0) return [];
  const simulated = simulateSlices(group, currentPrice, null);
  const host = group[0];
  if (!replay || host.lowerBinId > host.upperBinId) {
    return trimEmptyEdgeBins(simulated);
  }
  const currentActiveId = getIdFromPrice(
    currentPrice,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );
  return mergeSimulatedBins([simulated], {
    binStep: replay.binStep,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
    activeBinId: currentActiveId,
    fillGaps: true,
    maxFilledBins: 1400,
    spanMinId: host.lowerBinId,
    spanMaxId: host.upperBinId,
  });
}

export function amountsInBinRange(
  bins: SimulatedBin[],
  minBinId: number,
  maxBinId: number
): { base: number; quote: number; value: number } {
  return binsToAmounts(
    bins.filter(bin => bin.id >= minBinId && bin.id <= maxBinId),
    true
  );
}

function displayBinSpan(
  slices: LiquiditySlice[],
  initialPrice?: number,
  replay?: ReplayOptions
): { minId: number; maxId: number } | null {
  const active = slices.filter(slice => slice.scale > 0);
  if (active.length === 0) return null;

  let minId = Infinity;
  let maxId = -Infinity;
  for (const slice of active) {
    if (slice.isSimulatedPosition) {
      minId = Math.min(minId, slice.lowerBinId);
      maxId = Math.max(maxId, slice.upperBinId);
      continue;
    }
    const liquid = slice.bins.filter(bin =>
      bin.initialAmount > 1e-12 || bin.currentAmount > 1e-12
    );
    if (liquid.length > 0) {
      minId = Math.min(minId, liquid[0].id, liquid[liquid.length - 1].id);
      maxId = Math.max(maxId, liquid[0].id, liquid[liquid.length - 1].id);
    } else {
      minId = Math.min(minId, slice.lowerBinId);
      maxId = Math.max(maxId, slice.upperBinId);
    }
  }
  // When the portfolio's range tops out below the initial (cost-basis) price,
  // extend the axis through that bin with empty bins. The gap shows how far
  // everything currently invested still is from the cost basis.
  if (
    typeof initialPrice === 'number' && initialPrice > 0 && replay
    && Number.isFinite(maxId)
  ) {
    const initialBinId = getIdFromPrice(
      initialPrice,
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    if (initialBinId > maxId) maxId = initialBinId;
  }
  if (!Number.isFinite(minId) || !Number.isFinite(maxId) || maxId < minId) return null;
  return { minId, maxId };
}



function alignBinsToSpan(
  bins: SimulatedBin[],
  slices: LiquiditySlice[],
  replay: ReplayOptions
): SimulatedBin[] {
  // replay.activeBinId holds the cost-basis price bin for chart alignment —
  // the span extends through it (plus empty gap bins) when the portfolio ends
  // below it.
  const initialPrice = replay.activeBinId > 0
    ? getPriceFromId(
        replay.activeBinId,
        replay.binStep,
        replay.baseDecimals,
        replay.quoteDecimals,
        replay.applyDecimalAdjustment
      )
    : undefined;
  const span = displayBinSpan(slices, initialPrice, replay);
  if (!span) return trimEmptyEdgeBins(bins);
  return mergeSimulatedBins([bins], {
    binStep: replay.binStep,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
    activeBinId: replay.activeBinId,
    fillGaps: true,
    spanMinId: span.minId,
    spanMaxId: span.maxId,
  });
}

export function simulateSlices(
  slices: LiquiditySlice[],
  currentPrice: number,
  replay?: ReplayOptions | null
): SimulatedBin[] {
  const converted = slices
    .filter(slice => slice.scale > 0)
    .map(slice => {
      const bins = scaleBins(slice.bins, slice.scale);
      return runSimulation(bins, currentPrice, slice.openedAtPrice).simulatedBins;
    })
    .filter(bins => bins.length > 0);

  if (converted.length === 0) return [];
  const merged = converted.reduce((acc, bins) => {
    const byId = new Map<number, SimulatedBin>();
    for (const bin of [...acc, ...bins]) {
      const existing = byId.get(bin.id);
      if (!existing) {
        byId.set(bin.id, { ...bin, initialDisplayValue: binInitialDisplayValue(bin) });
        continue;
      }
      accumulateSimulatedBin(existing, bin);
    }
    return [...byId.values()].sort((a, b) => a.price - b.price);
  });

  if (!replay) return trimEmptyEdgeBins(merged);
  // alignBinsToSpan needs the cost-basis activeBinId (the initial-price bin)
  // to extend the chart span past the portfolio when price sits below it, so
  // pass the original replay; the current-price bin is irrelevant there.
  return alignBinsToSpan(merged, slices, replay);
}

export function combineSliceBins(
  slices: LiquiditySlice[],
  replay: ReplayOptions
): SimulatedBin[] {
  const sets = slices
    .filter(slice => slice.scale > 0)
    .map(slice => scaleBins(slice.bins, slice.scale))
    .filter(bins => bins.length > 0);
  if (sets.length === 0) return [];
  const merged = mergeSimulatedBins(sets, {
    binStep: replay.binStep,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
    activeBinId: replay.activeBinId,
    fillGaps: true,
  });
  return alignBinsToSpan(merged, slices, replay);
}

export function slicesCostBasis(slices: LiquiditySlice[]): number {
  return slices.reduce((sum, slice) => sum + costBasis(slice.bins, slice.scale), 0);
}

/**
 * Discrete breakeven for the full position: the lowest bin price at which
 * mark-to-market value + realized P&L is non-negative versus remaining cost.
 * Walks liquidity bin prices in order (same bins the chart/PnL use).
 *
 * Returns null when there is no remaining liquidity or P&L never reaches zero
 * by the top of the position (value is monotonic in price for these LP shapes).
 */
export function findBreakevenPrice(
  slices: LiquiditySlice[],
  remainingCost: number,
  realizedPnl: number
): number | null {
  const active = slices.filter(slice => slice.scale > 0 && slice.bins.some(bin => bin.initialAmount > 1e-12));
  if (active.length === 0) return null;

  const target = remainingCost - realizedPnl;
  if (!(target > 1e-12)) return null;

  const priceById = new Map<number, number>();
  for (const slice of active) {
    for (const bin of slice.bins) {
      if (bin.initialAmount > 1e-12 || bin.currentAmount > 1e-12) {
        priceById.set(bin.id, bin.price);
      }
    }
  }
  const prices = [...priceById.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, price]) => price)
    .filter(price => price > 0);
  if (prices.length === 0) return null;

  const valueAt = (price: number) =>
    analyzeCurrentBins(simulateSlices(active, price, null)).totalValueInQuote;

  const absTol = Math.max(1e-9, Math.abs(target) * 1e-8);
  const valueMax = valueAt(prices[prices.length - 1]);
  if (target > valueMax + absTol) return null;

  for (const price of prices) {
    if (valueAt(price) + absTol >= target) return price;
  }
  return null;
}

/**
 * Breakeven target for the solvers: the **net investment** — the capital the
 * user actually put in. Every deposit adds to it; withdrawals never subtract,
 * because the withdrawn tokens are still the user's money (they sit as
 * pocketed cash in the portfolio analysis). Redepositing tokens taken from an
 * earlier removal moves money from that pocketed cash back into a position,
 * so the redeposited value is not fresh capital: after withdrawing 5.65 SOL
 * from a 1000 USDC position and redepositing it, the net investment is still
 * 1000 USDC, and breakeven is "positions plus pocketed cash together are
 * worth 1000 USDC".
 */
function investedCapital(
  baseSlices: LiquiditySlice[],
  transactions: SimulatedTransaction[],
  replay: ReplayOptions
): number {
  if (transactions.length === 0) {
    return slicesCostBasis(baseSlices);
  }
  const ledger = summarizeTransactionEconomics(baseSlices, transactions, replay);
  return ledger.deposits - ledger.reinvestedValue;
}

/**
 * Range-top price for "Adjust position to break even": the smallest upper
 * bound such that when price reaches that top, everything the user holds
 * (existing positions + the deposit as entered in the form) is together
 * worth the invested capital ({@link investedCapital}). The range-driver
 * effect then re-solves the base for that top, so the applied top/amount
 * pair keeps breaking even after the deposit reshapes on submit.
 *
 * Callers that apply this as `upperPrice` should also solve the base amount
 * (see {@link findBreakevenBaseAmount}) so the submitted range still breaks
 * even at that top after the shape rebuilds.
 */
export function findBreakevenMaxPrice(options: {
  baseSlices: LiquiditySlice[];
  transactions: SimulatedTransaction[];
  replay: ReplayOptions;
  strategy: Strategy;
  baseAmount: number;
  quoteAmount: number;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
}): number | null {
  const {
    baseSlices,
    transactions,
    replay,
    strategy,
    baseAmount,
    quoteAmount,
    lowerPrice,
    currentPrice,
  } = options;
  const maxBins = 1400;
  if (!(replay.binStep > 0) || !(currentPrice > 0)) return null;
  if (!(baseAmount > 1e-9) && !(quoteAmount > 1e-9)) return null;

  const toPrice = (id: number) => getPriceFromId(
    id,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );

  const activeId = getIdFromPrice(
    currentPrice,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );
  if (!(activeId > 0)) return null;
  const minExtId = lowerPrice > 0
    ? getIdFromPrice(lowerPrice, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment)
    : activeId;
  const startId = Math.max(activeId + 1, minExtId);
  const capId = startId + maxBins;

  const existing = replayTransactions(baseSlices, transactions, replay);
  const target = investedCapital(baseSlices, transactions, replay);

  // Value of everything (existing positions + the form's deposit) when the
  // price exits at `maxBinId`. Monotonic in maxBinId: a higher top adds
  // higher-priced bins whose base converts for more.
  const valueAtExit = (maxBinId: number): number => {
    const bins = getInitialBinsForBinRange({
      binStep: replay.binStep,
      minBinId: minExtId,
      maxBinId,
      activeBinId: activeId,
      baseAmount,
      quoteAmount,
      strategy,
      baseDecimals: replay.baseDecimals,
      quoteDecimals: replay.quoteDecimals,
      applyDecimalAdjustment: replay.applyDecimalAdjustment,
    });
    if (bins.length === 0) return Number.NEGATIVE_INFINITY;
    const deposit: LiquiditySlice = {
      id: 'breakeven-preview',
      positionAddress: 'breakeven-preview',
      isSimulatedPosition: true,
      openedAtPrice: currentPrice,
      bins,
      scale: 1,
      minPrice: toPrice(minExtId),
      maxPrice: toPrice(maxBinId),
      lowerBinId: minExtId,
      upperBinId: maxBinId,
    };
    const sim = simulateSlices([...existing, deposit], toPrice(maxBinId), null);
    return analyzeCurrentBins(sim).totalValueInQuote;
  };

  let lo = startId;
  let hi = capId;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (valueAtExit(mid) >= target - 1e-6) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best == null) return null;
  return toPrice(best);
}

/**
 * Base amount a deposit over the fixed range [lowerPrice, upperPrice] needs
 * (quote amount fixed) so that when price reaches the top of the range,
 * everything the user holds (existing positions + this deposit) is together
 * worth the invested capital ({@link investedCapital}):
 *
 *   value(everything, upperPrice) >= investedCapital
 *
 * Value is linear in the base amount, so two probe simulations determine the
 * answer exactly. Returns 0 when the target is already met with no base.
 */
export function findBreakevenBaseAmount(options: {
  baseSlices: LiquiditySlice[];
  transactions: SimulatedTransaction[];
  replay: ReplayOptions;
  strategy: Strategy;
  baseAmount: number;
  quoteAmount: number;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
}): number | null {
  const {
    baseSlices,
    transactions,
    replay,
    strategy,
    quoteAmount,
    lowerPrice,
    upperPrice,
    currentPrice,
  } = options;
  if (!(replay.binStep > 0) || !(currentPrice > 0)) return null;
  if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) return null;

  const toId = (price: number) => getIdFromPrice(
    price,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );
  const toPrice = (id: number) => getPriceFromId(
    id,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );

  const activeId = toId(currentPrice);
  const minId = toId(lowerPrice);
  const maxId = toId(upperPrice);
  if (!(activeId > 0) || !(minId > 0) || maxId < minId) return null;

  const existing = replayTransactions(baseSlices, transactions, replay);
  const target = investedCapital(baseSlices, transactions, replay);

  const depositFor = (base: number): LiquiditySlice | null => {
    const bins = getInitialBinsForBinRange({
      binStep: replay.binStep,
      minBinId: minId,
      maxBinId: maxId,
      activeBinId: activeId,
      baseAmount: base,
      quoteAmount,
      strategy,
      baseDecimals: replay.baseDecimals,
      quoteDecimals: replay.quoteDecimals,
      applyDecimalAdjustment: replay.applyDecimalAdjustment,
    });
    if (bins.length === 0) return null;
    return {
      id: 'breakeven-amount-preview',
      positionAddress: 'breakeven-amount-preview',
      isSimulatedPosition: true,
      openedAtPrice: currentPrice,
      bins,
      scale: 1,
      minPrice: toPrice(minId),
      maxPrice: toPrice(maxId),
      lowerBinId: minId,
      upperBinId: maxId,
    };
  };

  // value(base) is linear in the amount: the fixed quote side and existing
  // positions form the intercept, and each base bin converts at its own bin
  // price by the top, proportional to its share of baseAmount.
  const valueAt = (base: number): number => {
    const ext = depositFor(base);
    if (!ext) return Number.NEGATIVE_INFINITY;
    const allSlices = [...existing, ext];
    const simulated = simulateSlices(allSlices, toPrice(maxId), null);
    return analyzeCurrentBins(simulated).totalValueInQuote;
  };

  const p1 = 1;
  const p2 = 2;
  const v1 = valueAt(p1);
  const v2 = valueAt(p2);
  if (!Number.isFinite(v1) || !Number.isFinite(v2)) return null;
  const slope = v2 - v1;

  // Base that brings the combined range-top value up to the invested
  // capital. Zero or negative means the target is met without new base.
  if (!(slope > 1e-18)) return 0;
  const required = (target - v1) / slope + p1;
  if (!Number.isFinite(required) || required < 0) return 0;
  return required;
}

export function positionsFromSlices(
  originalPositions: WalletPositionDetail[],
  slices: LiquiditySlice[],
  currentPrice: number
): WalletPositionDetail[] {
  const grouped = new Map<string, LiquiditySlice[]>();
  for (const slice of slices) {
    const list = grouped.get(slice.positionAddress) ?? [];
    list.push(slice);
    grouped.set(slice.positionAddress, list);
  }

  const real = originalPositions.map(position => {
    const group = grouped.get(position.positionAddress) ?? [];
    const simulated = simulateSlices(group, currentPrice);
    const amounts = binsToAmounts(simulated, true);
    const host = group[0];
    const minPrice = host?.minPrice ?? position.minPrice;
    const maxPrice = host?.maxPrice ?? position.maxPrice;
    return {
      ...position,
      minPrice,
      maxPrice,
      lowerBinId: host?.lowerBinId ?? position.lowerBinId,
      upperBinId: host?.upperBinId ?? position.upperBinId,
      baseAmount: amounts.base,
      quoteAmount: amounts.quote,
      valueUsd: amounts.value,
      isOutOfRange: currentPrice < minPrice || currentPrice > maxPrice,
      isSimulated: position.isSimulated === true,
    };
  });

  const simulatedPositions: WalletPositionDetail[] = [];
  for (const [address, group] of grouped) {
    if (originalPositions.some(position => position.positionAddress === address)) continue;
    const host = group[0];
    const simulated = simulateSlices(group, currentPrice);
    const amounts = binsToAmounts(simulated, true);
    simulatedPositions.push({
      positionAddress: address,
      lowerBinId: host.lowerBinId,
      upperBinId: host.upperBinId,
      minPrice: host.minPrice,
      maxPrice: host.maxPrice,
      poolActiveBinId: 0,
      poolActivePrice: currentPrice,
      isOutOfRange: currentPrice < host.minPrice || currentPrice > host.maxPrice,
      createdAt: null,
      baseAmount: amounts.base,
      quoteAmount: amounts.quote,
      valueUsd: amounts.value,
      pnlUsd: 0,
      pnlPctChange: 0,
      unclaimedFeesUsd: 0,
      isSimulated: true,
    });
  }

  return [...real, ...simulatedPositions];
}

export function removeTransaction(
  transactions: SimulatedTransaction[],
  id: string
): SimulatedTransaction[] {
  const removed = transactions.find(tx => tx.id === id);
  const remaining = transactions.filter(tx => tx.id !== id);
  if (removed?.type === 'add-position') {
    return remaining.filter(tx => tx.positionAddress !== removed.positionAddress);
  }
  return remaining;
}

/** Remove every transaction touching a simulated position, so it disappears from the replay. */
export function removeSimulatedPosition(
  transactions: SimulatedTransaction[],
  positionAddress: string
): SimulatedTransaction[] {
  return transactions.filter(tx => tx.positionAddress !== positionAddress);
}

export function newTxId(): string {
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newSimulatedPositionAddress(): string {
  return `simulated-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Stable address for the first New-position form seed, shared with the simulator. */
export const FORM_SEED_POSITION_ADDRESS = 'simulated-form-seed';

export function simulatedPositionDetail(options: {
  positionAddress: string;
  minPrice: number;
  maxPrice: number;
  lowerBinId: number;
  upperBinId: number;
  currentPrice: number;
  bins: SimulatedBin[];
}): WalletPositionDetail {
  const amounts = binsToAmounts(options.bins, true);
  return {
    positionAddress: options.positionAddress,
    lowerBinId: options.lowerBinId,
    upperBinId: options.upperBinId,
    minPrice: options.minPrice,
    maxPrice: options.maxPrice,
    poolActiveBinId: 0,
    poolActivePrice: options.currentPrice,
    isOutOfRange: options.currentPrice < options.minPrice || options.currentPrice > options.maxPrice,
    createdAt: null,
    baseAmount: amounts.base,
    quoteAmount: amounts.quote,
    valueUsd: amounts.value,
    pnlUsd: 0,
    pnlPctChange: 0,
    unclaimedFeesUsd: 0,
    isSimulated: true,
  };
}

function freezeCurrentAsInitial(bins: SimulatedBin[]): SimulatedBin[] {
  return bins.map(bin => ({
    ...bin,
    initialTokenType: bin.currentTokenType,
    initialAmount: bin.currentAmount,
    initialDisplayValue:
      bin.currentTokenType === 'base'
        ? bin.currentAmount * bin.price
        : bin.currentAmount,
  }));
}

function rebaseInventory(bins: SimulatedBin[], toPrice: number): SimulatedBin[] {
  if (bins.length === 0 || !(toPrice > 0)) return bins;
  return freezeCurrentAsInitial(
    runSimulation(cloneBins(bins), toPrice, toPrice).simulatedBins
  );
}

function removeTokensInRange(
  bins: SimulatedBin[],
  minBinId: number,
  maxBinId: number,
  removeBase: number,
  removeQuote: number
): SimulatedBin[] {
  let baseTotal = 0;
  let quoteTotal = 0;
  for (const bin of bins) {
    if (bin.id < minBinId || bin.id > maxBinId || bin.currentAmount <= 1e-18) continue;
    if (bin.currentTokenType === 'base') baseTotal += bin.currentAmount;
    else quoteTotal += bin.currentAmount;
  }
  const baseFactor = baseTotal > 1e-18 ? Math.min(1, Math.max(0, removeBase / baseTotal)) : 0;
  const quoteFactor = quoteTotal > 1e-18 ? Math.min(1, Math.max(0, removeQuote / quoteTotal)) : 0;
  if (baseFactor <= 0 && quoteFactor <= 0) return bins;

  return bins.map(bin => {
    if (bin.id < minBinId || bin.id > maxBinId) return bin;
    const factor = 1 - (bin.currentTokenType === 'base' ? baseFactor : quoteFactor);
    if (factor >= 1) return bin;
    return {
      ...bin,
      initialAmount: bin.initialAmount * factor,
      initialValueInQuote: bin.initialValueInQuote * factor,
      initialDisplayValue: bin.initialDisplayValue * factor,
      currentAmount: bin.currentAmount * factor,
      currentValueInQuote: bin.currentValueInQuote * factor,
    };
  });
}

function addDepositBins(
  existing: SimulatedBin[],
  deposit: SimulatedBin[],
  replay: ReplayOptions
): SimulatedBin[] {
  if (deposit.length === 0) return existing;
  if (existing.length === 0) return deposit;
  return mergeSimulatedBins([existing, deposit], {
    binStep: replay.binStep,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
    activeBinId: replay.activeBinId,
    fillGaps: true,
  });
}

function scaleBinsByBps(bins: SimulatedBin[], minBinId: number, maxBinId: number, bps: number): SimulatedBin[] {
  const factor = Math.max(0, 1 - Math.min(10000, Math.max(0, bps)) / 10000);
  if (factor >= 1) return bins;
  return bins.map(bin => {
    if (bin.id < minBinId || bin.id > maxBinId) return bin;
    return {
      ...bin,
      initialAmount: bin.initialAmount * factor,
      initialValueInQuote: bin.initialValueInQuote * factor,
      initialDisplayValue: bin.initialDisplayValue * factor,
      currentAmount: bin.currentAmount * factor,
      currentValueInQuote: bin.currentValueInQuote * factor,
    };
  });
}

function makeTokenBin(
  binId: number,
  price: number,
  activeBinId: number,
  baseAmount: number,
  quoteAmount: number,
  replay: ReplayOptions
): SimulatedBin {
  const onQuoteSide = binId <= activeBinId;
  const tokenType: 'base' | 'quote' = onQuoteSide ? 'quote' : 'base';
  const amount = onQuoteSide ? quoteAmount : baseAmount;
  const valueInQuote = onQuoteSide ? quoteAmount : baseAmount * (price > 0 ? price : 0);
  const decimalAdjustment = replay.quoteDecimals - replay.baseDecimals;
  const pricePerLamport = price * Math.pow(10, decimalAdjustment);
  return {
    id: binId,
    price,
    pricePerLamport,
    initialTokenType: tokenType,
    initialAmount: amount,
    initialValueInQuote: valueInQuote,
    initialDisplayValue: onQuoteSide ? quoteAmount : baseAmount * price,
    currentTokenType: tokenType,
    currentAmount: amount,
    currentValueInQuote: valueInQuote,
  };
}

/**
 * Build deposit bins from rebalance add segments. x0/y0/delta_* act as relative
 * weights; results are normalized to the tx's total base/quote amounts.
 */
function binsFromRebalanceAdds(
  adds: RebalanceAddSpec[],
  activeBinId: number,
  baseAmount: number,
  quoteAmount: number,
  replay: ReplayOptions
): SimulatedBin[] {
  const baseWeights = new Map<number, number>();
  const quoteWeights = new Map<number, number>();

  for (const add of adds) {
    const minBinId = activeBinId + add.minDeltaId;
    const maxBinId = activeBinId + add.maxDeltaId;
    for (let binId = minBinId; binId <= maxBinId; binId++) {
      const price = getPriceFromId(
        binId,
        replay.binStep,
        replay.baseDecimals,
        replay.quoteDecimals,
        replay.applyDecimalAdjustment
      );
      const onQuoteSide = add.favorXInActiveId
        ? binId < activeBinId
        : binId <= activeBinId;
      if (onQuoteSide) {
        const weight = Math.max(0, add.y0 + add.deltaY * (activeBinId - binId));
        quoteWeights.set(binId, (quoteWeights.get(binId) ?? 0) + weight);
      } else {
        // Use delta as a relative weight (SDK also scales by inverse price for X;
        // we normalize to total baseAmount afterward).
        const weight = Math.max(0, add.x0 + add.deltaX * (binId - activeBinId));
        baseWeights.set(binId, (baseWeights.get(binId) ?? 0) + weight * Math.max(price, 1e-18));
      }
    }
  }

  const totalBaseWeight = [...baseWeights.values()].reduce((sum, w) => sum + w, 0);
  const totalQuoteWeight = [...quoteWeights.values()].reduce((sum, w) => sum + w, 0);
  const binIds = [...new Set([...baseWeights.keys(), ...quoteWeights.keys()])].sort((a, b) => a - b);
  if (binIds.length === 0) return [];

  // If weights collapsed to zero (e.g. all-zero params), fall back to strategy shape.
  if (totalBaseWeight <= 0 && totalQuoteWeight <= 0) return [];

  const result: SimulatedBin[] = [];
  for (const binId of binIds) {
    const price = getPriceFromId(
      binId,
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    const base = totalBaseWeight > 0 && baseAmount > 0
      ? baseAmount * ((baseWeights.get(binId) ?? 0) / totalBaseWeight)
      : 0;
    const quote = totalQuoteWeight > 0 && quoteAmount > 0
      ? quoteAmount * ((quoteWeights.get(binId) ?? 0) / totalQuoteWeight)
      : 0;
    if (base <= 0 && quote <= 0) continue;
    result.push(makeTokenBin(binId, price, activeBinId, base, quote, replay));
  }
  return result;
}

function binsFromExplicitSpecs(
  specs: LiquidityBinSpec[],
  activeBinId: number,
  baseAmount: number,
  quoteAmount: number,
  replay: ReplayOptions
): SimulatedBin[] {
  if (specs.length === 0) return [];
  const hasAmounts = specs.some(spec => (spec.baseAmount ?? 0) > 0 || (spec.quoteAmount ?? 0) > 0);
  const hasWeights = specs.some(spec => (spec.weight ?? 0) > 0);

  if (hasAmounts) {
    return specs
      .map(spec => {
        const price = getPriceFromId(
          spec.binId,
          replay.binStep,
          replay.baseDecimals,
          replay.quoteDecimals,
          replay.applyDecimalAdjustment
        );
        return makeTokenBin(
          spec.binId,
          price,
          activeBinId,
          spec.baseAmount ?? 0,
          spec.quoteAmount ?? 0,
          replay
        );
      })
      .filter(bin => bin.initialAmount > 0);
  }

  if (!hasWeights) return [];
  const quoteSpecs = specs.filter(spec => spec.binId <= activeBinId);
  const baseSpecs = specs.filter(spec => spec.binId > activeBinId);
  const totalQuoteWeight = quoteSpecs.reduce((sum, spec) => sum + (spec.weight ?? 0), 0);
  const totalBaseWeight = baseSpecs.reduce((sum, spec) => sum + (spec.weight ?? 0), 0);
  const result: SimulatedBin[] = [];
  for (const spec of specs) {
    const price = getPriceFromId(
      spec.binId,
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    const weight = spec.weight ?? 0;
    const base = spec.binId > activeBinId && totalBaseWeight > 0
      ? baseAmount * (weight / totalBaseWeight)
      : 0;
    const quote = spec.binId <= activeBinId && totalQuoteWeight > 0
      ? quoteAmount * (weight / totalQuoteWeight)
      : 0;
    if (base <= 0 && quote <= 0) continue;
    result.push(makeTokenBin(spec.binId, price, activeBinId, base, quote, replay));
  }
  return result;
}

function binsForDepositTx(
  tx: SimulatedTransaction,
  activeBinId: number,
  lowerBinId: number,
  upperBinId: number,
  replay: ReplayOptions
): SimulatedBin[] {
  if (tx.bins && tx.bins.length > 0) {
    const explicit = binsFromExplicitSpecs(
      tx.bins,
      activeBinId,
      tx.baseAmount,
      tx.quoteAmount,
      replay
    );
    if (explicit.length > 0) return explicit;
  }

  if (tx.rebalanceAdds && tx.rebalanceAdds.length > 0) {
    const fromRebalance = binsFromRebalanceAdds(
      tx.rebalanceAdds,
      activeBinId,
      tx.baseAmount,
      tx.quoteAmount,
      { ...replay, activeBinId }
    );
    if (fromRebalance.length > 0) return fromRebalance;
  }

  return getInitialBinsForBinRange({
    binStep: replay.binStep,
    minBinId: lowerBinId,
    maxBinId: upperBinId,
    activeBinId,
    baseAmount: tx.baseAmount,
    quoteAmount: tx.quoteAmount,
    strategy: tx.strategy,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
  });
}

export interface StackLiquidityResult {
  slices: LiquiditySlice[];
  /** Same txs with removeBps filled for amount-based historical removals. */
  transactions: SimulatedTransaction[];
  initialPrice: number;
  initialActiveBinId: number;
}

/**
 * Sequentially stack historical + simulated liquidity txs into position slices.
 * Converts existing inventory to each tx's price before applying the deposit/removal
 * so later actions compound on earlier ones (same path for both sources).
 */
export function stackLiquidityTransactions(
  transactions: SimulatedTransaction[],
  replay: ReplayOptions,
  currentPrice: number
): StackLiquidityResult {
  const binsByPosition = new Map<string, SimulatedBin[]>();
  const opened = new Set<string>();
  const refined: SimulatedTransaction[] = [];
  let initialPrice = 0;
  let initialActiveBinId = 0;
  let lastPrice = 0;

  for (const tx of transactions) {
    const positionAddress = tx.positionAddress;
    const price = tx.price > 0 ? tx.price : lastPrice;

    if (price > 0) {
      for (const [address, bins] of binsByPosition) {
        binsByPosition.set(address, rebaseInventory(bins, price));
      }
      lastPrice = price;
    }

    const minBinId = tx.lowerPrice > 0
      ? getIdFromPrice(tx.lowerPrice, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment)
      : Number.NEGATIVE_INFINITY;
    const maxBinId = tx.upperPrice > 0
      ? getIdFromPrice(tx.upperPrice, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment)
      : Number.POSITIVE_INFINITY;
    const activeBinId = price > 0
      ? getIdFromPrice(price, replay.binStep, replay.baseDecimals, replay.quoteDecimals, replay.applyDecimalAdjustment)
      : replay.activeBinId;

    if (tx.type === 'remove-liquidity') {
      const existing = binsByPosition.get(positionAddress) ?? [];
      let removeBps = tx.removeBps;
      if (existing.length > 0) {
        const before = binsToAmounts(existing, true);
        let updated = existing;
        if (tx.rebalanceRemoves && tx.rebalanceRemoves.length > 0) {
          for (const segment of tx.rebalanceRemoves) {
            const segMin = segment.minBinId ?? minBinId;
            const segMax = segment.maxBinId ?? maxBinId;
            updated = scaleBinsByBps(updated, segMin, segMax, segment.bps);
          }
        } else if (tx.bins && tx.bins.some(bin => (bin.bps ?? 0) > 0)) {
          for (const bin of tx.bins) {
            if (!(bin.bps && bin.bps > 0)) continue;
            updated = scaleBinsByBps(updated, bin.binId, bin.binId, bin.bps);
          }
        } else if (tx.removeBps > 0) {
          updated = scaleBinsByBps(existing, minBinId, maxBinId, tx.removeBps);
        } else {
          updated = removeTokensInRange(
            existing,
            minBinId,
            maxBinId,
            tx.baseAmount,
            tx.quoteAmount
          );
        }
        binsByPosition.set(positionAddress, updated);
        if (!(removeBps > 0) && before.value > 1e-12) {
          const after = binsToAmounts(updated, true);
          removeBps = Math.max(0, Math.min(10000, Math.round(((before.value - after.value) / before.value) * 10000)));
        }
      }
      refined.push({ ...tx, removeBps: removeBps || tx.removeBps || 0, source: tx.source ?? 'simulated' });
      continue;
    }

    if (!(initialPrice > 0) && price > 0) {
      initialPrice = price;
      initialActiveBinId = activeBinId;
    }

    const isFirst = !opened.has(positionAddress) || tx.type === 'add-position';
    const hostBins = binsByPosition.get(positionAddress) ?? [];
    const hostMin = hostBins.length ? Math.min(...hostBins.map(bin => bin.id)) : activeBinId;
    const hostMax = hostBins.length ? Math.max(...hostBins.map(bin => bin.id)) : activeBinId;
    const lowerBinId = Number.isFinite(minBinId) ? minBinId : hostMin;
    const upperBinId = Number.isFinite(maxBinId) ? maxBinId : hostMax;

    if (!(upperBinId >= lowerBinId) && !(tx.bins?.length) && !(tx.rebalanceAdds?.length)) {
      refined.push({ ...tx, source: tx.source ?? 'simulated' });
      continue;
    }

    const deposit = binsForDepositTx(
      tx,
      activeBinId,
      lowerBinId,
      upperBinId,
      { ...replay, activeBinId }
    );
    const existing = binsByPosition.get(positionAddress) ?? [];
    binsByPosition.set(
      positionAddress,
      addDepositBins(existing, deposit, { ...replay, activeBinId })
    );
    opened.add(positionAddress);
    refined.push({
      ...tx,
      type: isFirst && tx.type !== 'add-liquidity' ? 'add-position' : tx.type,
      source: tx.source ?? 'simulated',
    });
  }

  const displayPrice = currentPrice > 0 ? currentPrice : lastPrice || initialPrice;
  const slices: LiquiditySlice[] = [];
  for (const [positionAddress, bins] of binsByPosition) {
    const atCurrent = displayPrice > 0 ? rebaseInventory(bins, displayPrice) : bins;
    const liquid = trimEmptyEdgeBins(atCurrent);
    if (liquid.length === 0) continue;
    const historical = refined.some(
      tx => tx.positionAddress === positionAddress && isHistoricalTx(tx)
    );
    slices.push({
      id: `${historical ? 'historical' : 'simulated'}-${positionAddress}`,
      positionAddress,
      isSimulatedPosition: !historical,
      openedAtPrice: initialPrice || displayPrice,
      bins: liquid,
      scale: 1,
      minPrice: liquid[0].price,
      maxPrice: liquid[liquid.length - 1].price,
      lowerBinId: liquid[0].id,
      upperBinId: liquid[liquid.length - 1].id,
    });
  }

  return {
    slices,
    transactions: refined,
    initialPrice,
    initialActiveBinId,
  };
}

export function formatRealizedPnl(pnl: number, quoteSymbol: string): string {
  if (!Number.isFinite(pnl) || Math.abs(pnl) < 1e-9) return `no realized gain/loss`;
  const word = pnl > 0 ? 'gain' : 'loss';
  const sign = pnl > 0 ? '+' : '';
  return `realized ${word} ${sign}${trimNum(pnl)} ${quoteSymbol}`;
}

export function describeTransaction(
  tx: SimulatedTransaction,
  symbols: { base: string; quote: string }
): string {
  const price = Number.isFinite(tx.price) ? trimNum(tx.price) : '—';
  const prefix = isHistoricalTx(tx) ? 'On-chain: ' : '';
  if (tx.type === 'remove-liquidity') {
    const parts: string[] = [];
    if (tx.baseAmount > 0) parts.push(`${trimNum(tx.baseAmount)} ${symbols.base}`);
    if (tx.quoteAmount > 0) parts.push(`${trimNum(tx.quoteAmount)} ${symbols.quote}`);
    const amount = parts.length ? ` · ${parts.join(' + ')}` : '';
    const range = tx.lowerPrice > 0 && tx.upperPrice > 0
      ? ` of ${trimNum(tx.lowerPrice)}–${trimNum(tx.upperPrice)}`
      : '';
    const bpsLabel = tx.removeBps > 0 ? `${(tx.removeBps / 100).toFixed(0)}%` : 'liquidity';
    return `${prefix}Remove ${bpsLabel}${range}${amount} at ${price}`;
  }
  const parts: string[] = [];
  if (tx.baseAmount > 0) parts.push(`${trimNum(tx.baseAmount)} ${symbols.base}`);
  if (tx.quoteAmount > 0) parts.push(`${trimNum(tx.quoteAmount)} ${symbols.quote}`);
  const amount = parts.join(' + ') || '0';
  if (tx.type === 'add-position') {
    return `${prefix}New ${tx.strategy} position ${trimNum(tx.lowerPrice)}–${trimNum(tx.upperPrice)} · ${amount} · purchased at ${price}`;
  }
  return `${prefix}Add ${amount} (${tx.strategy}) · purchased at ${price}`;
}

function trimNum(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toPrecision(5);
  return value.toPrecision(4);
}
