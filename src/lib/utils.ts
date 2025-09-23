
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

    const absoluteValue = Math.abs(value);

    if (absoluteValue > 0 && absoluteValue < 1) {
        let tempValue = absoluteValue;
        let leadingZeros = 0;
        if (tempValue < 1) {
            const match = tempValue.toExponential().match(/e-(\d+)/);
            if (match) {
                leadingZeros = parseInt(match[1], 10);
            }
        }
        
        const effectiveDigits = maximumFractionDigits + leadingZeros;
        
        let formatted = value.toLocaleString('en-US', {
            maximumFractionDigits: effectiveDigits,
            minimumFractionDigits: 2,
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
        maximumFractionDigits: maximumFractionDigits,
        useGrouping: false,
    });
}

export function formatPrice(price: number, precision: number): string {
  if (typeof price !== 'number' || !isFinite(price)) {
    return '0';
  }
  return price.toFixed(precision);
}

    