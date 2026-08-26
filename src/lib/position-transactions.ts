import {
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
      const factor = Math.max(0, 1 - tx.removeBps / 10000);
      for (const slice of targets) slice.scale *= factor;
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

export function simulateSlices(
  slices: LiquiditySlice[],
  currentPrice: number
): SimulatedBin[] {
  const converted = slices
    .filter(slice => slice.scale > 0)
    .map(slice => {
      const bins = scaleBins(slice.bins, slice.scale);
      return runSimulation(bins, currentPrice, slice.openedAtPrice).simulatedBins;
    })
    .filter(bins => bins.length > 0);

  if (converted.length === 0) return [];
  return converted.reduce((merged, bins) => {
    const byId = new Map<number, SimulatedBin>();
    for (const bin of [...merged, ...bins]) {
      const existing = byId.get(bin.id);
      if (!existing) {
        byId.set(bin.id, { ...bin });
        continue;
      }
      existing.currentAmount += bin.currentAmount;
      existing.currentValueInQuote += bin.currentValueInQuote;
      existing.initialAmount += bin.initialAmount;
      existing.initialValueInQuote += bin.initialValueInQuote;
      if (bin.currentAmount > 0) existing.currentTokenType = bin.currentTokenType;
    }
    return [...byId.values()].sort((a, b) => a.price - b.price);
  });
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
  return trimEmptyEdgeBins(mergeSimulatedBins(sets, {
    binStep: replay.binStep,
    baseDecimals: replay.baseDecimals,
    quoteDecimals: replay.quoteDecimals,
    applyDecimalAdjustment: replay.applyDecimalAdjustment,
    activeBinId: replay.activeBinId,
    fillGaps: true,
  }));
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
    return `Remove ${(tx.removeBps / 100).toFixed(0)}%${amount} at ${price}`;
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
