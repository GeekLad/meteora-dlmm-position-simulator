
"use client"

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { type SimulatedBin, getIdFromPrice, getPriceFromId } from "@/lib/dlmm";
import { formatNumber } from "@/lib/utils";
import { useDlmmContext } from "./dlmm-simulator";

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


  if (!bins || bins.length === 0) {
    return <div className="flex items-center justify-center h-full text-muted-foreground">No liquidity data.</div>
  }

  // Calculate gap size based on number of bins to prevent overflow
  const gapClass = bins.length > 200 ? '' : bins.length > 100 ? 'gap-[0.5px]' : 'gap-px';

  const currentPricePosition = priceToPercentage(currentPrice);
  const initialPricePosition = priceToPercentage(initialPrice);

  const numTicks = 6;
  const priceTicks = Array.from({ length: numTicks }, (_, i) => {
      const price = percentageToPrice((i / (numTicks - 1)) * 100);
      return { price, position: priceToPercentage(price) };
  });
  
  const binsToDisplay = simulatedBins.length > 0 ? simulatedBins : bins;

  return (
      <div className="flex flex-col h-full w-full justify-between">
        <div className="relative w-full flex-grow" ref={chartRef}>
          {/* Liquidity Bins */}
          <div className={`flex items-end h-full w-full ${gapClass}`}>
            {binsToDisplay.map((bin) => (
                  <div
                    key={bin.id}
                    className="flex-1 transition-colors duration-200 ease-in-out"
                    style={{
                      height: `${(bin.displayValue / maxValue) * 100}%`,
                      backgroundColor: bin.currentTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)',
                    }}
                  />
            ))}
          </div>

          {/* Current Price Indicator */}
          <div
            className="absolute top-0 bottom-0 w-6 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${currentPricePosition}%`, touchAction: 'none' as const }}
            onPointerDown={(e) => { e.preventDefault(); setIsDraggingCurrent(true); }}
          >
            <div className="absolute top-[-50px] left-1/2 -translate-x-1/2 px-2 py-1 bg-card text-foreground text-xs rounded-md shadow-lg whitespace-nowrap">
              Current Price
              <div className="font-bold"><FormattedNumber value={currentPrice} maximumFractionDigits={4} /></div>
            </div>
            <div className="absolute top-[-8px] left-1/2 w-0.5 h-[calc(100%+8px)] bg-foreground/50 border-foreground/80 border-dashed border-l" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-2 bg-foreground rounded-t-sm" />
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
          <div className="absolute h-2 top-1/2 -translate-y-1/2 w-full bg-secondary rounded-full" />
      <div 
        className="absolute top-1/2 w-5 h-5 bg-primary rounded-full cursor-pointer border-2 border-background"
        style={{left: `${initialPricePosition}%`, transform: 'translate(-50%, -50%)', touchAction: 'none' as const}}
        onPointerDown={(e) => { e.preventDefault(); setIsDraggingInitial(true); }}
      />
          <div className="absolute top-full text-center mt-1" style={{left: `${initialPricePosition}%`, transform: 'translateX(-50%)'}}>
              <span className="text-xs text-muted-foreground">Initial Price: <FormattedNumber value={initialPrice} maximumFractionDigits={4} /></span>
          </div>
        </div>
      </div>
  )
}

  