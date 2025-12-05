
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

    const quoteBins = Math.max(0, initialPriceId - minId);
    const baseBins = Math.max(0, maxId - initialPriceId + 1);

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
      if (quoteBins > 0 && baseBins > 0) {
        newParams.baseAmount = ((params.quoteAmount as number) * baseBins) / (initialPrice * quoteBins);
      } else if (baseBins > 0) {
        newParams.baseAmount = 0;
      } else {
        newParams.baseAmount = (params.quoteAmount as number) / initialPrice;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
      return;
    }

    // Only one is filled, calculate the other
    if (hasQuote && !hasBase) {
      if (quoteBins > 0 && baseBins > 0) {
        newParams.baseAmount = ((params.quoteAmount as number) * baseBins) / (initialPrice * quoteBins);
      } else if (baseBins > 0) {
        newParams.baseAmount = 0;
      } else {
        newParams.baseAmount = (params.quoteAmount as number) / initialPrice;
      }
      setLastAutoFilledToken('base');
      setParams(newParams);
    } else if (hasBase && !hasQuote) {
      if (quoteBins > 0 && baseBins > 0) {
        newParams.quoteAmount = ((params.baseAmount as number) * initialPrice * quoteBins) / baseBins;
      } else if (quoteBins > 0) {
        newParams.quoteAmount = 0;
      } else {
        newParams.quoteAmount = (params.baseAmount as number) * initialPrice;
      }
      setLastAutoFilledToken('quote');
      setParams(newParams);
    }
  }, [autoFill]);

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

    const quoteBins = Math.max(0, initialPriceId - minId);
    const baseBins = Math.max(0, maxId - initialPriceId + 1);

    let newParams = { ...params };

    if (lastAutoFilledToken === 'quote') {
      // Recalculate quote based on base
      if (typeof params.baseAmount === 'number') {
        if (quoteBins > 0 && baseBins > 0) {
          newParams.quoteAmount = (params.baseAmount * initialPrice * quoteBins) / baseBins;
        } else if (quoteBins > 0) {
          newParams.quoteAmount = 0;
        } else {
          newParams.quoteAmount = params.baseAmount * initialPrice;
        }
        setParams(newParams);
      }
    } else if (lastAutoFilledToken === 'base') {
      // Recalculate base based on quote
      if (typeof params.quoteAmount === 'number') {
        if (quoteBins > 0 && baseBins > 0) {
          newParams.baseAmount = (params.quoteAmount * baseBins) / (initialPrice * quoteBins);
        } else if (baseBins > 0) {
          newParams.baseAmount = 0;
        } else {
          newParams.baseAmount = params.quoteAmount / initialPrice;
        }
        setParams(newParams);
      }
    }
  }, [params.initialPrice, autoFill, lastAutoFilledToken]);

  const handleParamChange = (field: keyof PartialSimulationParams, value: string) => {
    const numValue = parseFloat(value);
    const finalValue = value === '' ? '' : numValue;

    if (field === 'initialPrice') {
      setParams(prev => ({ ...prev, initialPrice: finalValue }));
      setCurrentPrice(finalValue);
    } else if (autoFill && (field === 'baseAmount' || field === 'quoteAmount')) {
      // Auto-fill the other token amount for balanced position
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

        const quoteBins = Math.max(0, initialPriceId - minId); // bins below initial price
        const baseBins = Math.max(0, maxId - initialPriceId + 1); // bins at or above initial price

        // For balanced distribution: quoteAmount / quoteBins = (baseAmount * initialPrice) / baseBins
        // This ensures each bin has equal value
        if (field === 'baseAmount') {
          if (quoteBins > 0 && baseBins > 0) {
            newParams.quoteAmount = (finalValue * initialPrice * quoteBins) / baseBins;
          } else if (quoteBins > 0) {
            newParams.quoteAmount = 0;
          } else {
            newParams.quoteAmount = finalValue * initialPrice;
          }
          setLastAutoFilledToken('quote');
        } else {
          if (quoteBins > 0 && baseBins > 0) {
            newParams.baseAmount = (finalValue * baseBins) / (initialPrice * quoteBins);
          } else if (baseBins > 0) {
            newParams.baseAmount = 0;
          } else {
            newParams.baseAmount = finalValue / initialPrice;
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
  };
  
  const handleInitialPriceChange = (newInitialPrice: number) => {
    setParams(prev => ({...prev, initialPrice: newInitialPrice}));
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


  return (
    <DlmmContext.Provider value={{params}}>
    <div className="flex flex-col gap-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo className="h-10 w-10 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Meteora DLMM Position Simulator</h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleClear}><RefreshCcw className="mr-2 h-4 w-4" />Clear All</Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">Search for a Pool</CardTitle>
              <CardDescription>Search and select a Meteora DLMM pool to simulate, or manually enter the the position information below.</CardDescription>
            </CardHeader>
            <CardContent>
              <PoolSelector onSelectPool={handlePoolSelect} selectedPool={selectedPool} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Layers />Pool Parameters</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="binStep" className="flex items-center gap-1.5"><Footprints className="w-4 h-4" />Bin Step</Label>
                <Input id="binStep" type="number" value={params.binStep} onChange={e => handleParamChange('binStep', e.target.value)} />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Coins />Liquidity Position</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label className="flex items-center gap-1.5"><MoveHorizontal className="w-4 h-4" />Strategy</Label>
                <RadioGroup value={params.strategy} onValueChange={handleStrategyChange} className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="spot" id="spot" />
                    <Label htmlFor="spot">Spot</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="bid-ask" id="bid-ask" />
                    <Label htmlFor="bid-ask">Bid-Ask</Label>
                  </div>
                   <div className="flex items-center space-x-2">
                    <RadioGroupItem value="curve" id="curve" />
                    <Label htmlFor="curve">Curve</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lowerPrice" className="flex items-center gap-1.5"><ChevronsLeftRight className="w-4 h-4" />Price Range</Label>
                <div className="flex gap-2">
                  <Input id="lowerPrice" type="number" placeholder="Min" value={params.lowerPrice} onChange={e => handleParamChange('lowerPrice', e.target.value)} step="0.000001" />
                  <Input id="upperPrice" type="number" placeholder="Max" value={params.upperPrice} onChange={e => handleParamChange('upperPrice', e.target.value)} step="0.000001" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="autoFill">Auto-Fill</Label>
                <Switch id="autoFill" checked={autoFill} onCheckedChange={setAutoFill} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="baseAmount">{tokenSymbols.base} Token Amount</Label>
                <Input id="baseAmount" type="number" value={params.baseAmount} onChange={e => handleParamChange('baseAmount', e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="quoteAmount">{tokenSymbols.quote} Token Amount</Label>
                <Input id="quoteAmount" type="number" value={params.quoteAmount} onChange={e => handleParamChange('quoteAmount', e.target.value)} />
              </div>
               <div className="grid gap-2">
                  <Label htmlFor="initialPrice">Initial Price</Label>
                  <Input 
                      id="initialPrice"
                      type="number" 
                      value={params.initialPrice} 
                      onChange={e => handleParamChange('initialPrice', e.target.value)}
                      step="0.000001"
                  />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-6">
          <Card className="flex-grow flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CandlestickChart />
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

          <Card>
            <CardHeader>
              <CardTitle>Position Analysis</CardTitle>
            </CardHeader>
            <CardContent>
              {analysis ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                   <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">Initial Position Value</span>
                    <span className="font-bold text-lg"><FormattedNumber value={initialTotalValue} maximumFractionDigits={4} /></span>
                  </div>
                  <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">Current Position Value</span>
                    <span className="font-bold text-lg"><FormattedNumber value={analysis.totalValueInQuote} maximumFractionDigits={4} /></span>
                  </div>
                  <div className={`flex flex-col gap-1 p-3 bg-secondary rounded-lg ${valueChangeColorClass}`}>
                    <span className="text-muted-foreground">Position Value Change</span>
                    <span className="font-bold text-lg">{valueChangeDisplay}</span>
                  </div>
                  <div className={`flex flex-col gap-1 p-3 bg-secondary rounded-lg ${plColorClass}`}>
                    <span className="text-muted-foreground">Profit/Loss</span>
                    <span className="font-bold text-lg"><FormattedNumber value={profitLoss} maximumFractionDigits={4} /></span>
                  </div>
                  <div className={`flex flex-col gap-1 p-3 bg-secondary rounded-lg ${priceChangeColorClass}`}>
                    <span className="text-muted-foreground">Price Pct. Change</span>
                    <span className="font-bold text-lg">{priceChangeDisplay}</span>
                  </div>
                   <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">{tokenSymbols.base} Tokens</span>
                    <span className="font-bold text-lg"><FormattedNumber value={displayBase} maximumFractionDigits={4} /></span>
                  </div>
                   <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">{tokenSymbols.quote} Tokens</span>
                    <span className="font-bold text-lg"><FormattedNumber value={displayQuote} maximumFractionDigits={4} /></span>
                  </div>
                  <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">Total Bins</span>
                    <span className="font-bold text-lg">{analysis.totalBins}</span>
                  </div>
                  <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">Base Bins</span>
                    <span className="font-bold text-lg">{analysis.baseBins}</span>
                  </div>
                   <div className="flex flex-col gap-1 p-3 bg-secondary rounded-lg">
                    <span className="text-muted-foreground">Quote Bins</span>
                    <span className="font-bold text-lg">{analysis.quoteBins}</span>
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
