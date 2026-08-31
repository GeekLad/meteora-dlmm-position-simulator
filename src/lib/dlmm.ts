

export type Strategy = 'spot' | 'bid-ask' | 'curve';

export interface SimulationParams {
  binStep: number;
  initialPrice: number;
  baseAmount: number;
  quoteAmount: number;
  lowerPrice: number;
  upperPrice: number;
  strategy: Strategy;
  baseDecimals?: number;  // Number of decimals for base token (default: 9 for SOL)
  quoteDecimals?: number; // Number of decimals for quote token (default: 6 for USDC)
  applyDecimalAdjustment?: boolean; // Whether to apply decimal adjustments in price calculations
}

export interface SimulatedBin {
  id: number;
  price: number;
  pricePerLamport: number; // SDK-format price (price adjusted for decimals)
  initialTokenType: 'base' | 'quote';
  initialAmount: number;
  initialValueInQuote: number;
  /** Quote-value at this bin's price. Safe to sum when overlapping deposits mix token types. */
  initialDisplayValue: number;
  currentTokenType: 'base' | 'quote';
  currentAmount: number;
  currentValueInQuote: number;
}


export interface Analysis {
  totalValueInQuote: number;
  totalBase: number;
  totalQuote: number;
  totalBins: number;
  baseBins: number;
  quoteBins: number;
}

import { getPriceFromBinId, getBinIdFromPrice } from './dlmm-sdk-wrapper';
import { calculateStrategyWeights, weightsToAmounts } from './dlmm-strategies';
import Decimal from 'decimal.js';

/**
 * Converts bin ID to human-readable price using SDK-accurate formulas
 *
 * @param id - The bin ID
 * @param binStep - The bin step in basis points
 * @param baseDecimals - Base token decimals (default: 9)
 * @param quoteDecimals - Quote token decimals (default: 6)
 * @returns Human-readable price
 */
export const getPriceFromId = (
  id: number,
  binStep: number,
  baseDecimals: number = 9,
  quoteDecimals: number = 6,
  applyDecimalAdjustment: boolean = true
): number => {
  return getPriceFromBinId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
};

/**
 * Converts human-readable price to bin ID using SDK-accurate formulas
 *
 * @param price - The price to convert
 * @param binStep - The bin step in basis points
 * @param baseDecimals - Base token decimals (default: 9)
 * @param quoteDecimals - Quote token decimals (default: 6)
 * @param roundUp - Whether to round up to next bin (default: false)
 * @returns The bin ID
 */
export const getIdFromPrice = (
  price: number,
  binStep: number,
  baseDecimals: number = 9,
  quoteDecimals: number = 6,
  applyDecimalAdjustment: boolean = true
): number => {
  return getBinIdFromPrice(price, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
};

/** Quote-only deposits sit at/below the active bin; base-only sit at/above. */
export type DepositSide = 'both' | 'quote' | 'base';

const DUST_AMOUNT = 1e-9;
export const DEFAULT_POSITION_BINS = 70;

export function depositSide(baseAmount: number, quoteAmount: number): DepositSide {
  const hasBase = baseAmount > DUST_AMOUNT;
  const hasQuote = quoteAmount > DUST_AMOUNT;
  if (hasQuote && !hasBase) return 'quote';
  if (hasBase && !hasQuote) return 'base';
  return 'both';
}

/**
 * Place a new position around `currentPrice` with a fixed bin width.
 *
 * One-sided quote (USDC) uses bins at or below the active price so every bin
 * can receive the deposit. One-sided base uses bins at or above. Two-sided
 * deposits straddle the active bin the same way a fresh pool selection does.
 */
export function rangeForDeposit(options: {
  currentPrice: number;
  binStep: number;
  widthBins: number;
  side: DepositSide;
  baseDecimals?: number;
  quoteDecimals?: number;
  applyDecimalAdjustment?: boolean;
}): { minBinId: number; maxBinId: number; lowerPrice: number; upperPrice: number } {
  const {
    currentPrice,
    binStep,
    side,
    baseDecimals = 9,
    quoteDecimals = 6,
    applyDecimalAdjustment = true,
  } = options;
  const width = Math.max(1, Math.round(options.widthBins) || DEFAULT_POSITION_BINS);
  const activeId = getIdFromPrice(
    currentPrice,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment
  );

  let minBinId: number;
  let maxBinId: number;
  if (side === 'quote') {
    minBinId = activeId - width + 1;
    maxBinId = activeId;
  } else if (side === 'base') {
    minBinId = activeId;
    maxBinId = activeId + width - 1;
  } else {
    const below = Math.floor((width - 1) / 2);
    const above = width - 1 - below;
    minBinId = activeId - below;
    maxBinId = activeId + above;
  }

  return {
    minBinId,
    maxBinId,
    lowerPrice: getPriceFromId(minBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
    upperPrice: getPriceFromId(maxBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
  };
}

const EMPTY_BIN_EPSILON = 1e-12;

/** Meteora-style bar height: quote amount, or base amount × this bin's price. */
export function binInitialDisplayValue(bin: SimulatedBin): number {
  if (typeof bin.initialDisplayValue === 'number' && Number.isFinite(bin.initialDisplayValue)) {
    return bin.initialDisplayValue;
  }
  return bin.initialTokenType === 'base' ? bin.initialAmount * bin.price : bin.initialAmount;
}

/** Meteora-style bar height from the bin's current contents after price movement. */
export function binCurrentDisplayValue(bin: SimulatedBin): number {
  if (bin.currentTokenType === 'base') return bin.currentAmount * bin.price;
  return bin.currentAmount;
}

function refreshInitialDisplayValue(bin: SimulatedBin): void {
  bin.initialDisplayValue = bin.initialTokenType === 'base'
    ? bin.initialAmount * bin.price
    : bin.initialAmount;
}

/** Overlay two bins of the same id without mixing SOL tokens into USDC amounts. */
export function accumulateSimulatedBin(existing: SimulatedBin, incoming: SimulatedBin): void {
  existing.initialDisplayValue = binInitialDisplayValue(existing) + binInitialDisplayValue(incoming);
  existing.initialValueInQuote += incoming.initialValueInQuote;
  existing.currentValueInQuote += incoming.currentValueInQuote;

  if (existing.initialTokenType === incoming.initialTokenType) {
    existing.initialAmount += incoming.initialAmount;
  } else if (existing.initialAmount <= EMPTY_BIN_EPSILON) {
    existing.initialAmount = incoming.initialAmount;
    existing.initialTokenType = incoming.initialTokenType;
  } else if (incoming.initialAmount > EMPTY_BIN_EPSILON) {
    existing.initialAmount = existing.initialDisplayValue;
    existing.initialTokenType = 'quote';
  }

  if (existing.currentTokenType === incoming.currentTokenType) {
    existing.currentAmount += incoming.currentAmount;
  } else if (existing.currentAmount <= EMPTY_BIN_EPSILON) {
    existing.currentAmount = incoming.currentAmount;
    existing.currentTokenType = incoming.currentTokenType;
  } else if (incoming.currentAmount > EMPTY_BIN_EPSILON) {
    const existingAsQuote = existing.currentTokenType === 'base'
      ? existing.currentAmount * existing.price
      : existing.currentAmount;
    const incomingAsQuote = incoming.currentTokenType === 'base'
      ? incoming.currentAmount * incoming.price
      : incoming.currentAmount;
    existing.currentAmount = existingAsQuote + incomingAsQuote;
    existing.currentTokenType = 'quote';
  }
}

/** Derive the paired token amount so a position is balanced at `activePrice`. */
export function pairAmountForStrategy(options: {
  strategy: Strategy;
  binStep: number;
  activePrice: number;
  lowerPrice: number;
  upperPrice: number;
  known: 'base' | 'quote';
  amount: number;
  baseDecimals?: number;
  quoteDecimals?: number;
  applyDecimalAdjustment?: boolean;
}): { baseAmount: number; quoteAmount: number } {
  const {
    strategy,
    binStep,
    activePrice,
    lowerPrice,
    upperPrice,
    known,
    amount,
    baseDecimals = 9,
    quoteDecimals = 6,
    applyDecimalAdjustment = true,
  } = options;

  if (!(amount > 0) || !(binStep > 0) || !(activePrice > 0) || !(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
    return known === 'base'
      ? { baseAmount: amount, quoteAmount: 0 }
      : { baseAmount: 0, quoteAmount: amount };
  }

  const minId = getIdFromPrice(lowerPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const maxId = getIdFromPrice(upperPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const activeBinId = getIdFromPrice(activePrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);

  let quoteBinsCount: number;
  let baseBinsCount: number;
  if (activeBinId < minId) {
    quoteBinsCount = 0;
    baseBinsCount = maxId - minId + 1;
  } else if (activeBinId > maxId) {
    quoteBinsCount = maxId - minId + 1;
    baseBinsCount = 0;
  } else {
    quoteBinsCount = activeBinId - minId + 1;
    baseBinsCount = maxId - activeBinId;
  }

  if (baseBinsCount > 0 && quoteBinsCount === 0) {
    return known === 'base' ? { baseAmount: amount, quoteAmount: 0 } : { baseAmount: 0, quoteAmount: 0 };
  }
  if (quoteBinsCount > 0 && baseBinsCount === 0) {
    return known === 'quote' ? { baseAmount: 0, quoteAmount: amount } : { baseAmount: 0, quoteAmount: 0 };
  }
  if (quoteBinsCount <= 0 || baseBinsCount <= 0) {
    return { baseAmount: 0, quoteAmount: 0 };
  }

  let quoteSumWeight = 0;
  let baseSumWeightOverPrice = 0;
  if (strategy === 'spot') {
    for (let id = minId; id <= maxId; id++) {
      if (id > activeBinId) {
        const price = getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        if (price > 0) baseSumWeightOverPrice += 1 / price;
      }
    }
    quoteSumWeight = quoteBinsCount;
  } else {
    for (let id = minId; id <= activeBinId; id++) {
      const dist = activeBinId - id;
      quoteSumWeight += strategy === 'curve'
        ? Math.max(1, activeBinId - minId - dist)
        : dist + 1;
    }
    for (let id = activeBinId + 1; id <= maxId; id++) {
      const dist = id - activeBinId;
      const weight = strategy === 'curve'
        ? Math.max(1, maxId - activeBinId - dist)
        : dist + 1;
      const price = getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      if (price > 0) baseSumWeightOverPrice += weight / price;
    }
  }

  if (!(quoteSumWeight > 0) || !(baseSumWeightOverPrice > 0)) {
    return known === 'base'
      ? { baseAmount: amount, quoteAmount: 0 }
      : { baseAmount: 0, quoteAmount: amount };
  }

  if (known === 'base') {
    return { baseAmount: amount, quoteAmount: amount * (quoteSumWeight / baseSumWeightOverPrice) };
  }
  return { baseAmount: amount * (baseSumWeightOverPrice / quoteSumWeight), quoteAmount: amount };
}

export function getInitialBins(params: SimulationParams): SimulatedBin[] {
  const { binStep, initialPrice, baseAmount, quoteAmount, lowerPrice, upperPrice, strategy } = params;

  // Extract decimals with defaults
  const baseDecimals = params.baseDecimals ?? 9;
  const quoteDecimals = params.quoteDecimals ?? 6;
  const applyDecimalAdjustment = params.applyDecimalAdjustment ?? true;

  if (lowerPrice <= 0 || upperPrice <= lowerPrice || binStep <= 0 || initialPrice <= 0) {
    return [];
  }

  // Calculate bin range using SDK-accurate formulas with decimals
  const minId = getIdFromPrice(lowerPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const maxId = getIdFromPrice(upperPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const activeBinId = getIdFromPrice(initialPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);

  const priceValid = activeBinId >= minId && activeBinId <= maxId;
  if (!priceValid) {
     // Allow for out of range initial price for one-sided liquidity
  }

  // Calculate strategy weights for all bins
  const weights = calculateStrategyWeights(strategy, minId, maxId, activeBinId);

  // Build price map for all bins
  const binPrices = new Map<number, number>();
  for (let id = minId; id <= maxId; id++) {
    const price = getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    binPrices.set(id, price);
  }

  // Convert weights to token amounts
  const amounts = weightsToAmounts(
    weights,
    baseAmount,
    quoteAmount,
    activeBinId,
    binPrices,
    strategy,
    initialPrice
  );

  // Build bins array
  let bins: SimulatedBin[] = [];

  for (let id = minId; id <= maxId; id++) {
    const price = binPrices.get(id)!;
    const amount = amounts.get(id) || { baseAmount: 0, quoteAmount: 0, valueInQuote: 0 };

    const isQuoteBin = id <= activeBinId;
    const tokenType = isQuoteBin ? 'quote' : 'base';
    const tokenAmount = isQuoteBin ? amount.quoteAmount : amount.baseAmount;

    // Calculate price per lamport for SDK compatibility
    const decimalAdjustment = quoteDecimals - baseDecimals;
    const pricePerLamport = new Decimal(price).mul(Decimal.pow(10, decimalAdjustment)).toNumber();

    bins.push({
      id,
      price,
      pricePerLamport,
      initialTokenType: tokenType,
      initialAmount: tokenAmount,
      initialValueInQuote: amount.valueInQuote,
      initialDisplayValue: tokenType === 'base' ? tokenAmount * price : tokenAmount,
      currentTokenType: tokenType,
      currentAmount: tokenAmount,
      currentValueInQuote: amount.valueInQuote,
    });
  }

  // Normalization step to correct for floating point inaccuracies
  // This ensures the total amounts exactly match user input
  const calculatedBaseSum = bins.reduce((sum, bin) => bin.initialTokenType === 'base' ? sum + bin.initialAmount : sum, 0);
  const calculatedQuoteSum = bins.reduce((sum, bin) => bin.initialTokenType === 'quote' ? sum + bin.initialAmount : sum, 0);

  if (baseAmount > 0 && calculatedBaseSum > 0) {
    const baseCorrectionFactor = baseAmount / calculatedBaseSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'base') {
        bin.initialAmount *= baseCorrectionFactor;
        // Always calculate market value at initial price for P&L
        bin.initialValueInQuote = bin.initialAmount * initialPrice;
      }
    });
  }

  if (quoteAmount > 0 && calculatedQuoteSum > 0) {
    const quoteCorrectionFactor = quoteAmount / calculatedQuoteSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'quote') {
        bin.initialAmount *= quoteCorrectionFactor;
        bin.initialValueInQuote = bin.initialAmount;
      }
    });
  }

  bins.forEach(refreshInitialDisplayValue);
  return bins.sort((a, b) => a.price - b.price);
}

export interface BinRangeParams {
  binStep: number;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  baseAmount: number;
  quoteAmount: number;
  strategy: Strategy;
  baseDecimals?: number;
  quoteDecimals?: number;
  applyDecimalAdjustment?: boolean;
}

/**
 * Builds initial bins from explicit bin IDs (used for live wallet positions).
 * Avoids price→bin round-trip so the reconstructed range matches on-chain bins.
 */
export function getInitialBinsForBinRange(params: BinRangeParams): SimulatedBin[] {
  const { binStep, minBinId, maxBinId, activeBinId, baseAmount, quoteAmount, strategy } = params;
  const baseDecimals = params.baseDecimals ?? 9;
  const quoteDecimals = params.quoteDecimals ?? 6;
  const applyDecimalAdjustment = params.applyDecimalAdjustment ?? true;

  if (binStep <= 0 || maxBinId < minBinId) {
    return [];
  }

  const weights = calculateStrategyWeights(strategy, minBinId, maxBinId, activeBinId);
  const binPrices = new Map<number, number>();
  for (let id = minBinId; id <= maxBinId; id++) {
    binPrices.set(id, getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment));
  }

  const initialPrice = binPrices.get(activeBinId) ?? getPriceFromId(
    activeBinId,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment
  );

  if (initialPrice <= 0) {
    return [];
  }

  const amounts = weightsToAmounts(
    weights,
    baseAmount,
    quoteAmount,
    activeBinId,
    binPrices,
    strategy,
    initialPrice
  );

  const bins: SimulatedBin[] = [];
  for (let id = minBinId; id <= maxBinId; id++) {
    const price = binPrices.get(id)!;
    const amount = amounts.get(id) || { baseAmount: 0, quoteAmount: 0, valueInQuote: 0 };
    const isQuoteBin = id <= activeBinId;
    const tokenType = isQuoteBin ? 'quote' : 'base';
    const tokenAmount = isQuoteBin ? amount.quoteAmount : amount.baseAmount;
    const decimalAdjustment = quoteDecimals - baseDecimals;
    const pricePerLamport = new Decimal(price).mul(Decimal.pow(10, decimalAdjustment)).toNumber();

    bins.push({
      id,
      price,
      pricePerLamport,
      initialTokenType: tokenType,
      initialAmount: tokenAmount,
      initialValueInQuote: amount.valueInQuote,
      initialDisplayValue: tokenType === 'base' ? tokenAmount * price : tokenAmount,
      currentTokenType: tokenType,
      currentAmount: tokenAmount,
      currentValueInQuote: amount.valueInQuote,
    });
  }

  const calculatedBaseSum = bins.reduce((sum, bin) => bin.initialTokenType === 'base' ? sum + bin.initialAmount : sum, 0);
  const calculatedQuoteSum = bins.reduce((sum, bin) => bin.initialTokenType === 'quote' ? sum + bin.initialAmount : sum, 0);

  if (baseAmount > 0 && calculatedBaseSum > 0) {
    const baseCorrectionFactor = baseAmount / calculatedBaseSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'base') {
        bin.initialAmount *= baseCorrectionFactor;
        bin.initialValueInQuote = bin.initialAmount * initialPrice;
        bin.currentAmount = bin.initialAmount;
        bin.currentValueInQuote = bin.initialValueInQuote;
      }
    });
  }

  if (quoteAmount > 0 && calculatedQuoteSum > 0) {
    const quoteCorrectionFactor = quoteAmount / calculatedQuoteSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'quote') {
        bin.initialAmount *= quoteCorrectionFactor;
        bin.initialValueInQuote = bin.initialAmount;
        bin.currentAmount = bin.initialAmount;
        bin.currentValueInQuote = bin.initialValueInQuote;
      }
    });
  }

  bins.forEach(refreshInitialDisplayValue);
  return bins.sort((a, b) => a.price - b.price);
}


export interface MergeBinsOptions {
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  activeBinId: number;
  fillGaps?: boolean;
  maxFilledBins?: number;
  /** Force the filled span even when no liquidity sits on the edge bins. */
  spanMinId?: number;
  spanMaxId?: number;
}

/**
 * Overlays multiple position bin arrays onto a single distribution.
 * Amounts on the same bin ID are summed so several positions in one pool
 * can be simulated together.
 */
export function mergeSimulatedBins(
  binSets: SimulatedBin[][],
  options: MergeBinsOptions
): SimulatedBin[] {
  const merged = new Map<number, SimulatedBin>();

  for (const bins of binSets) {
    for (const bin of bins) {
      const existing = merged.get(bin.id);
      if (!existing) {
        merged.set(bin.id, { ...bin, initialDisplayValue: binInitialDisplayValue(bin) });
        continue;
      }
      accumulateSimulatedBin(existing, bin);
    }
  }

  if (merged.size === 0 && (options.spanMinId == null || options.spanMaxId == null)) return [];

  const ids = Array.from(merged.keys()).sort((a, b) => a - b);
  let minId = ids.length ? ids[0] : options.spanMinId!;
  let maxId = ids.length ? ids[ids.length - 1] : options.spanMaxId!;
  if (typeof options.spanMinId === 'number') minId = Math.min(minId, options.spanMinId);
  if (typeof options.spanMaxId === 'number') maxId = Math.max(maxId, options.spanMaxId);
  const span = maxId - minId + 1;
  const maxFilled = options.maxFilledBins ?? 500;
  const shouldFill = options.fillGaps !== false && span <= maxFilled;

  const result: SimulatedBin[] = [];
  if (!shouldFill) {
    return ids.map(id => merged.get(id)!);
  }

  for (let id = minId; id <= maxId; id++) {
    const existing = merged.get(id);
    if (existing) {
      result.push(existing);
      continue;
    }
    const price = getPriceFromId(
      id,
      options.binStep,
      options.baseDecimals,
      options.quoteDecimals,
      options.applyDecimalAdjustment
    );
    const decimalAdjustment = options.quoteDecimals - options.baseDecimals;
    const pricePerLamport = new Decimal(price).mul(Decimal.pow(10, decimalAdjustment)).toNumber();
    const isQuote = id <= options.activeBinId;
    result.push({
      id,
      price,
      pricePerLamport,
      initialTokenType: isQuote ? 'quote' : 'base',
      initialAmount: 0,
      initialValueInQuote: 0,
      initialDisplayValue: 0,
      currentTokenType: isQuote ? 'quote' : 'base',
      currentAmount: 0,
      currentValueInQuote: 0,
    });
  }

  return result;
}

/**
 * Drop zero-liquidity bins on the low and high ends of a distribution.
 * Interior gaps are kept so overlapping/disjoint ranges still show as a continuous axis.
 */
export function trimEmptyEdgeBins(bins: SimulatedBin[]): SimulatedBin[] {
  if (bins.length === 0) return bins;
  const hasLiquidity = (bin: SimulatedBin) =>
    bin.initialAmount > EMPTY_BIN_EPSILON || bin.initialValueInQuote > EMPTY_BIN_EPSILON;

  let start = 0;
  let end = bins.length - 1;
  while (start <= end && !hasLiquidity(bins[start])) start += 1;
  while (end >= start && !hasLiquidity(bins[end])) end -= 1;
  if (start === 0 && end === bins.length - 1) return bins;
  return bins.slice(start, end + 1);
}



/**
 * Runs a position simulation at a different price point
 *
 * This simulates how the position's bins convert between base and quote tokens
 * as the market price moves. The decimal parameters are optional since bins already
 * contain prices calculated with the correct decimal adjustments.
 *
 * @param initialBins - The initial bin distribution
 * @param currentPrice - The current market price to simulate at
 * @param initialPrice - The original position price (for reference)
 * @param baseDecimals - Base token decimals (optional, for validation)
 * @param quoteDecimals - Quote token decimals (optional, for validation)
 * @returns Simulated bins and analysis
 */
export function runSimulation(
  initialBins: SimulatedBin[],
  currentPrice: number,
  initialPrice: number,
  baseDecimals: number = 9,
  quoteDecimals: number = 6
): { simulatedBins: SimulatedBin[], analysis: Analysis } {
  if (!initialBins || initialBins.length === 0) {
    return {
      simulatedBins: [],
      analysis: { totalValueInQuote: 0, totalBase: 0, totalQuote: 0, totalBins: 0, baseBins: 0, quoteBins: 0 }
    };
  }

  const simulatedBins = initialBins.map(bin => {
    const simBin: SimulatedBin = JSON.parse(JSON.stringify(bin)); // Deep copy

    if (simBin.initialAmount <= 0) {
      simBin.currentAmount = 0;
      simBin.currentValueInQuote = 0;
      simBin.currentTokenType = simBin.initialTokenType;
      return simBin;
    }

    // Determine current token type based on price
    if (currentPrice >= simBin.price) { // Price at or above the bin, should be quote
        simBin.currentTokenType = 'quote';
        if (simBin.initialTokenType === 'base') {
            // Base converted to quote at bin price
            simBin.currentAmount = simBin.initialAmount * simBin.price;
        } else {
            simBin.currentAmount = simBin.initialAmount;
        }
    } else { // Price below the bin, should be base
        simBin.currentTokenType = 'base';
        if (simBin.initialTokenType === 'quote') {
            // Quote converted to base at bin price
            simBin.currentAmount = simBin.initialAmount / simBin.price;
        } else {
            simBin.currentAmount = simBin.initialAmount;
        }
    }

    // Value the current holdings at current market price
    if (simBin.currentTokenType === 'base') {
        simBin.currentValueInQuote = simBin.currentAmount * currentPrice;
    } else {
        simBin.currentValueInQuote = simBin.currentAmount;
    }

    // Display values are derived at render time, not stored in bins

    return simBin;
  });

  const analysis = simulatedBins.reduce<Analysis>((acc, bin) => {
      if (bin.currentAmount > 1e-12) { // Tolerance for floating point dust
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
  }, { totalValueInQuote: 0, totalBase: 0, totalQuote: 0, totalBins: initialBins.filter(b => b.initialAmount > 0).length, baseBins: 0, quoteBins: 0 });

  return { simulatedBins, analysis };
}
