
"use client";

import { useState, useMemo, useEffect, createContext, useContext } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { getInitialBins, runSimulation, getIdFromPrice, getPriceFromId, type SimulationParams, type Analysis, type SimulatedBin, type Strategy } from "@/lib/dlmm";
import { LiquidityChart } from "@/components/liquidity-chart";
import { Logo } from "@/components/icons";
import { Layers, CandlestickChart, Coins, ChevronsLeftRight, Footprints, RefreshCcw, MoveHorizontal } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { PoolSelector } from "@/components/pool-selector";
import { MeteoraPair, parseTokenSymbols } from "@/lib/meteora-api";

type PartialSimulationParams = Omit<SimulationParams, 'strategy' | 'binStep' | 'initialPrice' | 'baseAmount' | 'quoteAmount' | 'lowerPrice' | 'upperPrice'> & {
  strategy: Strategy;
  binStep: number | '';
  initialPrice: number | '';
  baseAmount: number | '';
  quoteAmount: number | '';
  lowerPrice: number | '';
  upperPrice: number | '';
};

const defaultParams: PartialSimulationParams = {
  binStep: '',
  initialPrice: '',
  baseAmount: '',
  quoteAmount: '',
  lowerPrice: '',
  upperPrice: '',
  strategy: 'spot',
};

type DlmmContextType = {
  params: PartialSimulationParams;
};

const DlmmContext = createContext<DlmmContextType | null>(null);

export const useDlmmContext = () => {
  const context = useContext(DlmmContext);
  if (!context) {
    throw new Error("useDlmmContext must be used within a DlmmSimulator");
  }
  return context;
};


const FormattedNumber = ({ value, maximumFractionDigits }: { value: number; maximumFractionDigits?: number }) => {
  const isNegative = value < 0;
  const absValue = Math.abs(value);

  if (absValue > 0 && absValue < 0.000000001) {
    return <>0</>;
  }

  if (absValue > 0 && absValue < 0.001) {
    const s = absValue.toFixed(20);
    const firstDigitIndex = s.search(/[1-9]/);
    const numZeros = firstDigitIndex - 2;
    if (numZeros > 9) {
      return <>0</>;
    }
    if (numZeros >= 3) {
      const remainingDigits = s.substring(firstDigitIndex, firstDigitIndex + 7);
      return (
        <>
          {isNegative && '-'}0.0<sub>{numZeros}</sub>{remainingDigits}
        </>
      );
    }
  }
  return <>{formatNumber(value, maximumFractionDigits)}</>;
};


export function DlmmSimulator() {
  const [params, setParams] = useState<PartialSimulationParams>(defaultParams);
  const [currentPrice, setCurrentPrice] = useState<number | ''>(defaultParams.initialPrice);
  const [initialBins, setInitialBins] = useState<SimulatedBin[]>([]);
  const [simulation, setSimulation] = useState<{ simulatedBins: SimulatedBin[], analysis: Analysis } | null>(null);
  const [selectedPool, setSelectedPool] = useState<MeteoraPair | null>(null);
  const [tokenSymbols, setTokenSymbols] = useState<{ base: string; quote: string }>({ base: 'Base', quote: 'Quote' });
  const [autoFill, setAutoFill] = useState(false);
  const [lastAutoFilledToken, setLastAutoFilledToken] = useState<'base' | 'quote' | null>(null);
  const [lowerPricePercentage, setLowerPricePercentage] = useState<number | ''>('');
  const [upperPricePercentage, setUpperPricePercentage] = useState<number | ''>('');

  const simulationParams = useMemo(() => {
    const allParamsSet =
      params.binStep !== '' &&
      params.initialPrice !== '' &&
      params.baseAmount !== '' &&
      params.quoteAmount !== '' &&
      params.lowerPrice !== '' &&
      params.upperPrice !== '';

    if (!allParamsSet) return null;

    return params as SimulationParams;
  }, [params]);


  useEffect(() => {
    if (simulationParams) {
      const bins = getInitialBins(simulationParams);
      setInitialBins(bins);
      if (currentPrice === '') {
        setCurrentPrice(simulationParams.initialPrice);
      }
    } else {
      setInitialBins([]);
    }
  }, [simulationParams]);

  useEffect(() => {
    if (initialBins.length > 0 && typeof currentPrice === 'number' && simulationParams) {
      const result = runSimulation(initialBins, currentPrice, simulationParams.initialPrice, simulationParams.strategy);
      setSimulation(result);
    } else {
      setSimulation(null);
    }
  }, [initialBins, currentPrice, simulationParams]);

  useEffect(() => {
    if (params.initialPrice !== '' && currentPrice === '') {
        setCurrentPrice(params.initialPrice);
    }
  }, [params.initialPrice, currentPrice]);

  // Update price percentages when prices or initial price change
  useEffect(() => {
    if (typeof params.initialPrice === 'number' && params.initialPrice > 0) {
      if (typeof params.lowerPrice === 'number') {
        const lowerPct = ((params.lowerPrice - params.initialPrice) / params.initialPrice) * 100;
        setLowerPricePercentage(Number(lowerPct.toFixed(2)));
      } else {
        setLowerPricePercentage('');
      }

      if (typeof params.upperPrice === 'number') {
        const upperPct = ((params.upperPrice - params.initialPrice) / params.initialPrice) * 100;
        setUpperPricePercentage(Number(upperPct.toFixed(2)));
      } else {
        setUpperPricePercentage('');
      }
    } else {
      setLowerPricePercentage('');
      setUpperPricePercentage('');
    }
  }, [params.lowerPrice, params.upperPrice, params.initialPrice]);

  // Auto-fill when toggle is turned on
  useEffect(() => {
    if (!autoFill) return;

    // Check if we have the necessary params for calculation
    if (typeof params.initialPrice !== 'number' ||
        typeof params.lowerPrice !== 'number' ||
        typeof params.upperPrice !== 'number' ||
        typeof params.binStep !== 'number') {
      return;
    }

    const initialPrice = params.initialPrice;
    const lowerPrice = params.lowerPrice;
    const upperPrice = params.upperPrice;
    const binStep = params.binStep;

    // Calculate number of bins on each side of initial price
    const minId = getIdFromPrice(lowerPrice, binStep);
    const maxId = getIdFromPrice(upperPrice, binStep);
    const initialPriceId = getIdFromPrice(initialPrice, binStep);

    // Handle edge cases where initial price is outside the range
    let quoteBinsCount: number;
    let baseBinsCount: number;

    if (initialPriceId < minId) {
      // Initial price is below range - all bins are base bins
      quoteBinsCount = 0;
      baseBinsCount = (maxId - minId) + 1;
    } else if (initialPriceId > maxId) {
      // Initial price is above range - all bins are quote bins
      quoteBinsCount = (maxId - minId) + 1;
      baseBinsCount = 0;
    } else {
      // Initial price is within range
      // Quote bins: id <= initialPriceId (bins at or below initial price get quote)
      // Base bins: id > initialPriceId (bins above initial price get base)
      quoteBinsCount = (initialPriceId - minId) + 1;
      baseBinsCount = maxId - initialPriceId;
    }

    const totalBins = quoteBinsCount + baseBinsCount;

    // Determine which token to calculate
    const hasQuote = typeof params.quoteAmount === 'number' && params.quoteAmount !== 0;
    const hasBase = typeof params.baseAmount === 'number' && params.baseAmount !== 0;

    if (!hasQuote && !hasBase) {
      // Neither is filled, nothing to auto-fill
      return;
    }

    let newParams = { ...params };

    // For a FLAT distribution where each bin has equal VALUE:
    // Let V = value per bin
    // Total quote value = V * quoteBinsCount
    // Total base value = V * baseBinsCount
    //
    // We know: quoteAmount = V * quoteBinsCount
    // And: baseAmount * initialPrice = V * baseBinsCount
    //
    // Therefore: quoteAmount / quoteBinsCount = (baseAmount * initialPrice) / baseBinsCount
    // Solving: quoteAmount = (baseAmount * initialPrice * quoteBinsCount) / baseBinsCount

    // If both are filled, recalculate base based on quote
    if (hasQuote && hasBase) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        if (params.strategy === 'spot') {
          let sumInvPrice = 0;
          for (let id = minId; id <= maxId; id++) {
            const price = getPriceFromId(id, binStep);
            if (id > initialPriceId) {
              sumInvPrice += 1 / price;
            }
          }
          newParams.baseAmount = (params.quoteAmount as number) / quoteBinsCount * sumInvPrice;
        } else {
          newParams.baseAmount = ((params.quoteAmount as number) * baseBinsCount) / (initialPrice * quoteBinsCount);
        }
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        // Price below range - only base bins exist, zero out quote
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        // Price above range - only quote bins exist, zero out base
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
      return;
    }

    // Only one is filled, calculate the other
    if (hasQuote && !hasBase) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        if (params.strategy === 'spot') {
          let sumInvPrice = 0;
          for (let id = minId; id <= maxId; id++) {
            const price = getPriceFromId(id, binStep);
            if (id > initialPriceId) {
              sumInvPrice += 1 / price;
            }
          }
          newParams.baseAmount = (params.quoteAmount as number) / quoteBinsCount * sumInvPrice;
        } else {
          newParams.baseAmount = ((params.quoteAmount as number) * baseBinsCount) / (initialPrice * quoteBinsCount);
        }
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        // Price below range - only base bins exist, zero out quote
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        // Price above range - only quote bins exist, zero out base
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
    } else if (hasBase && !hasQuote) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        if (params.strategy === 'spot') {
          let sumInvPrice = 0;
          for (let id = minId; id <= maxId; id++) {
            const price = getPriceFromId(id, binStep);
            if (id > initialPriceId) {
              sumInvPrice += 1 / price;
            }
          }
          newParams.quoteAmount = (params.baseAmount as number) / sumInvPrice * quoteBinsCount;
        } else {
          newParams.quoteAmount = ((params.baseAmount as number) * initialPrice * quoteBinsCount) / baseBinsCount;
        }
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        // Price below range - only base bins exist, zero out quote
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        // Price above range - only quote bins exist, zero out base
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('quote');
      setParams(newParams);
    }
  }, [autoFill, params.lowerPrice, params.upperPrice, params.binStep]);

  // Recalculate auto-filled token when initial price changes
  useEffect(() => {
    if (!autoFill || !lastAutoFilledToken) return;
    if (typeof params.initialPrice !== 'number' ||
        typeof params.lowerPrice !== 'number' ||
        typeof params.upperPrice !== 'number' ||
        typeof params.binStep !== 'number') return;

    const initialPrice = params.initialPrice;
    const lowerPrice = params.lowerPrice;
    const upperPrice = params.upperPrice;
    const binStep = params.binStep;

    // Calculate number of bins on each side of initial price
    const minId = getIdFromPrice(lowerPrice, binStep);
    const maxId = getIdFromPrice(upperPrice, binStep);
    const initialPriceId = getIdFromPrice(initialPrice, binStep);

    // Handle edge cases where initial price is outside the range
    let quoteBinsCount: number;
    let baseBinsCount: number;

    if (initialPriceId < minId) {
      // Initial price is below range - all bins are base bins
      quoteBinsCount = 0;
      baseBinsCount = (maxId - minId) + 1;
    } else if (initialPriceId > maxId) {
      // Initial price is above range - all bins are quote bins
      quoteBinsCount = (maxId - minId) + 1;
      baseBinsCount = 0;
    } else {
      // Initial price is within range
      quoteBinsCount = (initialPriceId - minId) + 1;
      baseBinsCount = maxId - initialPriceId;
    }

    let newParams = { ...params };

    if (lastAutoFilledToken === 'quote') {
      // Recalculate quote based on base
      if (typeof params.baseAmount === 'number') {
        if (quoteBinsCount > 0 && baseBinsCount > 0) {
          if (params.strategy === 'spot') {
            let sumInvPrice = 0;
            for (let id = minId; id <= maxId; id++) {
              const price = getPriceFromId(id, binStep);
              if (id > initialPriceId) {
                sumInvPrice += 1 / price;
              }
            }
            newParams.quoteAmount = params.baseAmount / sumInvPrice * quoteBinsCount;
          } else {
            newParams.quoteAmount = (params.baseAmount * initialPrice * quoteBinsCount) / baseBinsCount;
          }
        } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
          // Price below range - only base bins exist, zero out quote
          newParams.quoteAmount = 0;
        } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
          // Price above range - only quote bins exist, zero out base
          newParams.baseAmount = 0;
        }
        setParams(newParams);
      }
    } else if (lastAutoFilledToken === 'base') {
      // Recalculate base based on quote
      if (typeof params.quoteAmount === 'number') {
        if (quoteBinsCount > 0 && baseBinsCount > 0) {
          if (params.strategy === 'spot') {
            let sumInvPrice = 0;
            for (let id = minId; id <= maxId; id++) {
              const price = getPriceFromId(id, binStep);
              if (id > initialPriceId) {
                sumInvPrice += 1 / price;
              }
            }
            newParams.baseAmount = params.quoteAmount / quoteBinsCount * sumInvPrice;
          } else {
            newParams.baseAmount = (params.quoteAmount * baseBinsCount) / (initialPrice * quoteBinsCount);
          }
        } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
          // Price below range - only base bins exist, zero out quote
          newParams.quoteAmount = 0;
        } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
          // Price above range - only quote bins exist, zero out base
          newParams.baseAmount = 0;
        }
        setParams(newParams);
      }
    }
  }, [params.initialPrice, autoFill, lastAutoFilledToken]);

  const handlePricePercentageChange = (priceType: 'lower' | 'upper', value: string) => {
    const numValue = parseFloat(value);
    const finalValue = value === '' ? '' : numValue;

    if (priceType === 'lower') {
      setLowerPricePercentage(finalValue);
    } else {
      setUpperPricePercentage(finalValue);
    }

    // Calculate absolute price from percentage
    if (typeof finalValue === 'number' && typeof params.initialPrice === 'number' && params.initialPrice > 0) {
      const newPrice = params.initialPrice * (1 + finalValue / 100);
      if (priceType === 'lower') {
        handleParamChange('lowerPrice', newPrice.toString());
      } else {
        handleParamChange('upperPrice', newPrice.toString());
      }
    } else if (value === '') {
      // Clear the price when percentage is cleared
      if (priceType === 'lower') {
        setParams(prev => ({ ...prev, lowerPrice: '' }));
      } else {
        setParams(prev => ({ ...prev, upperPrice: '' }));
      }
    }
  };

  const handleParamChange = (field: keyof PartialSimulationParams, value: string) => {
    const numValue = parseFloat(value);
    const finalValue = value === '' ? '' : numValue;

    if (field === 'initialPrice') {
      setParams(prev => ({ ...prev, initialPrice: finalValue }));
      setCurrentPrice(finalValue);
    } else if (autoFill && (field === 'baseAmount' || field === 'quoteAmount')) {
      // Auto-fill the other token amount for flat distribution
      const newParams = { ...params, [field]: finalValue };

      if (typeof finalValue === 'number' &&
          typeof newParams.initialPrice === 'number' &&
          typeof newParams.lowerPrice === 'number' &&
          typeof newParams.upperPrice === 'number' &&
          typeof newParams.binStep === 'number') {

        const initialPrice = newParams.initialPrice;
        const lowerPrice = newParams.lowerPrice;
        const upperPrice = newParams.upperPrice;
        const binStep = newParams.binStep;

        // Calculate number of bins on each side of initial price
        const minId = getIdFromPrice(lowerPrice, binStep);
        const maxId = getIdFromPrice(upperPrice, binStep);
        const initialPriceId = getIdFromPrice(initialPrice, binStep);

        // Handle edge cases where initial price is outside the range
        let quoteBinsCount: number;
        let baseBinsCount: number;

        if (initialPriceId < minId) {
          // Initial price is below range - all bins are base bins
          quoteBinsCount = 0;
          baseBinsCount = (maxId - minId) + 1;
        } else if (initialPriceId > maxId) {
          // Initial price is above range - all bins are quote bins
          quoteBinsCount = (maxId - minId) + 1;
          baseBinsCount = 0;
        } else {
          // Initial price is within range
          quoteBinsCount = (initialPriceId - minId) + 1;
          baseBinsCount = maxId - initialPriceId;
        }

        if (field === 'baseAmount') {
          if (quoteBinsCount > 0 && baseBinsCount > 0) {
            if (newParams.strategy === 'spot') {
              let sumInvPrice = 0;
              for (let id = minId; id <= maxId; id++) {
                const price = getPriceFromId(id, binStep);
                if (id > initialPriceId) {
                  sumInvPrice += 1 / price;
                }
              }
              newParams.quoteAmount = finalValue / sumInvPrice * quoteBinsCount;
            } else {
              newParams.quoteAmount = (finalValue * initialPrice * quoteBinsCount) / baseBinsCount;
            }
          } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
            // Price below range - only base bins exist, zero out quote
            newParams.quoteAmount = 0;
          } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
            // Price above range - only quote bins exist, zero out base
            newParams.baseAmount = 0;
          }
          setLastAutoFilledToken('quote');
        } else {
          if (quoteBinsCount > 0 && baseBinsCount > 0) {
            if (newParams.strategy === 'spot') {
              let sumInvPrice = 0;
              for (let id = minId; id <= maxId; id++) {
                const price = getPriceFromId(id, binStep);
                if (id > initialPriceId) {
                  sumInvPrice += 1 / price;
                }
              }
              newParams.baseAmount = finalValue / quoteBinsCount * sumInvPrice;
            } else {
              newParams.baseAmount = (finalValue * baseBinsCount) / (initialPrice * quoteBinsCount);
            }
          } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
            // Price below range - only base bins exist, zero out quote
            newParams.quoteAmount = 0;
          } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
            // Price above range - only quote bins exist, zero out base
            newParams.baseAmount = 0;
          }
          setLastAutoFilledToken('base');
        }
      }

      setParams(newParams);
    } else {
      setParams(prev => ({ ...prev, [field]: finalValue }));
    }
  };

  const handleStrategyChange = (value: Strategy) => {
    setParams(prev => ({ ...prev, strategy: value }));
  }

  const handleClear = () => {
    setParams(defaultParams);
    setCurrentPrice(defaultParams.initialPrice);
    setInitialBins([]);
    setSimulation(null);
    setSelectedPool(null);
    setTokenSymbols({ base: 'Base', quote: 'Quote' });
    setLowerPricePercentage('');
    setUpperPricePercentage('');
  };
  
  const handleInitialPriceChange = (newInitialPrice: number) => {
    setParams(prev => ({...prev, initialPrice: newInitialPrice}));
    setCurrentPrice(newInitialPrice);
  }

  const handleCurrentPriceChange = (newCurrentPrice: number) => {
    setCurrentPrice(newCurrentPrice);
  }

  const handlePoolSelect = (pool: MeteoraPair) => {
    setSelectedPool(pool);

    // Update token symbols
    const symbols = parseTokenSymbols(pool.name);
    setTokenSymbols(symbols);

    // Calculate price range: 69 bins centered around initial price
    const currentBinId = getIdFromPrice(pool.current_price, pool.bin_step);
    const lowerBinId = currentBinId - 34;
    const upperBinId = currentBinId + 34;

    // Add small epsilon to ensure the bin IDs are included when converting back
    // This accounts for floating-point precision issues
    const basis = 1 + pool.bin_step / 10000;
    const lowerPrice = getPriceFromId(lowerBinId, pool.bin_step) * Math.pow(basis, 0.01);
    const upperPrice = getPriceFromId(upperBinId, pool.bin_step) * Math.pow(basis, 0.99);

    // Update simulation params
    setParams(prev => ({
      ...prev,
      binStep: pool.bin_step,
      initialPrice: pool.current_price,
      lowerPrice: lowerPrice,
      upperPrice: upperPrice,
    }));

    // Update current price to match the pool
    setCurrentPrice(pool.current_price);
  };

  const analysis = simulation?.analysis;

  const initialTotalValue = useMemo(() => {
    if (!initialBins || initialBins.length === 0) return 0;
    if (params.strategy === 'spot') {
      return initialBins.reduce((sum, bin) => sum + bin.displayValue, 0);
    }
    return initialBins.reduce((sum, bin) => sum + bin.initialValueInQuote, 0);
  }, [initialBins, params.strategy]);
  
  
  // Position Value Change
  const valueChange = analysis && initialTotalValue > 0 ? ((analysis.totalValueInQuote - initialTotalValue) / initialTotalValue) * 100 : 0;
  const formattedValueChange = valueChange.toFixed(2);
  let valueChangeDisplay: string | undefined;
  let valueChangeColorClass: string | undefined;

  if (analysis) {
    if (Math.abs(valueChange) < 0.001) {
      valueChangeDisplay = '0.00%';
      valueChangeColorClass = '';
    } else if (valueChange > 0) {
      valueChangeDisplay = `+${formattedValueChange}%`;
      valueChangeColorClass = 'text-green-400';
    } else {
      valueChangeDisplay = `${formattedValueChange}%`;
      valueChangeColorClass = 'text-red-400';
    }
  }

  // Price Pct. Change
  const priceChange = simulationParams && simulationParams.initialPrice > 0 && typeof currentPrice === 'number'
    ? ((currentPrice - simulationParams.initialPrice) / simulationParams.initialPrice) * 100
    : 0;
  const formattedPriceChange = priceChange.toFixed(2);
  let priceChangeDisplay: string;
  let priceChangeColorClass: string;
  
  if (Math.abs(priceChange) < 0.001) {
    priceChangeDisplay = '0.00%';
    priceChangeColorClass = '';
  } else if (priceChange > 0) {
    priceChangeDisplay = `+${formattedPriceChange}%`;
    priceChangeColorClass = 'text-green-400';
  } else {
    priceChangeDisplay = `${formattedPriceChange}%`;
    priceChangeColorClass = 'text-red-400';
  }

  // Impermanent Loss vs HODL
  const profitLoss = analysis ? analysis.totalValueInQuote - initialTotalValue : 0;

  let plColorClass: string | undefined;
  if (analysis) {
    if (Math.abs(profitLoss) < 0.00000001) {
        plColorClass = '';
    } else if (profitLoss > 0) {
      plColorClass = 'text-green-400';
    } else {
      plColorClass = 'text-red-400';
    }
  }

  const isPristine = typeof currentPrice === 'number' && typeof params.initialPrice === 'number' && Math.abs(currentPrice - params.initialPrice) < 1e-9;
  const displayBase = isPristine && typeof params.baseAmount === 'number' ? params.baseAmount : analysis?.totalBase ?? 0;
  const displayQuote = isPristine && typeof params.quoteAmount === 'number' ? params.quoteAmount : analysis?.totalQuote ?? 0;

  // Calculate average price paid based on conversions that occurred
  const averagePricePaid = useMemo(() => {
    if (!simulation?.simulatedBins || typeof currentPrice !== 'number' || typeof params.initialPrice !== 'number') {
      return typeof params.initialPrice === 'number' ? params.initialPrice : 0;
    }

    // If price hasn't moved, average price is just the initial price
    if (Math.abs(currentPrice - params.initialPrice) < 1e-9) {
      return params.initialPrice;
    }

    // Calculate weighted average of bin prices where conversions occurred
    let totalConvertedValue = 0;
    let totalConvertedAmount = 0;

    simulation.simulatedBins.forEach(bin => {
      // A bin has converted if its current type differs from initial type
      if (bin.initialAmount > 0 && bin.currentTokenType !== bin.initialTokenType) {
        // This bin underwent conversion at its bin price
        totalConvertedValue += bin.initialValueInQuote;
        totalConvertedAmount += bin.initialValueInQuote / bin.price;
      }
    });

    // If no conversions occurred, return initial price
    if (totalConvertedAmount === 0) {
      return params.initialPrice;
    }

    // Weighted average price = total value / total amount converted
    return totalConvertedValue / totalConvertedAmount;
  }, [simulation, currentPrice, params.initialPrice]);

  // Determine label for average price card based on price movement
  const avgPriceLabel = useMemo(() => {
    if (typeof currentPrice !== 'number' || typeof params.initialPrice !== 'number') {
      return 'Initial Price';
    }

    if (Math.abs(currentPrice - params.initialPrice) < 1e-9) {
      return 'Initial Price';
    } else if (currentPrice < params.initialPrice) {
      return 'Avg Price Paid';
    } else {
      return 'Avg Price Sold';
    }
  }, [currentPrice, params.initialPrice]);


  return (
    <DlmmContext.Provider value={{params}}>
    <div className="flex flex-col gap-8">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-6 rounded-2xl bg-gradient-to-r from-primary/10 via-purple-500/10 to-primary/10 border border-primary/20 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary/20 backdrop-blur-sm">
            <Logo className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-primary via-purple-400 to-primary bg-clip-text text-transparent">Meteora DLMM Position Simulator</h1>
            <p className="text-sm text-muted-foreground mt-1">Visualize and analyze your liquidity positions</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleClear} className="hover:bg-primary/10 transition-all duration-300">
          <RefreshCcw className="mr-2 h-4 w-4" />Clear All
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">Search for a Pool</CardTitle>
              <CardDescription>Search and select a Meteora DLMM pool to simulate, or manually enter the position information below.</CardDescription>
            </CardHeader>
            <CardContent>
              <PoolSelector onSelectPool={handlePoolSelect} selectedPool={selectedPool} />
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Layers className="h-4 w-4 text-primary" />
                </div>
                Pool Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="binStep" className="flex items-center gap-1.5 text-sm font-medium">
                  <Footprints className="w-4 h-4 text-primary" />
                  Bin Step
                </Label>
                <Input id="binStep" type="number" value={params.binStep} onChange={e => handleParamChange('binStep', e.target.value)} className="transition-all duration-300 focus:ring-2 focus:ring-primary/50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Coins className="h-4 w-4 text-primary" />
                </div>
                Liquidity Position
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label className="flex items-center gap-1.5 text-sm font-medium">
                  <MoveHorizontal className="w-4 h-4 text-primary" />
                  Strategy
                </Label>
                <RadioGroup value={params.strategy} onValueChange={handleStrategyChange} className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="spot" id="spot" />
                    <Label htmlFor="spot" className="cursor-pointer">Spot</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="bid-ask" id="bid-ask" />
                    <Label htmlFor="bid-ask" className="cursor-pointer">Bid-Ask</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="curve" id="curve" />
                    <Label htmlFor="curve" className="cursor-pointer">Curve</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center gap-1.5 text-sm font-medium">
                  <ChevronsLeftRight className="w-4 h-4 text-primary" />
                  Price Range
                </Label>
                <div className="grid gap-2">
                  <div className="flex gap-2">
                    <Input
                      id="lowerPrice"
                      type="number"
                      placeholder="Min Price"
                      value={params.lowerPrice}
                      onChange={e => handleParamChange('lowerPrice', e.target.value)}
                      step="0.000001"
                      className="flex-1 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="relative w-24">
                      <Input
                        id="lowerPricePercentage"
                        type="number"
                        value={lowerPricePercentage}
                        onChange={e => handlePricePercentageChange('lower', e.target.value)}
                        placeholder="%"
                        step="0.01"
                        className="pr-6 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="upperPrice"
                      type="number"
                      placeholder="Max Price"
                      value={params.upperPrice}
                      onChange={e => handleParamChange('upperPrice', e.target.value)}
                      step="0.000001"
                      className="flex-1 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="relative w-24">
                      <Input
                        id="upperPricePercentage"
                        type="number"
                        value={upperPricePercentage}
                        onChange={e => handlePricePercentageChange('upper', e.target.value)}
                        placeholder="%"
                        step="0.01"
                        className="pr-6 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border/50">
                <Label htmlFor="autoFill" className="text-sm font-medium cursor-pointer">Auto-Fill</Label>
                <Switch id="autoFill" checked={autoFill} onCheckedChange={setAutoFill} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="baseAmount" className="text-sm font-medium">{tokenSymbols.base} Token Amount</Label>
                <Input id="baseAmount" type="number" value={params.baseAmount} onChange={e => handleParamChange('baseAmount', e.target.value)} className="transition-all duration-300 focus:ring-2 focus:ring-primary/50" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="quoteAmount" className="text-sm font-medium">{tokenSymbols.quote} Token Amount</Label>
                <Input id="quoteAmount" type="number" value={params.quoteAmount} onChange={e => handleParamChange('quoteAmount', e.target.value)} className="transition-all duration-300 focus:ring-2 focus:ring-primary/50" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="initialPrice" className="text-sm font-medium">Initial Price</Label>
                <Input
                  id="initialPrice"
                  type="number"
                  value={params.initialPrice}
                  onChange={e => handleParamChange('initialPrice', e.target.value)}
                  step="0.000001"
                  className="transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-6">
          <Card className="flex-grow flex flex-col border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="p-2 rounded-lg bg-primary/10">
                  <CandlestickChart className="h-4 w-4 text-primary" />
                </div>
                {selectedPool && params.binStep ? `Liquidity Distribution for ${selectedPool.name} ${params.binStep} Bin Step` : 'Liquidity Distribution'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-grow flex flex-col justify-center gap-4 pt-8">
              <div className="h-80 w-full">
                {simulationParams && typeof currentPrice === 'number' && typeof params.initialPrice === 'number' && typeof params.lowerPrice === 'number' && typeof params.upperPrice === 'number' ? (
                  <LiquidityChart
                    bins={initialBins}
                    simulatedBins={simulation?.simulatedBins ?? []}
                    currentPrice={currentPrice}
                    initialPrice={params.initialPrice}
                    lowerPrice={params.lowerPrice}
                    upperPrice={params.upperPrice}
                    onCurrentPriceChange={handleCurrentPriceChange}
                    onInitialPriceChange={handleInitialPriceChange}
                  />
                ) : <div className="flex items-center justify-center h-full text-muted-foreground">Enter parameters to see chart.</div>}
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="text-lg">Position Analysis</CardTitle>
            </CardHeader>
            <CardContent>
              {analysis ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Initial Position Value</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={initialTotalValue} maximumFractionDigits={4} /></span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Current Position Value</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={analysis.totalValueInQuote} maximumFractionDigits={4} /></span>
                  </div>
                  <div className={`metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm ${valueChangeColorClass}`}>
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Position Value Change</span>
                    <span className="font-bold text-xl mt-1">{valueChangeDisplay}</span>
                  </div>
                  <div className={`metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm ${plColorClass}`}>
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Profit/Loss</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={profitLoss} maximumFractionDigits={4} /></span>
                  </div>
                  <div className={`metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm ${priceChangeColorClass}`}>
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Price Pct. Change</span>
                    <span className="font-bold text-xl mt-1">{priceChangeDisplay}</span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">{tokenSymbols.base} Tokens</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={displayBase} maximumFractionDigits={4} /></span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">{tokenSymbols.quote} Tokens</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={displayQuote} maximumFractionDigits={4} /></span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Total Bins</span>
                    <span className="font-bold text-xl mt-1">{analysis.totalBins}</span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Base Bins</span>
                    <span className="font-bold text-xl mt-1">{analysis.baseBins}</span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">Quote Bins</span>
                    <span className="font-bold text-xl mt-1">{analysis.quoteBins}</span>
                  </div>
                  <div className="metric-card flex flex-col gap-1 p-4 bg-gradient-to-br from-secondary/80 to-secondary/40 rounded-xl border border-border/50 backdrop-blur-sm">
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">{avgPriceLabel}</span>
                    <span className="font-bold text-xl mt-1"><FormattedNumber value={averagePricePaid} maximumFractionDigits={4} /></span>
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">Adjust parameters to see analysis.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
    </DlmmContext.Provider>
  );
}
