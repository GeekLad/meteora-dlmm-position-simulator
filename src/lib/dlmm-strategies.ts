/**
 * DLMM Strategy Calculations
 *
 * Implements SDK-accurate liquidity distribution strategies for DLMM positions.
 * These strategies determine how liquidity is weighted across price bins.
 *
 * Reference: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk
 */

import type { Strategy } from './dlmm';

/**
 * Calculates weight distribution for a given strategy
 *
 * Weights determine how tokens are distributed across bins. Higher weights
 * mean more liquidity allocated to that bin.
 *
 * Loops are always clamped to [minBinId, maxBinId]. Quote vs base is still
 * split at the real active bin (id <= activeBinId is quote), so one-sided
 * deposits work when the active price has moved outside the position range.
 *
 * @param strategy - The distribution strategy to use
 * @param minBinId - Lower bound bin ID
 * @param maxBinId - Upper bound bin ID
 * @param activeBinId - Current/initial price bin ID
 * @returns Map of bin ID to weight value
 */
export function calculateStrategyWeights(
  strategy: Strategy,
  minBinId: number,
  maxBinId: number,
  activeBinId: number
): Map<number, number> {
  const weights = new Map<number, number>();
  if (maxBinId < minBinId) return weights;

  // Bins at or below the real active price hold quote; above hold base.
  const quoteHi = Math.min(activeBinId, maxBinId);
  const baseLo = Math.max(activeBinId + 1, minBinId);
  // Shape is relative to the in-range edge when the active price is out of range.
  const shapeActive = Math.min(maxBinId, Math.max(minBinId, activeBinId));

  switch (strategy) {
    case 'spot': {
      for (let id = minBinId; id <= maxBinId; id++) {
        weights.set(id, 1);
      }
      break;
    }

    case 'bid-ask': {
      // More weight farther from the active price (V shape / order-book ends).
      for (let id = minBinId; id <= quoteHi; id++) {
        weights.set(id, shapeActive - id + 1);
      }
      for (let id = baseLo; id <= maxBinId; id++) {
        weights.set(id, id - shapeActive + 1);
      }
      break;
    }

    case 'curve': {
      // More weight toward the in-range side nearest the active price.
      for (let id = minBinId; id <= quoteHi; id++) {
        weights.set(id, id - minBinId + 1);
      }
      for (let id = baseLo; id <= maxBinId; id++) {
        weights.set(id, maxBinId - id + 1);
      }
      break;
    }
  }

  return weights;
}

/**
 * Converts strategy weights to actual token amounts
 *
 * This function takes the weight distribution and converts it to concrete
 * token amounts while ensuring the total matches user-specified inputs.
 *
 * @param weights - Map of bin ID to weight
 * @param totalBaseAmount - Total base tokens to distribute
 * @param totalQuoteAmount - Total quote tokens to distribute
 * @param activeBinId - Active price bin ID
 * @param binPrices - Map of bin ID to price
 * @param strategy - The strategy being used (affects base token distribution)
 * @param initialPrice - Initial price for value calculations
 * @returns Map of bin ID to token amounts
 */
export function weightsToAmounts(
  weights: Map<number, number>,
  totalBaseAmount: number,
  totalQuoteAmount: number,
  activeBinId: number,
  binPrices: Map<number, number>,
  strategy: Strategy,
  initialPrice: number
): Map<number, { baseAmount: number; quoteAmount: number; valueInQuote: number }> {
  const amounts = new Map<number, { baseAmount: number; quoteAmount: number; valueInQuote: number }>();

  // Separate quote and base bins
  const quoteBins = Array.from(weights.keys()).filter(id => id <= activeBinId);
  const baseBins = Array.from(weights.keys()).filter(id => id > activeBinId);

  // Calculate total weights for each side
  const totalQuoteWeight = quoteBins.reduce((sum, id) => sum + weights.get(id)!, 0);
  const totalBaseWeight = baseBins.reduce((sum, id) => sum + weights.get(id)!, 0);

  // Distribute quote tokens (proportional to weight)
  if (totalQuoteWeight > 0 && totalQuoteAmount > 0) {
    quoteBins.forEach(id => {
      const weight = weights.get(id)!;
      const amount = (totalQuoteAmount * weight) / totalQuoteWeight;
      amounts.set(id, {
        baseAmount: 0,
        quoteAmount: amount,
        valueInQuote: amount // Quote tokens have 1:1 value with quote
      });
    });
  } else {
    // Set zero amounts for quote bins if no quote tokens
    quoteBins.forEach(id => {
      amounts.set(id, { baseAmount: 0, quoteAmount: 0, valueInQuote: 0 });
    });
  }

  // Distribute base tokens
  if (totalBaseWeight > 0 && totalBaseAmount > 0) {
    if (strategy === 'spot') {
      // Spot strategy: equal value per bin
      // For two-sided positions: match the quote bin value
      // For one-sided base positions: distribute base tokens equally by value
      let constantValue: number;

      if (quoteBins.length > 0 && totalQuoteAmount > 0) {
        // Two-sided: match quote bin value
        constantValue = totalQuoteAmount / quoteBins.length;
      } else {
        // One-sided base position: calculate value from base tokens
        // Total value divided by number of base bins
        constantValue = (totalBaseAmount * initialPrice) / baseBins.length;
      }

      baseBins.forEach(id => {
        const binPrice = binPrices.get(id)!;
        const amount = constantValue / binPrice;
        amounts.set(id, {
          baseAmount: amount,
          quoteAmount: 0,
          valueInQuote: amount * initialPrice  // Value at market price for P&L
        });
      });
    } else {
      // Bid-ask and curve strategies: distribute based on value at initial price
      const totalValue = totalBaseAmount * initialPrice;

      baseBins.forEach(id => {
        const weight = weights.get(id)!;
        const binPrice = binPrices.get(id)!;

        // Calculate target value for this bin based on weight
        const targetValue = totalValue * (weight / totalBaseWeight);

        // Convert value to base token amount at bin price
        const amount = targetValue / binPrice;

        amounts.set(id, {
          baseAmount: amount,
          quoteAmount: 0,
          valueInQuote: targetValue
        });
      });
    }
  } else {
    // Set zero amounts for base bins if no base tokens
    baseBins.forEach(id => {
      amounts.set(id, { baseAmount: 0, quoteAmount: 0, valueInQuote: 0 });
    });
  }

  return amounts;
}

/**
 * Maps our strategy names to SDK strategy types (for reference/documentation)
 *
 * Note: This is primarily for documentation. We implement the strategies
 * ourselves rather than using SDK enums directly.
 */
export function getStrategyDescription(strategy: Strategy): string {
  switch (strategy) {
    case 'spot':
      return 'Uniform distribution - Equal value across all bins';
    case 'bid-ask':
      return 'Bid-Ask - Concentrated toward current price (higher liquidity near active bin)';
    case 'curve':
      return 'Curve - Concentrated at edges (higher liquidity away from active bin)';
    default:
      return 'Unknown strategy';
  }
}
