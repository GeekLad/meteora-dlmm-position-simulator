

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
  displayValue: number;
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
      displayValue: amount.valueInQuote, // For chart visualization
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
        // Preserve the distribution's value structure
        if (strategy === 'spot') {
          // For spot: maintain equal value per bin at bin price
          bin.initialValueInQuote = bin.initialAmount * bin.price;
        } else {
          // For bid-ask/curve: maintain market-price-based valuation
          bin.initialValueInQuote *= baseCorrectionFactor;
        }
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

  // Set displayValue for chart visualization. This MUST reflect the initial quote value.
  bins.forEach(bin => {
    bin.displayValue = bin.initialValueInQuote;
  });

  return bins.sort((a, b) => a.price - b.price);
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
      simBin.displayValue = 0;
      return simBin;
    }

    // Determine current token type based on price
    if (currentPrice > simBin.price) { // Price moved above the bin, should be quote
        simBin.currentTokenType = 'quote';
        if (simBin.initialTokenType === 'base') {
            // Base converted to quote at bin price
            simBin.currentAmount = simBin.initialAmount * simBin.price;
        } else {
            simBin.currentAmount = simBin.initialAmount;
        }
    } else { // Price at or below the bin, should be base
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

    // The displayValue from getInitialBins is static and represents the initial distribution shape.
    // We don't change it during simulation.

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
