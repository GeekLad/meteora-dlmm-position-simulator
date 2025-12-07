/**
 * Display Formatting Utilities
 *
 * Transforms pristine calculation values into formatted strings for display.
 * NEVER use these functions in calculation paths - they are for display only.
 */

import { formatNumber } from './utils';

export interface NumberDisplayOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  useSubscriptNotation?: boolean;
  compact?: boolean;
}

/**
 * Formats a number for display with appropriate precision.
 * Returns a string - never use the result in calculations.
 *
 * @param value - Pristine calculation value
 * @param options - Display options
 * @returns Formatted string (NOT a number)
 */
export function formatNumberForDisplay(
  value: number,
  options: NumberDisplayOptions = {}
): string {
  const {
    maximumFractionDigits = 4,
    minimumFractionDigits = 2,
    useSubscriptNotation = true,
    compact = false
  } = options;

  if (!isFinite(value)) return '0';

  // Handle very small numbers with subscript notation
  if (useSubscriptNotation && value > 0 && value < 0.001) {
    const s = value.toFixed(20);
    const firstDigitIndex = s.search(/[1-9]/);
    const numZeros = firstDigitIndex - 2;
    if (numZeros >= 3) {
      const remainingDigits = s.substring(firstDigitIndex, firstDigitIndex + (compact ? 3 : 7));
      return `0.0₍${numZeros}₎${remainingDigits}`;
    }
  }

  return formatNumber(value, maximumFractionDigits);
}

/**
 * Formats a price for display with appropriate decimal precision.
 *
 * @param price - Pristine price value
 * @param quoteDecimals - Quote token decimals (for precision)
 * @returns Formatted price string
 */
export function formatPriceForDisplay(price: number, quoteDecimals: number): string {
  const significantDecimals = Math.max(quoteDecimals, 6);
  return formatNumberForDisplay(price, { maximumFractionDigits: significantDecimals });
}

/**
 * Formats a token amount for display with appropriate decimal precision.
 *
 * @param amount - Pristine amount value
 * @param tokenDecimals - Token decimals
 * @returns Formatted amount string
 */
export function formatTokenAmountForDisplay(amount: number, tokenDecimals: number): string {
  const displayDecimals = Math.max(tokenDecimals, 2);
  return formatNumberForDisplay(amount, { maximumFractionDigits: displayDecimals });
}
