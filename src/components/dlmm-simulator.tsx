
"use client";

import { useState, useMemo, useEffect, createContext, useContext, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { getInitialBins, runSimulation, getIdFromPrice, getPriceFromId, type SimulationParams, type Analysis, type SimulatedBin, type Strategy } from "@/lib/dlmm";
import { LiquidityChart } from "@/components/liquidity-chart";
import { Logo } from "@/components/icons";
import { Layers, CandlestickChart, Coins, ChevronsLeftRight, Footprints, RefreshCcw, MoveHorizontal, ExternalLink } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import { formatNumberForDisplay } from "@/lib/display-formatting";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { PoolSelector } from "@/components/pool-selector";
import { ShareButton } from '@/components/share-button';
import { ThemeToggle } from "@/components/theme-toggle";
import { MeteoraPair, parseTokenSymbols } from "@/lib/meteora-api";
import { reverseEngineerDecimals } from "@/lib/dlmm-sdk-wrapper";

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
   baseDecimals: number;
   quoteDecimals: number;
   applyDecimalAdjustment: boolean;
   tokenSymbols: { base: string; quote: string };
 };

const DlmmContext = createContext<DlmmContextType | null>(null);

export const useDlmmContext = () => {
  const context = useContext(DlmmContext);
  if (!context) {
    throw new Error("useDlmmContext must be used within a DlmmSimulator");
  }
  return context;
};


const FormattedNumber = ({ value, maximumFractionDigits = 4 }: { value: number; maximumFractionDigits?: number }) => {
  const formatted = formatNumberForDisplay(value, { maximumFractionDigits });

  // Handle subscript notation in JSX
  if (formatted.includes('₍')) {
    const match = formatted.match(/(.*)₍(\d+)₎(.*)/);
    if (match) {
      const [, prefix, subNum, suffix] = match;
      return <>{prefix}<sub>{subNum}</sub>{suffix}</>;
    }
  }

  return <>{formatted}</>;
};


export function DlmmSimulator() {
  const [params, setParams] = useState<PartialSimulationParams>(defaultParams);
  const [currentPrice, setCurrentPrice] = useState<number | ''>(defaultParams.initialPrice);
  const [initialBins, setInitialBins] = useState<SimulatedBin[]>([]);
  const [simulation, setSimulation] = useState<{ simulatedBins: SimulatedBin[], analysis: Analysis } | null>(null);
  const [selectedPool, setSelectedPool] = useState<MeteoraPair | null>(null);
  const [tokenSymbols, setTokenSymbols] = useState<{ base: string; quote: string }>({ base: 'Base', quote: 'Quote' });
  const [baseDecimals, setBaseDecimals] = useState<number>(9); // Default to SOL decimals
  const [quoteDecimals, setQuoteDecimals] = useState<number>(6); // Default to USDC decimals
  const [applyDecimalAdjustment, setApplyDecimalAdjustment] = useState<boolean>(true);
  const [decimalsDetermined, setDecimalsDetermined] = useState<boolean>(true);
  const [autoFill, setAutoFill] = useState(false);
  const [lastAutoFilledToken, setLastAutoFilledToken] = useState<'base' | 'quote' | null>(null);
  const [lowerPricePercentage, setLowerPricePercentage] = useState<number | ''>('');
  const [upperPricePercentage, setUpperPricePercentage] = useState<number | ''>('');
  const [lowerPriceInput, setLowerPriceInput] = useState<string>('');
  const [upperPriceInput, setUpperPriceInput] = useState<string>('');
  const [initialPriceInput, setInitialPriceInput] = useState<string>('');
  const [baseAmountInput, setBaseAmountInput] = useState<string>('');
  const [quoteAmountInput, setQuoteAmountInput] = useState<string>('');
  const [initialPoolAddress, setInitialPoolAddress] = useState<string | null>(null);
  const [clearKey, setClearKey] = useState(0);
  const searchParams = useSearchParams();
  const hasLoadedRef = useRef(false);
  const isEditingPercentageRef = useRef<{ lower: boolean; upper: boolean }>({ lower: false, upper: false });
  const isEditingPriceRef = useRef<{ lower: boolean; upper: boolean; initial: boolean }>({ lower: false, upper: false, initial: false });
  const isEditingAmountRef = useRef<{ base: boolean; quote: boolean }>({ base: false, quote: false });

  const simulationParams = useMemo(() => {
    const allParamsSet =
      params.binStep !== '' &&
      params.initialPrice !== '' &&
      params.baseAmount !== '' &&
      params.quoteAmount !== '' &&
      params.lowerPrice !== '' &&
      params.upperPrice !== '';

    if (!allParamsSet) return null;

    return {
      ...params as SimulationParams,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    };
  }, [params, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const formatTokenAmountForDisplay = useCallback((amount: number | '', decimals: number): string => {
    if (amount === '') return '';
    // Round to token decimals and remove trailing zeros
    const rounded = Math.floor(amount * Math.pow(10, decimals)) / Math.pow(10, decimals);
    // Convert to string with full precision, then remove trailing zeros
    const fixedString = rounded.toFixed(decimals);
    // Remove trailing zeros and unnecessary decimal point
    return fixedString.replace(/\.?0+$/, '');
  }, []);

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
      const result = runSimulation(initialBins, currentPrice, simulationParams.initialPrice);
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
      if (typeof params.lowerPrice === 'number' && !isEditingPercentageRef.current.lower) {
        const lowerPct = ((params.lowerPrice - params.initialPrice) / params.initialPrice) * 100;
        setLowerPricePercentage(Number(lowerPct.toFixed(2)));
      } else if (typeof params.lowerPrice !== 'number') {
        setLowerPricePercentage('');
      }

      if (typeof params.upperPrice === 'number' && !isEditingPercentageRef.current.upper) {
        const upperPct = ((params.upperPrice - params.initialPrice) / params.initialPrice) * 100;
        setUpperPricePercentage(Number(upperPct.toFixed(2)));
      } else if (typeof params.upperPrice !== 'number') {
        setUpperPricePercentage('');
      }
    } else {
      setLowerPricePercentage('');
      setUpperPricePercentage('');
    }
  }, [params.lowerPrice, params.upperPrice, params.initialPrice]);

  // Sync price input fields when params change (but not when user is editing)
  useEffect(() => {
    if (!isEditingPriceRef.current.lower) {
      const significantDecimals = Math.max(quoteDecimals, 6);
      setLowerPriceInput(params.lowerPrice === '' ? '' : params.lowerPrice.toFixed(significantDecimals));
    }
  }, [params.lowerPrice, quoteDecimals]);

  useEffect(() => {
    if (!isEditingPriceRef.current.upper) {
      const significantDecimals = Math.max(quoteDecimals, 6);
      setUpperPriceInput(params.upperPrice === '' ? '' : params.upperPrice.toFixed(significantDecimals));
    }
  }, [params.upperPrice, quoteDecimals]);

  useEffect(() => {
    if (!isEditingPriceRef.current.initial) {
      const significantDecimals = Math.max(quoteDecimals, 6);
      setInitialPriceInput(params.initialPrice === '' ? '' : params.initialPrice.toFixed(significantDecimals));
    }
  }, [params.initialPrice, quoteDecimals]);

  // Sync amount input fields when params change (but not when user is editing)
  useEffect(() => {
    if (!isEditingAmountRef.current.base) {
      setBaseAmountInput(formatTokenAmountForDisplay(params.baseAmount, baseDecimals));
    }
  }, [params.baseAmount, baseDecimals, formatTokenAmountForDisplay]);

  useEffect(() => {
    if (!isEditingAmountRef.current.quote) {
      setQuoteAmountInput(formatTokenAmountForDisplay(params.quoteAmount, quoteDecimals));
    }
  }, [params.quoteAmount, quoteDecimals, formatTokenAmountForDisplay]);

  // Auto-fill when toggle is turned on
  useEffect(() => {
    if (!autoFill || !hasLoadedRef.current) return;

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

    // Helper function to calculate weighted sums based on strategy
    const calculateWeightedSums = () => {
      let quoteSumWeight = 0;
      let baseSumWeightOverPrice = 0;

      if (params.strategy === 'spot') {
        // Spot: equal value per bin
        for (let id = minId; id <= maxId; id++) {
          const price = getPriceFromId(id, binStep);
          if (id > initialPriceId) {
            baseSumWeightOverPrice += 1 / price;
          }
        }
        quoteSumWeight = quoteBinsCount;
      } else {
        // Bid-ask or curve: weighted distribution
        for (let id = minId; id <= initialPriceId; id++) {
          const dist = initialPriceId - id;
          const weight = params.strategy === 'curve'
            ? Math.max(1, initialPriceId - minId - dist)
            : dist + 1;
          quoteSumWeight += weight;
        }

        for (let id = initialPriceId + 1; id <= maxId; id++) {
          const dist = id - initialPriceId;
          const weight = params.strategy === 'curve'
            ? Math.max(1, maxId - initialPriceId - dist)
            : dist + 1;
          const price = getPriceFromId(id, binStep);
          baseSumWeightOverPrice += weight / price;
        }
      }

      return { quoteSumWeight, baseSumWeightOverPrice };
    };

    // Determine which token to calculate
    const hasQuote = typeof params.quoteAmount === 'number' && params.quoteAmount !== 0;
    const hasBase = typeof params.baseAmount === 'number' && params.baseAmount !== 0;

    if (!hasQuote && !hasBase) {
      // Neither is filled, nothing to auto-fill
      return;
    }

    let newParams = { ...params };

    // If both are filled, recalculate base based on quote
    if (hasQuote && hasBase) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
        newParams.baseAmount = (params.quoteAmount as number) * (baseSumWeightOverPrice / quoteSumWeight);
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
      return;
    }

    // Only one is filled, calculate the other
    if (hasQuote && !hasBase) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
        newParams.baseAmount = (params.quoteAmount as number) * (baseSumWeightOverPrice / quoteSumWeight);
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
    } else if (hasBase && !hasQuote) {
      if (quoteBinsCount > 0 && baseBinsCount > 0) {
        const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
        newParams.quoteAmount = (params.baseAmount as number) * (quoteSumWeight / baseSumWeightOverPrice);
      } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
        newParams.quoteAmount = 0;
      } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
        newParams.baseAmount = 0;
      }
      setLastAutoFilledToken('quote');
      setParams(newParams);
    }
  }, [autoFill, params.lowerPrice, params.upperPrice, params.binStep, params.strategy]);

  // Recalculate auto-filled token when initial price changes
  useEffect(() => {
    if (!autoFill || !lastAutoFilledToken || !hasLoadedRef.current) return;
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

    // Helper function to calculate weighted sums
    const calculateWeightedSums = () => {
      let quoteSumWeight = 0;
      let baseSumWeightOverPrice = 0;

      if (params.strategy === 'spot') {
        for (let id = minId; id <= maxId; id++) {
          const price = getPriceFromId(id, binStep);
          if (id > initialPriceId) {
            baseSumWeightOverPrice += 1 / price;
          }
        }
        quoteSumWeight = quoteBinsCount;
      } else {
        for (let id = minId; id <= initialPriceId; id++) {
          const dist = initialPriceId - id;
          const weight = params.strategy === 'curve'
            ? Math.max(1, initialPriceId - minId - dist)
            : dist + 1;
          quoteSumWeight += weight;
        }

        for (let id = initialPriceId + 1; id <= maxId; id++) {
          const dist = id - initialPriceId;
          const weight = params.strategy === 'curve'
            ? Math.max(1, maxId - initialPriceId - dist)
            : dist + 1;
          const price = getPriceFromId(id, binStep);
          baseSumWeightOverPrice += weight / price;
        }
      }

      return { quoteSumWeight, baseSumWeightOverPrice };
    };

    let newParams = { ...params };

    if (lastAutoFilledToken === 'quote') {
      // Recalculate quote based on base
      if (typeof params.baseAmount === 'number') {
        if (quoteBinsCount > 0 && baseBinsCount > 0) {
          const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
          newParams.quoteAmount = params.baseAmount * (quoteSumWeight / baseSumWeightOverPrice);
        } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
          newParams.quoteAmount = 0;
        } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
          newParams.baseAmount = 0;
        }
        setParams(newParams);
      }
    } else if (lastAutoFilledToken === 'base') {
      // Recalculate base based on quote
      if (typeof params.quoteAmount === 'number') {
        if (quoteBinsCount > 0 && baseBinsCount > 0) {
          const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
          newParams.baseAmount = params.quoteAmount * (baseSumWeightOverPrice / quoteSumWeight);
        } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
          newParams.quoteAmount = 0;
        } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
          newParams.baseAmount = 0;
        }
        setParams(newParams);
      }
    }
  }, [params.initialPrice, autoFill, lastAutoFilledToken, params.strategy]);

  // Parse URL parameters on mount
  useEffect(() => {
    const pool = searchParams.get('pool');
    if (pool) {
      setInitialPoolAddress(pool);
    }

    const binStepStr = searchParams.get('binStep');
    if (binStepStr) {
      const num = parseFloat(binStepStr);
      if (!isNaN(num) && num > 0) {
        setParams(prev => ({ ...prev, binStep: num }));
      }
    }

    const strategy = searchParams.get('strategy');
    if (strategy && ['spot', 'bid-ask', 'curve'].includes(strategy)) {
      setParams(prev => ({ ...prev, strategy: strategy as Strategy }));
    }

    const lowerPriceStr = searchParams.get('lowerPrice');
    if (lowerPriceStr) {
      const num = parseFloat(lowerPriceStr);
      if (!isNaN(num) && num > 0) {
        setParams(prev => ({ ...prev, lowerPrice: num }));
      }
    }

    const upperPriceStr = searchParams.get('upperPrice');
    if (upperPriceStr) {
      const num = parseFloat(upperPriceStr);
      if (!isNaN(num) && num > 0) {
        setParams(prev => ({ ...prev, upperPrice: num }));
      }
    }

    const baseAmountStr = searchParams.get('baseAmount');
    if (baseAmountStr) {
      const num = parseFloat(baseAmountStr);
      if (!isNaN(num) && num >= 0) {
        setParams(prev => ({ ...prev, baseAmount: num }));
      }
    }

    const quoteAmountStr = searchParams.get('quoteAmount');
    if (quoteAmountStr) {
      const num = parseFloat(quoteAmountStr);
      if (!isNaN(num) && num >= 0) {
        setParams(prev => ({ ...prev, quoteAmount: num }));
      }
    }

    const initialPriceStr = searchParams.get('initialPrice');
    if (initialPriceStr) {
      const num = parseFloat(initialPriceStr);
      if (!isNaN(num) && num > 0) {
        setParams(prev => ({ ...prev, initialPrice: num }));
      }
    }

    const currentPriceStr = searchParams.get('currentPrice');
    if (currentPriceStr) {
      const num = parseFloat(currentPriceStr);
      if (!isNaN(num) && num > 0) {
        setCurrentPrice(num);
      }
    }

    const autoFillStr = searchParams.get('autoFill');
    if (autoFillStr === 'true') {
      setAutoFill(true);
    }

    hasLoadedRef.current = true;
  }, [searchParams]);

  const roundPriceToDecimals = (price: number): number => {
    // Price = quote/base, so the precision depends on both token decimals
    // We'll use the quote decimals as the primary precision since price is denominated in quote
    const significantDecimals = Math.max(quoteDecimals, 6); // At least 6 decimals for precision
    const multiplier = Math.pow(10, significantDecimals);
    return Math.floor(price * multiplier) / multiplier;
  };

  const handlePricePercentageChange = (priceType: 'lower' | 'upper', value: string) => {
    const numValue = parseFloat(value);
    const finalValue = value === '' ? '' : numValue;

    // Mark that we're editing this percentage field
    if (priceType === 'lower') {
      isEditingPercentageRef.current.lower = true;
      setLowerPricePercentage(finalValue);
    } else {
      isEditingPercentageRef.current.upper = true;
      setUpperPricePercentage(finalValue);
    }

    // Calculate absolute price from percentage (no rounding yet - that happens on blur)
    if (typeof finalValue === 'number' && typeof params.initialPrice === 'number' && params.initialPrice > 0) {
      const newPrice = params.initialPrice * (1 + finalValue / 100);

      if (priceType === 'lower') {
        setParams(prev => ({ ...prev, lowerPrice: newPrice }));
      } else {
        setParams(prev => ({ ...prev, upperPrice: newPrice }));
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

  const handlePercentageBlur = (priceType: 'lower' | 'upper') => {
    // Clear the editing flag
    if (priceType === 'lower') {
      isEditingPercentageRef.current.lower = false;
    } else {
      isEditingPercentageRef.current.upper = false;
    }

    const field = priceType === 'lower' ? 'lowerPrice' : 'upperPrice';
    const currentValue = params[field];

    if (typeof currentValue !== 'number' || typeof params.binStep !== 'number' || params.binStep <= 0) {
      return;
    }

    // Round to nearest valid bin price, then round to token decimals
    const binId = getIdFromPrice(currentValue, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    const roundedPrice = getPriceFromId(binId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);

    let finalValue: number;

    // Validate that the rounded price maintains valid range (upperPrice > lowerPrice)
    if (field === 'lowerPrice') {
      // Ensure lowerPrice stays below upperPrice
      if (typeof params.upperPrice === 'number' && roundedPrice >= params.upperPrice) {
        // Find the bin just below upperPrice
        const upperBinId = getIdFromPrice(params.upperPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        const safeLowerBinId = upperBinId - 1;
        finalValue = getPriceFromId(safeLowerBinId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      } else {
        finalValue = roundedPrice;
      }
    } else {
      // field === 'upperPrice'
      // Ensure upperPrice stays above lowerPrice
      if (typeof params.lowerPrice === 'number' && roundedPrice <= params.lowerPrice) {
        // Find the bin just above lowerPrice
        const lowerBinId = getIdFromPrice(params.lowerPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        const safeUpperBinId = lowerBinId + 1;
        finalValue = getPriceFromId(safeUpperBinId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      } else {
        finalValue = roundedPrice;
      }
    }

    setParams(prev => ({ ...prev, [field]: finalValue }));
  };

  const handleParamChange = (field: keyof PartialSimulationParams, value: string) => {
    // Mark that we're editing this field and update input state
    if (field === 'lowerPrice') {
      isEditingPriceRef.current.lower = true;
      setLowerPriceInput(value);
      isEditingPercentageRef.current.lower = false;
    } else if (field === 'upperPrice') {
      isEditingPriceRef.current.upper = true;
      setUpperPriceInput(value);
      isEditingPercentageRef.current.upper = false;
    } else if (field === 'initialPrice') {
      isEditingPriceRef.current.initial = true;
      setInitialPriceInput(value);
    } else if (field === 'baseAmount') {
      isEditingAmountRef.current.base = true;
      setBaseAmountInput(value);
    } else if (field === 'quoteAmount') {
      isEditingAmountRef.current.quote = true;
      setQuoteAmountInput(value);
    }

    const numValue = parseFloat(value);
    const finalValue: number | '' = value === '' ? '' : numValue;

    // For price fields, just store the raw value without rounding
    // Rounding will happen on blur
    if (field === 'initialPrice') {
      setParams(prev => ({ ...prev, initialPrice: finalValue }));
      setCurrentPrice(finalValue);
    } else if (field === 'lowerPrice' || field === 'upperPrice') {
      setParams(prev => ({ ...prev, [field]: finalValue }));
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

        // Helper function to calculate weighted sums
        const calculateWeightedSums = () => {
          let quoteSumWeight = 0;
          let baseSumWeightOverPrice = 0;

          if (newParams.strategy === 'spot') {
            for (let id = minId; id <= maxId; id++) {
              const price = getPriceFromId(id, binStep);
              if (id > initialPriceId) {
                baseSumWeightOverPrice += 1 / price;
              }
            }
            quoteSumWeight = quoteBinsCount;
          } else {
            for (let id = minId; id <= initialPriceId; id++) {
              const dist = initialPriceId - id;
              const weight = newParams.strategy === 'curve'
                ? Math.max(1, initialPriceId - minId - dist)
                : dist + 1;
              quoteSumWeight += weight;
            }

            for (let id = initialPriceId + 1; id <= maxId; id++) {
              const dist = id - initialPriceId;
              const weight = newParams.strategy === 'curve'
                ? Math.max(1, maxId - initialPriceId - dist)
                : dist + 1;
              const price = getPriceFromId(id, binStep);
              baseSumWeightOverPrice += weight / price;
            }
          }

          return { quoteSumWeight, baseSumWeightOverPrice };
        };

        if (field === 'baseAmount') {
          if (quoteBinsCount > 0 && baseBinsCount > 0) {
            const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
            newParams.quoteAmount = finalValue * (quoteSumWeight / baseSumWeightOverPrice);
          } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
            newParams.quoteAmount = 0;
          } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
            newParams.baseAmount = 0;
          }
          setLastAutoFilledToken('quote');
        } else {
          if (quoteBinsCount > 0 && baseBinsCount > 0) {
            const { quoteSumWeight, baseSumWeightOverPrice } = calculateWeightedSums();
            newParams.baseAmount = finalValue * (baseSumWeightOverPrice / quoteSumWeight);
          } else if (baseBinsCount > 0 && quoteBinsCount === 0) {
            newParams.quoteAmount = 0;
          } else if (quoteBinsCount > 0 && baseBinsCount === 0) {
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

  const handlePriceBlur = (field: 'lowerPrice' | 'upperPrice' | 'initialPrice') => {
    // Clear the editing flag
    if (field === 'lowerPrice') {
      isEditingPriceRef.current.lower = false;
    } else if (field === 'upperPrice') {
      isEditingPriceRef.current.upper = false;
    } else if (field === 'initialPrice') {
      isEditingPriceRef.current.initial = false;
    }

    const currentValue = params[field];
    if (typeof currentValue !== 'number' || typeof params.binStep !== 'number' || params.binStep <= 0) {
      return;
    }

    // Auto-round lower/upper prices to nearest valid bin price, then round to token decimals
    if (field === 'lowerPrice' || field === 'upperPrice') {
      const binId = getIdFromPrice(currentValue, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      const roundedPrice = getPriceFromId(binId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);

      let finalValue: number;

      // Validate that the rounded price maintains valid range (upperPrice > lowerPrice)
      if (field === 'lowerPrice') {
        // Ensure lowerPrice stays below upperPrice
        if (typeof params.upperPrice === 'number' && roundedPrice >= params.upperPrice) {
          // Find the bin just below upperPrice
          const upperBinId = getIdFromPrice(params.upperPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
          const safeLowerBinId = upperBinId - 1;
          finalValue = getPriceFromId(safeLowerBinId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        } else {
          finalValue = roundedPrice;
        }
      } else {
        // field === 'upperPrice'
        // Ensure upperPrice stays above lowerPrice
        if (typeof params.lowerPrice === 'number' && roundedPrice <= params.lowerPrice) {
          // Find the bin just above lowerPrice
          const lowerBinId = getIdFromPrice(params.lowerPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
          const safeUpperBinId = lowerBinId + 1;
          finalValue = getPriceFromId(safeUpperBinId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        } else {
          finalValue = roundedPrice;
        }
      }

      setParams(prev => ({ ...prev, [field]: finalValue }));
    } else if (field === 'initialPrice') {
      // Round initial price to nearest bin
      const binId = getIdFromPrice(currentValue, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      const roundedPrice = getPriceFromId(binId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      setParams(prev => ({ ...prev, initialPrice: roundedPrice }));
      setCurrentPrice(roundedPrice);
    }
  };

  const handleStrategyChange = (value: Strategy) => {
    setParams(prev => ({ ...prev, strategy: value }));
  }

  const handleAmountBlur = (field: 'baseAmount' | 'quoteAmount') => {
    // Round the amount to the token's decimals
    const currentValue = params[field];
    if (typeof currentValue === 'number') {
      const decimals = field === 'baseAmount' ? baseDecimals : quoteDecimals;
      const rounded = Math.floor(currentValue * Math.pow(10, decimals)) / Math.pow(10, decimals);

      // Update params with rounded value
      setParams(prev => ({ ...prev, [field]: rounded }));

      // Format and update input display directly
      const formatted = formatTokenAmountForDisplay(rounded, decimals);
      if (field === 'baseAmount') {
        setBaseAmountInput(formatted);
      } else {
        setQuoteAmountInput(formatted);
      }
    }

    // Clear the editing flag after updating
    if (field === 'baseAmount') {
      isEditingAmountRef.current.base = false;
    } else {
      isEditingAmountRef.current.quote = false;
    }
  };

  const handleClear = () => {
    setParams(defaultParams);
    setCurrentPrice(defaultParams.initialPrice);
    setInitialBins([]);
    setSimulation(null);
    setSelectedPool(null);
    setTokenSymbols({ base: 'Base', quote: 'Quote' });
    setBaseDecimals(9); // Reset to SOL default
    setQuoteDecimals(6); // Reset to USDC default
    setApplyDecimalAdjustment(true);
    setDecimalsDetermined(false);
    setAutoFill(false);
    setLastAutoFilledToken(null);
    setLowerPricePercentage('');
    setUpperPricePercentage('');
    setBaseAmountInput('');
    setQuoteAmountInput('');
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

    // Determine decimals: use API values if available, otherwise reverse engineer
    let poolBaseDecimals: number;
    let poolQuoteDecimals: number;
    let applyDecimalAdjustment: boolean = true;

    if (pool.decimals_x !== undefined && pool.decimals_x !== null &&
        pool.decimals_y !== undefined && pool.decimals_y !== null) {
      // Use API-provided decimals, but still determine if decimal adjustments should be applied
      poolBaseDecimals = pool.decimals_x;
      poolQuoteDecimals = pool.decimals_y;

      // Still reverse engineer to determine if decimal adjustments are needed
      const reverseEngineered = reverseEngineerDecimals(pool.current_price, pool.bin_step, pool.mint_x, pool.mint_y);
      applyDecimalAdjustment = reverseEngineered.applyDecimalAdjustment;
    } else {
      // Reverse engineer decimals from API price
      const reverseEngineered = reverseEngineerDecimals(pool.current_price, pool.bin_step, pool.mint_x, pool.mint_y);
      poolBaseDecimals = reverseEngineered.baseDecimals;
      poolQuoteDecimals = reverseEngineered.quoteDecimals;
      applyDecimalAdjustment = reverseEngineered.applyDecimalAdjustment;
    }

    // Update the component state with the determined decimals
    setBaseDecimals(poolBaseDecimals);
    setQuoteDecimals(poolQuoteDecimals);
    setApplyDecimalAdjustment(applyDecimalAdjustment);
    setDecimalsDetermined(true);

    setBaseDecimals(poolBaseDecimals);
    setQuoteDecimals(poolQuoteDecimals);
    setApplyDecimalAdjustment(applyDecimalAdjustment);

    // Calculate price range: 69 bins centered around initial price
    const currentBinId = getIdFromPrice(pool.current_price, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    const lowerBinId = currentBinId - 34;
    const upperBinId = currentBinId + 34;

    // Get the exact bin prices - these will be the boundaries
    const lowerPrice = getPriceFromId(lowerBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    const upperPrice = getPriceFromId(upperBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);

    // Check if the API current_price matches any bin price
    const exactBinPrice = getPriceFromId(currentBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    const priceDifference = Math.abs(pool.current_price - exactBinPrice);

    // Check a few neighboring bins to see their prices
    for (let offset = -2; offset <= 2; offset++) {
      const binId = currentBinId + offset;
      const binPrice = getPriceFromId(binId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    }

    // Helper function to round price to decimals
    const roundToDecimals = (price: number): number => {
      const significantDecimals = Math.max(poolQuoteDecimals, 6);
      const multiplier = Math.pow(10, significantDecimals);
      return Math.floor(price * multiplier) / multiplier;
    };


    // Update simulation params with exact bin prices
    setParams(prev => ({
      ...prev,
      binStep: pool.bin_step,
      initialPrice: exactBinPrice,
      lowerPrice: lowerPrice,
      upperPrice: upperPrice,
    }));

    // Update current price to match the pool
    setCurrentPrice(exactBinPrice);
  };

  const analysis = simulation?.analysis;

  const initialTotalValue = useMemo(() => {
    if (!initialBins || initialBins.length === 0) return 0;
    // Use pre-calculated and normalized initialValueInQuote from bins
    // This avoids recalculation errors and respects the normalization step
    return initialBins.reduce((sum, bin) => sum + bin.initialValueInQuote, 0);
  }, [initialBins]);
  
  
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
    <DlmmContext.Provider value={{params, baseDecimals, quoteDecimals, applyDecimalAdjustment, tokenSymbols}}>
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
        <div className="flex gap-2">
          <ShareButton params={params} currentPrice={currentPrice} selectedPool={selectedPool} autoFill={autoFill} disabled={!simulationParams} />
          <Button variant="outline" size="sm" onClick={handleClear} className="hover:bg-primary/10 transition-all duration-300">
            <RefreshCcw className="mr-2 h-4 w-4" />Clear All
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">Search for a Pool</CardTitle>
              <CardDescription>Search and select a Meteora DLMM pool to simulate, or manually enter the position information below.</CardDescription>
            </CardHeader>
            <CardContent>
              <PoolSelector key={clearKey} onSelectPool={handlePoolSelect} selectedPool={selectedPool} initialPoolAddress={initialPoolAddress} />
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
                      type="text"
                      placeholder="Min Price"
                      value={lowerPriceInput}
                      onChange={e => handleParamChange('lowerPrice', e.target.value)}
                      onBlur={() => handlePriceBlur('lowerPrice')}
                      className="flex-1 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="relative w-24">
                      <Input
                        id="lowerPricePercentage"
                        type="number"
                        value={lowerPricePercentage}
                        onChange={e => handlePricePercentageChange('lower', e.target.value)}
                        onBlur={() => handlePercentageBlur('lower')}
                        placeholder="Min %"
                        className="pr-6 transition-all duration-300 focus:ring-2 focus:ring-primary/50 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                      />
                      {lowerPricePercentage !== '' && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="upperPrice"
                      type="text"
                      placeholder="Max Price"
                      value={upperPriceInput}
                      onChange={e => handleParamChange('upperPrice', e.target.value)}
                      onBlur={() => handlePriceBlur('upperPrice')}
                      className="flex-1 transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="relative w-24">
                      <Input
                        id="upperPricePercentage"
                        type="number"
                        value={upperPricePercentage}
                        onChange={e => handlePricePercentageChange('upper', e.target.value)}
                        onBlur={() => handlePercentageBlur('upper')}
                        placeholder="Max %"
                        className="pr-6 transition-all duration-300 focus:ring-2 focus:ring-primary/50 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                      />
                      {upperPricePercentage !== '' && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                      )}
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
                <Input
                  id="baseAmount"
                  type="text"
                  value={baseAmountInput}
                  onChange={e => handleParamChange('baseAmount', e.target.value)}
                  onBlur={() => handleAmountBlur('baseAmount')}
                  className="transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="quoteAmount" className="text-sm font-medium">{tokenSymbols.quote} Token Amount</Label>
                <Input
                  id="quoteAmount"
                  type="text"
                  value={quoteAmountInput}
                  onChange={e => handleParamChange('quoteAmount', e.target.value)}
                  onBlur={() => handleAmountBlur('quoteAmount')}
                  className="transition-all duration-300 focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="initialPrice" className="text-sm font-medium">Initial Price</Label>
                <Input
                  id="initialPrice"
                  type="text"
                  value={initialPriceInput}
                  onChange={e => handleParamChange('initialPrice', e.target.value)}
                  onBlur={() => handlePriceBlur('initialPrice')}
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
                <span>
                  {selectedPool && params.binStep ? `Liquidity Distribution for ${selectedPool.name} ${params.binStep} Bin Step` : 'Liquidity Distribution'}
                </span>
                {selectedPool && (
                  <a
                    href={`https://app.meteora.ag/dlmm/${selectedPool.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
                    title="View on Meteora"
                  >
                    <ExternalLink className="h-4 w-4 text-primary" />
                  </a>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-grow flex flex-col justify-center gap-4 pt-8">
              <div className="h-80 w-full">
                {simulationParams && decimalsDetermined && typeof currentPrice === 'number' && typeof params.initialPrice === 'number' && typeof params.lowerPrice === 'number' && typeof params.upperPrice === 'number' ? (
                  <LiquidityChart
                    bins={initialBins}
                    simulatedBins={simulation?.simulatedBins ?? []}
                    currentPrice={currentPrice}
                    initialPrice={params.initialPrice}
                    lowerPrice={params.lowerPrice}
                    upperPrice={params.upperPrice}
                    strategy={params.strategy}
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
