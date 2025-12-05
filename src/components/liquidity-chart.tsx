
"use client"

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { type SimulatedBin, getIdFromPrice, getPriceFromId } from "@/lib/dlmm";
import { formatNumber } from "@/lib/utils";
import { useDlmmContext } from "./dlmm-simulator";

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
  onCurrentPriceChange: (price: number) => void;
  onInitialPriceChange: (price: number) => void;
}

const FormattedNumber = ({ value, maximumFractionDigits }: { value: number; maximumFractionDigits?: number }) => {
  if (value > 0 && value < 0.001) {
    const s = value.toFixed(20);
    const firstDigitIndex = s.search(/[1-9]/);
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
  return <>{formatNumber(value, maximumFractionDigits)}</>;
};

export function LiquidityChart({
  bins,
  simulatedBins,
  currentPrice,
  initialPrice,
  lowerPrice,
  upperPrice,
  onCurrentPriceChange,
  onInitialPriceChange
}: LiquidityChartProps) {
  const { params } = useDlmmContext();
  const chartRef = useRef<HTMLDivElement>(null);
  const [isDraggingCurrent, setIsDraggingCurrent] = useState(false);
  const [isDraggingInitial, setIsDraggingInitial] = useState(false);
  const [animationTrigger, setAnimationTrigger] = useState(0);
  const [isInitialAnimation, setIsInitialAnimation] = useState(false);
  const prevBinsRef = useRef<SimulatedBin[]>([]);
  
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
        return !prevBin ||
               Math.abs(bin.displayValue - prevBin.displayValue) > 0.0001 ||
               bin.currentTokenType !== prevBin.currentTokenType;
      });

      if (hasChanged) {
        setAnimationTrigger(prev => prev + 1);
      }
    }

    prevBinsRef.current = binsToDisplay;
  }, [bins, simulatedBins]);

  const maxValue = useMemo(() => {
    const binsToDisplay = simulatedBins.length > 0 ? simulatedBins : bins;
    if (!binsToDisplay || binsToDisplay.length === 0) return 1;
    const max = Math.max(...binsToDisplay.map(b => b.displayValue));
    return max > 0 ? max : 1;
  }, [bins, simulatedBins]);

  const priceRange = useMemo(() => {
    if (typeof params.binStep !== 'number' || params.binStep <= 0) {
      return { min: lowerPrice, max: upperPrice };
    }

    if (!bins || bins.length === 0) {
       // Estimate range if bins are not available yet
        const basis = 1 + params.binStep / 10000;
        const lowerId = getIdFromPrice(lowerPrice, params.binStep);
        const upperId = getIdFromPrice(upperPrice, params.binStep);
        const minPrice = getPriceFromId(lowerId - 1, params.binStep);
        const maxPrice = getPriceFromId(upperId + 1, params.binStep);
        return { min: minPrice, max: maxPrice };
    }
    
    const minId = bins[0].id;
    const maxId = bins[bins.length - 1].id;
    // Extend by one bin on each side
    const minPrice = getPriceFromId(minId - 1, params.binStep); 
    const maxPrice = getPriceFromId(maxId + 1, params.binStep);
    return { min: minPrice, max: maxPrice };
  }, [bins, lowerPrice, upperPrice, params.binStep]);


  const priceToPercentage = useCallback((price: number) => {
    if (priceRange.max <= priceRange.min) return 0;
    const logPrice = Math.log(price);
    const logMin = Math.log(priceRange.min);
    const logMax = Math.log(priceRange.max);
    return Math.max(0, Math.min(100, ((logPrice - logMin) / (logMax - logMin)) * 100));
  }, [priceRange]);

  const percentageToPrice = useCallback((percentage: number) => {
    if (priceRange.min <= 0 || priceRange.max <= 0) return 0;
    const logMin = Math.log(priceRange.min);
    const logMax = Math.log(priceRange.max);
    const logPrice = logMin + (logMax - logMin) * (percentage / 100);
    return Math.exp(logPrice);
  }, [priceRange]);


  const findClosestBinPrice = useCallback((price: number) => {
    if (typeof params.binStep !== 'number' || params.binStep <= 0 || !isFinite(price)) return price;
    
    const basis = 1 + params.binStep / 10000;
    const idUnrounded = Math.log(price) / Math.log(basis) + 262144 - 0.5;
    let targetId = Math.round(idUnrounded) + 1;


    if (bins.length > 0) {
        const minId = bins[0].id;
        const maxId = bins[bins.length - 1].id;
        // Allow one bin outside the range
        if (targetId < minId -1) targetId = minId - 1;
        if (targetId > maxId + 1) targetId = maxId + 1;
    }

    return getPriceFromId(targetId, params.binStep);
  }, [bins, params.binStep]);


  // Use PointerEvent so touch + mouse both work
  const handleMouseMove = useCallback((e: PointerEvent) => {
    if (!chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let percentage = (x / rect.width) * 100;
    percentage = Math.max(0, Math.min(100, percentage));

    const newPrice = percentageToPrice(percentage);
    const snappedPrice = newPrice;

    if (isDraggingCurrent) {
      onCurrentPriceChange(snappedPrice);
    }
    if (isDraggingInitial) {
      onInitialPriceChange(snappedPrice);
    }
  }, [isDraggingCurrent, isDraggingInitial, percentageToPrice, findClosestBinPrice, onCurrentPriceChange, onInitialPriceChange]);
  
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

  // Calculate gap size based on number of bins to prevent overflow
  const gapClass = bins.length > 200 ? '' : bins.length > 100 ? 'gap-[0.5px]' : 'gap-px';

  const currentPricePosition = priceToPercentage(currentPrice);
  const initialPricePosition = priceToPercentage(initialPrice);

  const numTicks = 6;
  const priceTicks = useMemo(() =>
    Array.from({ length: numTicks }, (_, i) => {
      const price = percentageToPrice((i / (numTicks - 1)) * 100);
      return { price, position: priceToPercentage(price) };
    }), [percentageToPrice, priceToPercentage]
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

    return binsToDisplay.map((bin, index) => {
      // Calculate distance from current price bin
      const distance = Math.abs(index - closestIndex);
      return {
        ...bin,
        animationDelay: distance * 3 // 3ms per bin distance from current price
      };
    });
  }, [binsToDisplay, currentPrice]);

  if (!bins || bins.length === 0) {
    return <div className="flex items-center justify-center h-full text-muted-foreground">No liquidity data.</div>
  }

  return (
      <div className="flex flex-col h-full w-full justify-between">
        <div className="relative w-full flex-grow" ref={chartRef}>
          {/* Liquidity Bins */}
          <div className={`flex items-end h-full w-full ${gapClass}`}>
            {animatedBins.map((bin) => {
              const isNearCurrentPrice = Math.abs(bin.price - currentPrice) / currentPrice < 0.05;
              const baseColor = bin.currentTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)';
              const hasValue = bin.displayValue > 0;

              return (
                <div
                  key={bin.id}
                  className={`flex-1 transition-all duration-500 ease-out relative hover:brightness-110 ${isInitialAnimation ? 'bin-enter' : ''}`}
                  style={{
                    height: `${(bin.displayValue / maxValue) * 100}%`,
                    backgroundColor: baseColor,
                    transitionDelay: `${bin.animationDelay}ms`,
                    animationDelay: isInitialAnimation ? `${bin.animationDelay}ms` : undefined,
                    transformOrigin: 'bottom',
                    opacity: hasValue ? 1 : 0.3,
                    filter: isNearCurrentPrice ? 'brightness(1.3)' : 'brightness(1)',
                    boxShadow: isNearCurrentPrice && hasValue
                      ? `0 0 8px ${bin.currentTokenType === 'base' ? 'rgba(92, 58, 212, 0.6)' : 'rgba(0, 118, 145, 0.6)'}`
                      : 'none',
                    willChange: animationTrigger > 0 ? 'height, background-color, filter' : 'auto',
                  }}
                />
              );
            })}
          </div>

          {/* Current Price Indicator */}
          <div
            className="absolute top-0 bottom-0 w-6 -translate-x-1/2 cursor-ew-resize transition-all duration-300 ease-out"
            style={{ left: `${currentPricePosition}%`, touchAction: 'none' as const }}
            onPointerDown={(e) => { e.preventDefault(); setIsDraggingCurrent(true); }}
          >
            <div className="absolute top-[-50px] left-1/2 -translate-x-1/2 px-3 py-1.5 bg-gradient-to-br from-card to-card/80 text-foreground text-xs rounded-lg shadow-xl whitespace-nowrap border border-primary/20 backdrop-blur-sm">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Current Price</div>
              <div className="font-bold text-sm"><FormattedNumber value={currentPrice} maximumFractionDigits={4} /></div>
            </div>
            <div className="absolute top-[-8px] left-1/2 w-0.5 h-[calc(100%+8px)] bg-gradient-to-b from-primary/80 to-primary/40 border-foreground/80 border-dashed border-l shadow-lg"
                 style={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }} />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-2 bg-primary rounded-t-sm shadow-lg"
                 style={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }} />
          </div>
        </div>
        
        {/* Price Axis */}
        <div className="relative w-full h-4 mt-2 mb-2">
          {priceTicks.map((tick, i) => (
            <div key={i} className="absolute text-xs text-muted-foreground" style={{ left: `${tick.position}%`, transform: 'translateX(-50%)' }}>
              <FormattedNumber value={tick.price} maximumFractionDigits={4} />
            </div>
          ))}
        </div>

        {/* Initial Price Slider */}
        <div className="relative h-8 mt-4 mb-2 w-full">
          <div className="absolute h-2 top-1/2 -translate-y-1/2 w-full bg-gradient-to-r from-secondary/50 via-secondary to-secondary/50 rounded-full shadow-inner" />
          <div
            className="absolute top-1/2 w-5 h-5 bg-gradient-to-br from-primary to-purple-500 rounded-full cursor-pointer border-2 border-background shadow-lg transition-all duration-300 hover:scale-110 hover:shadow-xl"
            style={{
              left: `${initialPricePosition}%`,
              transform: 'translate(-50%, -50%)',
              touchAction: 'none' as const,
              boxShadow: isDraggingInitial
                ? '0 0 20px rgba(66, 153, 225, 0.8), 0 0 40px rgba(139, 92, 246, 0.4)'
                : '0 4px 10px rgba(66, 153, 225, 0.3)'
            }}
            onPointerDown={(e) => { e.preventDefault(); setIsDraggingInitial(true); }}
          />
          <div className="absolute top-full text-center mt-1 transition-all duration-300" style={{left: `${initialPricePosition}%`, transform: 'translateX(-50%)'}}>
            <span className="text-xs text-muted-foreground font-medium">
              Initial Price: <span className="text-primary font-bold"><FormattedNumber value={initialPrice} maximumFractionDigits={4} /></span>
            </span>
          </div>
        </div>
      </div>
  )
}

  