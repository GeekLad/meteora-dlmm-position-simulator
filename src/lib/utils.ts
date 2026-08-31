
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(
  value: number,
  maximumFractionDigits = 4
): string {
    if (typeof value !== 'number' || !isFinite(value)) {
        return "0";
    }

    if (value === 0) return "0";

    // Intl.NumberFormat only accepts 0–20 fraction digits
    const fractionDigits = Number.isFinite(maximumFractionDigits)
      ? Math.min(20, Math.max(0, Math.floor(maximumFractionDigits)))
      : 4;

    const absoluteValue = Math.abs(value);

    if (absoluteValue > 0 && absoluteValue < 1) {
        let leadingZeros = 0;
        const match = absoluteValue.toExponential().match(/e-(\d+)/);
        if (match) {
            leadingZeros = parseInt(match[1], 10);
        }

        const requestedDigits = fractionDigits + leadingZeros;
        if (requestedDigits > 20) {
            return value.toExponential(Math.min(6, fractionDigits));
        }

        const effectiveDigits = Math.max(2, requestedDigits);

        let formatted = value.toLocaleString('en-US', {
            maximumFractionDigits: effectiveDigits,
            minimumFractionDigits: Math.min(2, effectiveDigits),
            useGrouping: false,
        });

        // Remove trailing zeros, but keep at least 2 decimal places if it's a decimal number
        formatted = formatted.replace(/(\.[0-9]*[1-9])0+$/, '$1');
        if (formatted.endsWith('.00') && formatted.length > 3) {
           formatted = formatted.slice(0, -1); 
        }

        return formatted;
    }

    return value.toLocaleString('en-US', {
        maximumFractionDigits: fractionDigits,
        useGrouping: false,
    });
}

export function formatPrice(price: number, precision: number): string {
  if (typeof price !== 'number' || !isFinite(price)) {
    return '0';
  }
  return price.toFixed(precision);
}

    