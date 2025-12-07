/**
 * Meteora DLMM SDK Wrapper
 *
 * Provides browser-safe wrapper around the Meteora DLMM SDK for calculation purposes.
 * This module exposes only static calculation methods without requiring blockchain connections.
 *
 * Reference: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/sdk-functions
 */

import Decimal from 'decimal.js';

/**
 * Converts a bin ID to a human-readable price using SDK-accurate formulas
 *
 * The DLMM system uses a logarithmic price model where each bin ID represents a discrete price level.
 * Formula: price = (1 + binStep/10000)^(id - reference_point)
 *
 * @param binId - The bin ID to convert
 * @param binStep - The bin step in basis points (e.g., 25 = 0.25%)
 * @param baseDecimals - Number of decimals for the base token (default: 9 for SOL)
 * @param quoteDecimals - Number of decimals for the quote token (default: 6 for USDC)
 * @returns Human-readable price adjusted for token decimals
 *
 * @example
 * // For SOL/USDC (9/6 decimals) at bin step 25
 * const price = getPriceFromBinId(262144, 25, 9, 6); // Returns 1.0 (reference point)
 */
export function getPriceFromBinId(
   binId: number,
   binStep: number,
   baseDecimals: number = 9,
   quoteDecimals: number = 6,
   applyDecimalAdjustment: boolean = true
 ): number {
   // Calculate the basis (price multiplier per bin)
   const basis = 1 + binStep / 10000;

   // Reference point where price = 1.0 (in lamport terms)
   // The Meteora SDK uses bin ID 262144 as the reference point
   const REFERENCE_BIN_ID = 262144;

   // Calculate price per lamport using exponential formula
   const exponent = binId - REFERENCE_BIN_ID;
   const pricePerLamport = Math.pow(basis, exponent);

   let price = pricePerLamport;

   if (applyDecimalAdjustment) {
     // Adjust for token decimals
     // The exponential formula gives price in "normalized" terms
     // We need to adjust based on decimal difference
     const decimalAdjustment = baseDecimals - quoteDecimals;
     price = new Decimal(pricePerLamport)
       .mul(Decimal.pow(10, decimalAdjustment))
       .toNumber();
   }

   return price;
 }

/**
 * Converts a human-readable price to a bin ID using SDK-accurate formulas
 *
 * This is the inverse of getPriceFromBinId, using logarithmic calculation to find
 * the discrete bin that corresponds to a given price level.
 *
 * @param price - The human-readable price to convert
 * @param binStep - The bin step in basis points (e.g., 25 = 0.25%)
 * @param baseDecimals - Number of decimals for the base token (default: 9 for SOL)
 * @param quoteDecimals - Number of decimals for the quote token (default: 6 for USDC)
 * @param roundUp - If true, round up to next bin; otherwise round down
 * @returns The bin ID corresponding to the price
 *
 * @example
 * // Find the bin ID for SOL price of $100 (USDC)
 * const binId = getBinIdFromPrice(100, 25, 9, 6, false);
 */
export function getBinIdFromPrice(
   price: number,
   binStep: number,
   baseDecimals: number = 9,
   quoteDecimals: number = 6,
   applyDecimalAdjustment: boolean = true
 ): number {
   if (price <= 0 || binStep <= 0) {
     console.warn('Invalid price or binStep:', { price, binStep });
     return 0;
   }

   // Reference point where price = 1.0
   const REFERENCE_BIN_ID = 262144;

   let pricePerLamport = price;

   if (applyDecimalAdjustment) {
     // Convert human price to lamport price
     // Reverse the decimal adjustment from getPriceFromBinId
     const decimalAdjustment = baseDecimals - quoteDecimals;
     pricePerLamport = new Decimal(price)
       .mul(Decimal.pow(10, -decimalAdjustment))
       .toNumber();
   }

   // Calculate bin ID using logarithm
   const basis = 1 + binStep / 10000;
   const exponent = Math.log(pricePerLamport) / Math.log(basis);

   // Round to nearest bin for better accuracy
   const binId = Math.round(exponent);

   const finalBinId = binId + REFERENCE_BIN_ID;

   return finalBinId;
 }

/**
 * Validates if a bin ID is within valid range
 *
 * DLMM bin IDs have theoretical limits based on the bit size used in the protocol.
 * This helps prevent overflow errors in calculations.
 *
 * @param binId - The bin ID to validate
 * @returns True if the bin ID is valid
 */
export function isValidBinId(binId: number): boolean {
  // Bin IDs are stored as i32 in the protocol
  const MIN_BIN_ID = -2147483648; // i32 min
  const MAX_BIN_ID = 2147483647;  // i32 max

  return binId >= MIN_BIN_ID && binId <= MAX_BIN_ID;
}

/**
 * Calculates the price range for a given bin
 *
 * Each bin represents a discrete price range where liquidity can be active.
 * This returns the lower and upper price boundaries for a bin.
 *
 * @param binId - The bin ID
 * @param binStep - The bin step in basis points
 * @param baseDecimals - Base token decimals
 * @param quoteDecimals - Quote token decimals
 * @returns Object with lower and upper price bounds
 */
export function getBinPriceRange(
  binId: number,
  binStep: number,
  baseDecimals: number = 9,
  quoteDecimals: number = 6
): { lower: number; upper: number; mid: number } {
  const mid = getPriceFromBinId(binId, binStep, baseDecimals, quoteDecimals);
  const lower = getPriceFromBinId(binId, binStep, baseDecimals, quoteDecimals);
  const upper = getPriceFromBinId(binId + 1, binStep, baseDecimals, quoteDecimals);

  return { lower, upper, mid };
}

/**
 * Token registry mapping contract addresses to decimal values
 *
 * This is the authoritative source for token decimals on Solana.
 * Used when decimal information is not available from the API.
 */
export const TOKEN_DECIMALS_BY_ADDRESS: Record<string, number> = {
  // Native Solana
  'So11111111111111111111111111111111111111112': 9, // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
};

/**
 * Legacy symbol-based lookup (for backward compatibility)
 */
export const COMMON_TOKEN_DECIMALS: Record<string, number> = {
  'SOL': 9,
  'WSOL': 9,
  'USDC': 6,
};

/**
 * Gets token decimals by contract address
 *
 * @param address - Token contract address
 * @param defaultDecimals - Fallback if address not found
 * @returns Decimal count for the token
 */
export function getTokenDecimalsByAddress(
  address: string,
  defaultDecimals: number = 9
): number {
  return TOKEN_DECIMALS_BY_ADDRESS[address] ?? defaultDecimals;
}

/**
 * Attempts to infer token decimals from symbol (legacy function)
 *
 * @param symbol - Token symbol (e.g., 'SOL', 'USDC')
 * @param defaultDecimals - Fallback if symbol not found
 * @returns Inferred decimal count
 */
export function inferTokenDecimals(
  symbol: string,
  defaultDecimals: number = 9
): number {
  const upperSymbol = symbol.toUpperCase().trim();
  return COMMON_TOKEN_DECIMALS[upperSymbol] ?? defaultDecimals;
}

/**
 * Reverse engineers token decimals by finding the combination that makes API price closest to a bin price
 *
 * Uses known token addresses to determine decimals, then finds the best decimal adjustment.
 *
 * @param apiPrice - The current_price from the API
 * @param binStep - The bin step from the API
 * @param mintX - Token X (base token) contract address
 * @param mintY - Token Y (quote token) contract address
 * @returns Object with inferred base and quote decimals, and whether to apply decimal adjustments
 */
export function reverseEngineerDecimals(
  apiPrice: number,
  binStep: number,
  mintX: string,
  mintY: string
): { baseDecimals: number; quoteDecimals: number; applyDecimalAdjustment: boolean } {
  // Get decimals from known token addresses
  const baseDecimalsFromAddress = getTokenDecimalsByAddress(mintX, 9);
  const quoteDecimalsFromAddress = getTokenDecimalsByAddress(mintY, 6);

  // If we have both decimals from addresses, use them directly
  if (TOKEN_DECIMALS_BY_ADDRESS[mintX] !== undefined && TOKEN_DECIMALS_BY_ADDRESS[mintY] !== undefined) {
    return {
      baseDecimals: baseDecimalsFromAddress,
      quoteDecimals: quoteDecimalsFromAddress,
      applyDecimalAdjustment: true
    };
  }

  // Try different base decimals (0-18 is the typical range)
  let bestBaseDecimals = 9; // Default to SOL
  let bestApplyAdjustment = true;
  let smallestDifference = Infinity;

  // If we only know one token, fall back to reverse engineering
  let assumedQuoteDecimals = quoteDecimalsFromAddress;
  let testBaseDecimals = [baseDecimalsFromAddress];

  // If we don't know the base token, try a range of possible decimals
  if (TOKEN_DECIMALS_BY_ADDRESS[mintX] === undefined) {
    for (let d = Math.max(0, baseDecimalsFromAddress - 3); d <= Math.min(18, baseDecimalsFromAddress + 3); d++) {
      if (!testBaseDecimals.includes(d)) {
        testBaseDecimals.push(d);
      }
    }
  }

  // Test each decimal combination
  for (const baseDecimals of testBaseDecimals) {
    try {
      // Try both with and without decimal adjustment to find the best fit
      for (const useAdjustment of [true, false]) {
        // Calculate which bin the API price would map to
        const binId = getBinIdFromPrice(apiPrice, binStep, baseDecimals, assumedQuoteDecimals, useAdjustment);

        // Get the exact price of that bin
        const binPrice = getPriceFromBinId(binId, binStep, baseDecimals, assumedQuoteDecimals, useAdjustment);

        // Calculate difference (compare against original API price)
        const difference = Math.abs(apiPrice - binPrice);

        if (difference < smallestDifference) {
          smallestDifference = difference;
          bestBaseDecimals = baseDecimals;
          bestApplyAdjustment = useAdjustment;
        }
      }
    } catch (error) {
      // Skip invalid combinations
      continue;
    }
  }

  return {
    baseDecimals: bestBaseDecimals,
    quoteDecimals: assumedQuoteDecimals,
    applyDecimalAdjustment: bestApplyAdjustment
  };
}
