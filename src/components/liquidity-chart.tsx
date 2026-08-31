
"use client"

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { type SimulatedBin, getIdFromPrice, getPriceFromId, binInitialDisplayValue, type Strategy } from "@/lib/dlmm";
import { cn, formatNumber } from "@/lib/utils";
import { useDlmmContext } from "./dlmm-simulator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ResetToInitialButton } from "@/components/reset-to-initial-button";

// Track previous bins to detect changes for animations
interface AnimatedBin extends SimulatedBin {
  animationDelay: number;
}

interface LiquidityChartProps {
   bins: SimulatedBin[];
   simulatedBins: SimulatedBin[];
   currentPrice: number;
   initialPrice: number;
   lowerPrice: number;
   upperPrice: number;
   strategy: Strategy;
   onCurrentPriceChange: (price: number) => void;
   onInitialPriceChange: (price: number) => void;
   initialPriceLocked?: boolean;
   initialPriceLabel?: string;
   promptSetInitialPrice?: boolean;
}

const FormattedNumber = ({ value, maximumFractionDigits }: { value: number; maximumFractionDigits?: number }) => {
  if (!Number.isFinite(value)) return <>0</>;
  if (value > 0 && value < 0.001) {
    const s = value.toFixed(20);
    const firstDigitIndex = s.search(/[1-9]/);
    if (firstDigitIndex >= 0) {
      const numZeros = firstDigitIndex - 2;
      if (numZeros >= 3) {
        const remainingDigits = s.substring(firstDigitIndex, firstDigitIndex + 7);
        return (
          <>
            0.0<sub>{numZeros}</sub>{remainingDigits}
          </>
        );
      }
    }
  }
  return <>{formatNumber(value, maximumFractionDigits)}</>;
};

const ShortFormattedNumber = ({ value }: { value: number }) => {
  if (!Number.isFinite(value)) return <>0</>;
  if (value > 0 && value < 0.001) {
    const s = value.toFixed(20);
    const firstDigitIndex = s.search(/[1-9]/);
    if (firstDigitIndex >= 0) {
      const numZeros = firstDigitIndex - 2;
      if (numZeros >= 3) {
        const remainingDigits = s.substring(firstDigitIndex, firstDigitIndex + 3);
        return (
          <>
            0.0<sub>{numZeros}</sub>{remainingDigits}
          </>
        );
      }
    }
  }
  // For larger numbers, show fewer digits
  return <>{formatNumber(value, 2)}</>;
};

/** Keep absolutely positioned labels inside the chart when the marker sits at an edge. */
function edgeAnchor(positionPct: number): { style: React.CSSProperties; alignClass: string } {
  if (positionPct <= 22) {
    return { style: { left: 0 }, alignClass: 'items-start text-left' };
  }
  if (positionPct >= 78) {
    return { style: { left: '100%', transform: 'translateX(-100%)' }, alignClass: 'items-end text-right' };
  }
  return {
    style: { left: `${positionPct}%`, transform: 'translateX(-50%)' },
    alignClass: 'items-center text-center',
  };
}

export function LiquidityChart({
     bins,
     simulatedBins,
     currentPrice,
     initialPrice,
     lowerPrice,
     upperPrice,
     strategy,
     onCurrentPriceChange,
     onInitialPriceChange,
     initialPriceLocked = false,
     initialPriceLabel,
     promptSetInitialPrice = false,
   }: LiquidityChartProps) {
     const { params, baseDecimals, quoteDecimals, applyDecimalAdjustment, tokenSymbols } = useDlmmContext();

  const chartRef = useRef<HTMLDivElement>(null);
  const [isDraggingCurrent, setIsDraggingCurrent] = useState(false);
  const [isDraggingInitial, setIsDraggingInitial] = useState(false);
  const [animationTrigger, setAnimationTrigger] = useState(0);
  const [isInitialAnimation, setIsInitialAnimation] = useState(false);
  const [hoveredBin, setHoveredBin] = useState<SimulatedBin | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [useCurrentPrice, setUseCurrentPrice] = useState(false);
  const prevBinsRef = useRef<SimulatedBin[]>([]);

  // Helper function to get the value for bin height based on toggle
  const getBinValue = useCallback((bin: SimulatedBin) => {
    if (useCurrentPrice) {
      // Current value at market price
      if (bin.currentTokenType === 'base') {
        return bin.currentAmount * currentPrice;
      } else {
        return bin.currentAmount;
      }
    } else {
      // Overlay each deposit at the bin's own price so mixed SOL+USDC stacks
      // don't treat USDC as extra SOL (which inflates a narrow overlap band).
      return binInitialDisplayValue(bin);
    }
  }, [useCurrentPrice, currentPrice]);
  
  // Detect when bins change to trigger animations
  useEffect(() => {
    const binsToDisplay = simulatedBins.length > 0 ? simulatedBins : bins;
    const prevBins = prevBinsRef.current;

    // Initial animation when bins first appear
    if (prevBins.length === 0 && binsToDisplay.length > 0) {
      setIsInitialAnimation(true);
      setAnimationTrigger(prev => prev + 1);
      // Clear initial animation flag after animation completes
      setTimeout(() => setIsInitialAnimation(false), 800);
    }
    // Check if bins have actually changed
    else if (prevBins.length > 0 && binsToDisplay.length > 0) {
      const hasChanged = binsToDisplay.some((bin, i) => {
        const prevBin = prevBins[i];
        if (!prevBin) return true;
        // Compare actual values instead of displayValue
        const currentVal = getBinValue(bin);
        const prevVal = getBinValue(prevBin);
        return Math.abs(currentVal - prevVal) > 0.0001 ||
               bin.currentTokenType !== prevBin.currentTokenType;
      });

      if (hasChanged) {
        setAnimationTrigger(prev => prev + 1);
      }
    }

    prevBinsRef.current = binsToDisplay;
  }, [bins, simulatedBins, getBinValue]);

  const maxValue = useMemo(() => {
    const binsToDisplay = simulatedBins.length > 0 ? simulatedBins : bins;
    if (!binsToDisplay || binsToDisplay.length === 0) return 1;
    const max = Math.max(...binsToDisplay.map(b => getBinValue(b)));
    return max > 0 ? max : 1;
  }, [bins, simulatedBins, getBinValue]);

  const priceRange = useMemo(() => {
    if (typeof params.binStep !== 'number' || params.binStep <= 0) {
      return { min: lowerPrice, max: upperPrice };
    }

    const baseDecimalsLocal = typeof baseDecimals === 'number' ? baseDecimals : 9;
    const quoteDecimalsLocal = typeof quoteDecimals === 'number' ? quoteDecimals : 6;
    const applyAdjustmentLocal = applyDecimalAdjustment ?? true;

    if (!bins || bins.length === 0) {
       // Estimate range if bins are not available yet
        const lowerId = getIdFromPrice(lowerPrice, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
        const upperId = getIdFromPrice(upperPrice, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
        const minPrice = getPriceFromId(lowerId - 1, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
        const maxPrice = getPriceFromId(upperId + 1, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
        return { min: minPrice, max: maxPrice };
    }

    const minId = bins[0].id;
    const maxId = bins[bins.length - 1].id;
    // Extend by one bin on each side
    const minPrice = getPriceFromId(minId - 1, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
    const maxPrice = getPriceFromId(maxId + 1, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
    return { min: minPrice, max: maxPrice };
  }, [bins, lowerPrice, upperPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment]);


  const priceToPercentage = useCallback((price: number) => {
    if (priceRange.max <= priceRange.min || bins.length === 0) return 0;

    // Use SDK-accurate bin ID calculation with decimals
    const baseDecimalsLocal = typeof baseDecimals === 'number' ? baseDecimals : 9;
    const quoteDecimalsLocal = typeof quoteDecimals === 'number' ? quoteDecimals : 6;
    const applyAdjustmentLocal = applyDecimalAdjustment ?? true;

    // Get the bin ID for this price
    const binId = getIdFromPrice(price, params.binStep || 1, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);

    // Find the index of this bin in our bins array
    const binIndex = bins.findIndex(b => b.id === binId);

    if (binIndex === -1) {
      // Bin not found in array, fall back to logarithmic positioning
      const logPrice = Math.log(price);
      const logMin = Math.log(priceRange.min);
      const logMax = Math.log(priceRange.max);
      const percentage = Math.max(0, Math.min(100, ((logPrice - logMin) / (logMax - logMin)) * 100));
      return percentage;
    }

    // Calculate percentage based on bin index
    // Each bin occupies equal width, position at the center of the bin
    const binWidth = 100 / bins.length;
    const centerOffset = binWidth / 2;
    const percentage = (binIndex * binWidth) + centerOffset;
    return percentage;
  }, [priceRange, bins, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const percentageToPrice = useCallback((percentage: number) => {
    if (priceRange.min <= 0 || priceRange.max <= 0) return 0;
    const logMin = Math.log(priceRange.min);
    const logMax = Math.log(priceRange.max);
    const logPrice = logMin + (logMax - logMin) * (percentage / 100);
    return Math.exp(logPrice);
  }, [priceRange]);


  const findClosestBinPrice = useCallback((price: number) => {
    if (typeof params.binStep !== 'number' || params.binStep <= 0 || !isFinite(price)) return price;

    // Use SDK-accurate bin ID calculation with decimals
    const baseDecimalsLocal = typeof baseDecimals === 'number' ? baseDecimals : 9;
    const quoteDecimalsLocal = typeof quoteDecimals === 'number' ? quoteDecimals : 6;
    const applyAdjustmentLocal = applyDecimalAdjustment ?? true;

    // Get the bin ID for this price (no rounding)
    let targetId = getIdFromPrice(price, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);

    if (bins.length > 0) {
        const minId = bins[0].id;
        const maxId = bins[bins.length - 1].id;
        // Allow one bin outside the range
        if (targetId < minId - 1) targetId = minId - 1;
        if (targetId > maxId + 1) targetId = maxId + 1;
    }

    // Get the exact SDK price for this bin ID
    return getPriceFromId(targetId, params.binStep, baseDecimalsLocal, quoteDecimalsLocal, applyAdjustmentLocal);
  }, [bins, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment]);


  // Use PointerEvent so touch + mouse both work
  const handleMouseMove = useCallback((e: PointerEvent) => {
    if (!chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let percentage = (x / rect.width) * 100;
    percentage = Math.max(0, Math.min(100, percentage));

    const newPrice = percentageToPrice(percentage);
    // Snap to the closest valid bin price using SDK calculations
    const snappedPrice = findClosestBinPrice(newPrice);

    if (isDraggingCurrent) {
      onCurrentPriceChange(snappedPrice);
    }
    if (isDraggingInitial && !initialPriceLocked) {
      onInitialPriceChange(snappedPrice);
    }
  }, [isDraggingCurrent, isDraggingInitial, initialPriceLocked, percentageToPrice, findClosestBinPrice, onCurrentPriceChange, onInitialPriceChange]);
  
  const handleMouseUp = useCallback(() => {
    setIsDraggingCurrent(false);
    setIsDraggingInitial(false);
  }, []);

  useEffect(() => {
    // Use pointer events so touch (mobile) works as well as mouse
    if (isDraggingCurrent || isDraggingInitial) {
      document.addEventListener('pointermove', handleMouseMove as EventListener);
      document.addEventListener('pointerup', handleMouseUp as EventListener);
    } else {
      document.removeEventListener('pointermove', handleMouseMove as EventListener);
      document.removeEventListener('pointerup', handleMouseUp as EventListener);
    }
    return () => {
      document.removeEventListener('pointermove', handleMouseMove as EventListener);
      document.removeEventListener('pointerup', handleMouseUp as EventListener);
    };
  }, [isDraggingCurrent, isDraggingInitial, handleMouseMove, handleMouseUp]);
  
  // Reset useCurrentPrice toggle when strategy changes
  useEffect(() => {
    setUseCurrentPrice(false);
  }, [strategy]);
  
  // Calculate gap size based on number of bins to prevent overflow
  const gapClass = bins.length > 200 ? '' : bins.length > 100 ? 'gap-[0.5px]' : 'gap-px';

  const currentPricePosition = priceToPercentage(currentPrice);
  const initialPricePosition = priceToPercentage(initialPrice);
  const currentPriceAnchor = edgeAnchor(currentPricePosition);
  const initialPriceAnchor = edgeAnchor(initialPricePosition);
  const isPriceDifferent = Math.abs(currentPrice - initialPrice) > 1e-10;
  const showInitialPricePrompt = promptSetInitialPrice && !initialPriceLocked;

  const numTicks = 6;
  const priceTicks = useMemo(() =>
    Array.from({ length: numTicks }, (_, i) => {
      const price = percentageToPrice((i / (numTicks - 1)) * 100);
      return { price, position: priceToPercentage(price) };
    }), [percentageToPrice, priceToPercentage, numTicks]
  );

  const binsToDisplay = simulatedBins.length > 0 ? simulatedBins : bins;

  // Create animated bins with staggered delays radiating from current price
  const animatedBins: AnimatedBin[] = useMemo(() => {
    // Find the bin closest to current price
    let closestIndex = 0;
    let minDiff = Infinity;

    binsToDisplay.forEach((bin, index) => {
      const diff = Math.abs(bin.price - currentPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = index;
      }
    });

    // Calculate delay per bin to keep total animation time consistent
    // Target total animation time: 300ms
    // Maximum distance from center is half the bins (radiating outward)
    const maxDistance = Math.ceil(binsToDisplay.length / 2);
    const delayPerBin = maxDistance > 0 ? 300 / maxDistance : 3;

    return binsToDisplay.map((bin, index) => {
      // Calculate distance from current price bin
      const distance = Math.abs(index - closestIndex);
      return {
        ...bin,
        animationDelay: distance * delayPerBin
      };
    });
  }, [binsToDisplay, currentPrice]);

  if (!bins || bins.length === 0) {
    return <div className="flex items-center justify-center h-full text-muted-foreground">No liquidity data.</div>
  }

  return (
        <div className="flex flex-col h-full w-full justify-between relative">
          {/* Chart Price Display Toggle - positioned at top. Hidden on mobile to keep the chart above the tab bar; the toggle still exists from sm up. */}
          <div className="hidden sm:flex shrink-0 items-center gap-2 mb-3 px-3 py-1.5 bg-card/80 backdrop-blur-sm rounded-md border border-border/50 shadow-sm self-start">
            <Switch checked={useCurrentPrice} onCheckedChange={setUseCurrentPrice} />
            <label className="text-xs text-muted-foreground font-medium whitespace-nowrap">Display Actual {tokenSymbols.quote} Value</label>
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-muted-foreground/30 cursor-help hover:border-muted-foreground/60 transition-colors">
                    <span className="text-[10px] italic text-muted-foreground font-serif">i</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    By default, the liquidity distribution is displayed in the same manner as the Meteora UI,
                    showing bin heights based on each bin's price. Enabling this toggle will calculate the
                    height of base token bins using the current price instead, providing a real-time value view.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {showInitialPricePrompt && (
            <div className="mb-2 w-full shrink-0 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs leading-snug">
              <span className="font-semibold text-foreground">Set the initial price</span>
              <span className="text-muted-foreground">
                {' '}using the handle below the chart. It is the cost basis for your loaded wallet positions and locks after the first simulated transaction.
              </span>
            </div>
          )}
          <div className="relative w-full min-h-0 flex-grow" ref={chartRef}>
          <div className={cn('flex h-full w-full flex-col', !showInitialPricePrompt && 'pt-11 lg:pt-0')}>
          {/* Spacer so Current Price sits below the toggle/banner instead of covering it.
              Mobile has no toggle row, so the banner alone (when showing) reserves space. */}
          <div
            className={cn('h-14 shrink-0', !showInitialPricePrompt && 'hidden', showInitialPricePrompt && 'h-12 lg:h-14')}
            aria-hidden
          />
          {/* Liquidity Bins */}
          <div className={`flex min-h-0 w-full flex-1 items-end ${gapClass}`}>
            {animatedBins.map((bin) => {
              const baseColor = bin.currentTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)';
              const hasValue = getBinValue(bin) > 0;

              return (
                <div
                  key={bin.id}
                  className={`flex-1 transition-all duration-500 ease-out relative hover:brightness-110 ${isInitialAnimation ? 'bin-enter' : ''}`}
                  style={{
                    height: `${(getBinValue(bin) / maxValue) * 100}%`,
                    backgroundColor: baseColor,
                    transitionDelay: `${bin.animationDelay}ms`,
                    animationDelay: isInitialAnimation ? `${bin.animationDelay}ms` : undefined,
                    transformOrigin: 'bottom',
                    opacity: hasValue ? 1 : 0.3,
                    willChange: animationTrigger > 0 ? 'height, background-color, filter' : 'auto',
                  }}
                  onMouseEnter={(e) => {
                    setHoveredBin(bin);
                    if (chartRef.current) {
                      const chartRect = chartRef.current.getBoundingClientRect();
                      setTooltipPosition({
                        x: e.clientX - chartRect.left,
                        y: e.clientY - chartRect.top
                      });
                    }
                  }}
                  onMouseMove={(e) => {
                    if (hoveredBin && chartRef.current) {
                      const chartRect = chartRef.current.getBoundingClientRect();
                      setTooltipPosition({
                        x: e.clientX - chartRect.left,
                        y: e.clientY - chartRect.top
                      });
                    }
                  }}
                  onMouseLeave={() => setHoveredBin(null)}
                />
              );
            })}
          </div>
          </div>

          {/* Current Price Indicator. On mobile (and whenever the wallet prompt is
              showing) keep the label in the plot so it sits below the toggle/banner. */}
          <div
            className={cn(
              'pointer-events-none absolute inset-x-0 z-20 h-14',
              showInitialPricePrompt ? 'top-0' : 'top-0 lg:top-[-50px] lg:block'
            )}
          >
            <div
              className={cn(
                'absolute top-0.5 px-3 py-1.5 bg-gradient-to-br from-card to-card/80 text-foreground text-xs rounded-lg shadow-xl whitespace-nowrap border border-primary/20 backdrop-blur-sm',
                currentPriceAnchor.alignClass
              )}
              style={currentPriceAnchor.style}
            >
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Current Price</div>
              <div className="font-bold text-sm"><FormattedNumber value={currentPrice} maximumFractionDigits={4} /></div>
            </div>
          </div>
          <div
            className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${currentPricePosition}%`, touchAction: 'none' as const }}
            onPointerDown={(e) => { e.preventDefault(); setIsDraggingCurrent(true); }}
          >
            <div
              className={cn(
                'absolute bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-gradient-to-b from-primary/80 to-primary/40 border-l border-dashed border-foreground/80 shadow-lg',
                showInitialPricePrompt ? 'top-14' : 'top-11 lg:top-[-8px]'
              )}
              style={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }}
            />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-2 bg-primary rounded-t-sm shadow-lg"
                 style={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }} />
          </div>


          {/* Bin Tooltip */}
          {hoveredBin && (
            <div
              className="absolute pointer-events-none z-50 px-3 py-2 bg-gradient-to-br from-slate-900 to-slate-800 text-white text-xs rounded-lg shadow-2xl border border-primary/50 backdrop-blur-sm whitespace-nowrap"
              style={{
                left: `${tooltipPosition.x}px`,
                top: `${tooltipPosition.y}px`,
                transform: 'translate(-50%, calc(-100% - 12px))',
              }}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">Price:</span>
                  <span className="font-bold text-blue-400">
                    <FormattedNumber value={hoveredBin.price} maximumFractionDigits={6} />
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">Token:</span>
                  <span className="font-semibold capitalize text-white">{tokenSymbols[hoveredBin.currentTokenType as keyof typeof tokenSymbols]}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">Amount:</span>
                  <span className="font-semibold text-white">
                    <FormattedNumber value={hoveredBin.currentAmount} maximumFractionDigits={4} />
                  </span>
                </div>
                {hoveredBin.currentValueInQuote > 0 && (
                  <div className="flex items-center gap-2 pt-1 border-t border-slate-600">
                    <span className="text-slate-300">Value:</span>
                    <span className="font-semibold text-emerald-400">
                      <FormattedNumber value={hoveredBin.currentValueInQuote} maximumFractionDigits={4} /> <span className="text-[10px] text-slate-400">Quote</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
        
        {/* Price Axis */}
        <div className="relative w-full h-4 mt-1 mb-0 shrink-0">
          {priceTicks.map((tick, i) => (
            <div key={i} className="absolute text-xs text-muted-foreground" style={{ left: `${tick.position}%`, transform: 'translateX(-50%)' }}>
              <ShortFormattedNumber value={tick.price} />
            </div>
          ))}
        </div>

        {initialPriceLocked ? (
          <div className={cn('relative w-full mt-0.5 shrink-0', isPriceDifferent ? 'h-[4.75rem]' : 'h-11')}>
            <div
              className="absolute top-0 -translate-x-1/2"
              style={{ left: `${initialPricePosition}%` }}
            >
              <div
                className="h-0 w-0 border-x-[7px] border-b-[9px] border-x-transparent border-b-primary"
                aria-hidden
              />
            </div>
            <div
              className={cn('absolute top-[10px] flex flex-col leading-tight', initialPriceAnchor.alignClass)}
              style={initialPriceAnchor.style}
            >
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                {initialPriceLabel ?? 'Initial Price'}
              </div>
              <div className="text-xs font-bold tabular-nums text-primary whitespace-nowrap">
                <FormattedNumber value={initialPrice} maximumFractionDigits={4} />
              </div>
              {isPriceDifferent && (
                <ResetToInitialButton onClick={() => onCurrentPriceChange(initialPrice)} />
              )}
            </div>
          </div>
        ) : (
        <div className={cn('relative w-full mt-1 shrink-0', isPriceDifferent ? 'h-[5.5rem]' : 'h-16')}>
          <div className="relative h-7">
            <div className="absolute h-1.5 top-1/2 -translate-y-1/2 w-full bg-gradient-to-r from-secondary/50 via-secondary to-secondary/50 rounded-full shadow-inner" />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="absolute top-1/2 z-10 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
                    style={{
                      left: `${initialPricePosition}%`,
                      touchAction: 'none' as const,
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsDraggingInitial(true);
                    }}
                  >
                    <div
                      className={cn(
                        "h-4 w-4 rounded-full border-2 border-background bg-gradient-to-br from-primary to-purple-500 shadow-lg hover:scale-110 hover:shadow-xl",
                        promptSetInitialPrice && !isDraggingInitial && "ring-2 ring-primary/70 ring-offset-2 ring-offset-background"
                      )}
                      style={{
                        boxShadow: isDraggingInitial
                          ? '0 0 20px rgba(66, 153, 225, 0.8), 0 0 40px rgba(139, 92, 246, 0.4)'
                          : '0 4px 10px rgba(66, 153, 225, 0.3)'
                      }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    {promptSetInitialPrice
                      ? 'Drag to set the initial simulation price. This is the cost basis for your loaded wallet positions until you add a simulated transaction.'
                      : 'Drag to set the initial simulation price. It becomes the cost basis and locks after the first simulated transaction.'}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div
            className={cn('absolute top-7 flex flex-col pt-0.5', initialPriceAnchor.alignClass)}
            style={initialPriceAnchor.style}
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium whitespace-nowrap">
              {initialPriceLabel ?? 'Initial Price'}
            </div>
            <div className="text-xs font-bold text-primary tabular-nums whitespace-nowrap">
              <FormattedNumber value={initialPrice} maximumFractionDigits={4} />
            </div>
            <div className={cn(
              "text-[10px] leading-tight whitespace-nowrap",
              promptSetInitialPrice ? "font-medium text-primary hidden lg:block" : "text-muted-foreground"
            )}>
              {promptSetInitialPrice ? 'Drag to set simulation cost basis' : 'Simulation cost basis'}
            </div>
            {isPriceDifferent && (
              <ResetToInitialButton onClick={() => onCurrentPriceChange(initialPrice)} />
            )}
          </div>
        </div>
        )}
        </div>
  )
}

  