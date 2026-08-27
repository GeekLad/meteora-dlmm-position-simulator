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
    bins: cloneBins(positionBins[position.positionAddress] ?? []),
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
  const hasRange = tx.lowerPrice > 0 && tx.upperPrice > 0;
  let minBinId = Number.NEGATIVE_INFINITY;
  let maxBinId = Number.POSITIVE_INFINITY;
  if (hasRange) {
    minBinId = getIdFromPrice(
      Math.min(tx.lowerPrice, tx.upperPrice),
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
    maxBinId = getIdFromPrice(
      Math.max(tx.lowerPrice, tx.upperPrice),
      replay.binStep,
      replay.baseDecimals,
      replay.quoteDecimals,
      replay.applyDecimalAdjustment
    );
  }

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

function displayBinSpan(slices: LiquiditySlice[]): { minId: number; maxId: number } | null {
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
  if (!Number.isFinite(minId) || !Number.isFinite(maxId) || maxId < minId) return null;
  return { minId, maxId };
}

function alignBinsToSpan(
  bins: SimulatedBin[],
  slices: LiquiditySlice[],
  replay: ReplayOptions
): SimulatedBin[] {
  const span = displayBinSpan(slices);
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
  const currentActiveId = getIdFromPrice(
    currentPrice,
    replay.binStep,
    replay.baseDecimals,
    replay.quoteDecimals,
    replay.applyDecimalAdjustment
  );
  return alignBinsToSpan(merged, slices, { ...replay, activeBinId: currentActiveId });
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

export function describeTransaction(
  tx: SimulatedTransaction,
  symbols: { base: string; quote: string }
): string {
  const price = Number.isFinite(tx.price) ? tx.price.toPrecision(5) : '—';
  if (tx.type === 'remove-liquidity') {
    const parts: string[] = [];
    if (tx.baseAmount > 0) parts.push(`${trimNum(tx.baseAmount)} ${symbols.base}`);
    if (tx.quoteAmount > 0) parts.push(`${trimNum(tx.quoteAmount)} ${symbols.quote}`);
    const amount = parts.length ? ` · ${parts.join(' + ')}` : '';
    const range = tx.lowerPrice > 0 && tx.upperPrice > 0
      ? ` of ${trimNum(tx.lowerPrice)}–${trimNum(tx.upperPrice)}`
      : '';
    return `Remove ${(tx.removeBps / 100).toFixed(0)}%${range}${amount} at ${price}`;
  }
  const parts: string[] = [];
  if (tx.baseAmount > 0) parts.push(`${trimNum(tx.baseAmount)} ${symbols.base}`);
  if (tx.quoteAmount > 0) parts.push(`${trimNum(tx.quoteAmount)} ${symbols.quote}`);
  const amount = parts.join(' + ') || '0';
  if (tx.type === 'add-position') {
    return `New ${tx.strategy} position ${trimNum(tx.lowerPrice)}–${trimNum(tx.upperPrice)} · ${amount} at ${price}`;
  }
  return `Add ${amount} (${tx.strategy}) at ${price}`;
}

function trimNum(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toPrecision(5);
  return value.toPrecision(4);
}
