
"use client";

import { useState, useMemo, useEffect, createContext, useContext, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getInitialBins, runSimulation, getIdFromPrice, getPriceFromId, type SimulationParams, type Analysis, type SimulatedBin, type Strategy } from "@/lib/dlmm";
import { LiquidityChart } from "@/components/liquidity-chart";
import { Logo } from "@/components/icons";
import { BarChart3, RefreshCcw, ExternalLink, Wallet, FlaskConical, Loader2 } from "lucide-react";
import { formatNumberForDisplay } from "@/lib/display-formatting";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PoolSelector } from "@/components/pool-selector";
import { WalletLoader } from "@/components/wallet-loader";
import { PositionChanges, type ChangeFocus } from "@/components/position-changes";
import { ShareButton } from '@/components/share-button';
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileSectionNav, type MobileSection } from "@/components/mobile-section-nav";
import { cn } from "@/lib/utils";
import { MeteoraPair, parseTokenSymbols } from "@/lib/meteora-api";
import { reverseEngineerDecimals } from "@/lib/dlmm-sdk-wrapper";
import {
  loadPoolSimulation,
  reconstructCombinedBins,
  type PairGroup,
  type WalletPoolSummary,
  type WalletPositionDetail,
} from "@/lib/wallet-positions";
import {
  analyzeCurrentBins,
  binsToAmounts,
  combineSliceBins,
  FORM_SEED_POSITION_ADDRESS,
  originalSlices,
  positionsFromSlices,
  removeTransaction,
  removeSimulatedPosition,
  replayTransactions,
  simulateSlices,
  simulatedPositionDetail,
  slicesCostBasis,
  type SimulatedTransaction,
} from "@/lib/position-transactions";

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

function AnalysisStat({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-gradient-to-br from-secondary/80 to-secondary/40 px-3 py-2.5">
      <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground leading-tight">{label}</span>
      <span className={cn("font-semibold tabular-nums text-[15px] leading-tight", className)}>{children}</span>
    </div>
  );
}


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
  const [initialPoolAddress, setInitialPoolAddress] = useState<string | null>(null);
  const [clearKey, setClearKey] = useState(0);
  const [sourceTab, setSourceTab] = useState<'simulate' | 'wallet'>('simulate');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [initialWallet, setInitialWallet] = useState<string | null>(null);
  const [walletBins, setWalletBins] = useState<SimulatedBin[] | null>(null);
  const [walletPositions, setWalletPositions] = useState<WalletPositionDetail[]>([]);
  const [walletPair, setWalletPair] = useState<PairGroup | null>(null);
  const [isLoadingWalletPool, setIsLoadingWalletPool] = useState(false);
  const [walletPoolError, setWalletPoolError] = useState<string | null>(null);
  const [originalWalletPositions, setOriginalWalletPositions] = useState<WalletPositionDetail[]>([]);
  const [originalPositionBins, setOriginalPositionBins] = useState<Record<string, SimulatedBin[]>>({});
  const [originalInitialPrice, setOriginalInitialPrice] = useState<number | null>(null);
  const [simulatedTxs, setSimulatedTxs] = useState<SimulatedTransaction[]>([]);
  const [changeFocus, setChangeFocus] = useState<ChangeFocus | null>(null);
  const [mobileSection, setMobileSection] = useState<MobileSection>('position');
  const searchParams = useSearchParams();

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

  const walletReplay = useMemo(() => {
    if (typeof params.binStep !== 'number') return null;
    if (originalWalletPositions.length === 0 && simulatedTxs.length === 0) return null;
    return {
      binStep: params.binStep,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
      activeBinId: typeof params.initialPrice === 'number'
        ? getIdFromPrice(params.initialPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
        : 0,
    };
  }, [params.binStep, params.initialPrice, baseDecimals, quoteDecimals, applyDecimalAdjustment, originalWalletPositions.length, simulatedTxs.length]);

  const walletSlices = useMemo(() => {
    if (!walletReplay) return [];
    if (originalWalletPositions.length === 0 && simulatedTxs.length === 0) return [];
    const base = originalWalletPositions.length && originalInitialPrice != null
      ? originalSlices(originalWalletPositions, originalPositionBins, originalInitialPrice)
      : [];
    return replayTransactions(base, simulatedTxs, walletReplay);
  }, [walletReplay, originalWalletPositions, originalPositionBins, originalInitialPrice, simulatedTxs]);

  useEffect(() => {
    if (walletSlices.length && walletReplay) {
      const combined = combineSliceBins(walletSlices, walletReplay);
      const amounts = binsToAmounts(combined, false);
      setInitialBins(combined);
      setParams(prev => {
        const lowerPrice = combined[0]?.price ?? prev.lowerPrice;
        const upperPrice = combined[combined.length - 1]?.price ?? prev.upperPrice;
        if (
          prev.baseAmount === amounts.base
          && prev.quoteAmount === amounts.quote
          && prev.lowerPrice === lowerPrice
          && prev.upperPrice === upperPrice
        ) {
          return prev;
        }
        return {
          ...prev,
          baseAmount: amounts.base,
          quoteAmount: amounts.quote,
          lowerPrice,
          upperPrice,
        };
      });
      return;
    }
    if (walletBins) {
      setInitialBins(walletBins);
      return;
    }
    setInitialBins([]);
  }, [walletBins, walletSlices, walletReplay]);

  useEffect(() => {
    if (walletSlices.length && typeof currentPrice === 'number') {
      const simulatedBins = simulateSlices(walletSlices, currentPrice, walletReplay);
      setSimulation({
        simulatedBins,
        analysis: analyzeCurrentBins(simulatedBins),
      });
      setWalletPositions(positionsFromSlices(originalWalletPositions, walletSlices, currentPrice));
      return;
    }
    if (!walletBins) setWalletPositions([]);
    if (initialBins.length > 0 && typeof currentPrice === 'number' && simulationParams) {
      const result = runSimulation(initialBins, currentPrice, simulationParams.initialPrice);
      setSimulation(result);
    } else if (!walletSlices.length) {
      setSimulation(null);
    }
  }, [initialBins, currentPrice, simulationParams, walletSlices, walletReplay, originalWalletPositions, walletBins]);

  useEffect(() => {
    if (walletBins) return;
    if (simulatedTxs.length > 0 || originalWalletPositions.length === 0) return;
    setOriginalWalletPositions([]);
    setOriginalPositionBins({});
    setOriginalInitialPrice(null);
  }, [walletBins, simulatedTxs.length, originalWalletPositions.length]);

  useEffect(() => {
    if (params.initialPrice !== '' && currentPrice === '') {
        setCurrentPrice(params.initialPrice);
    }
  }, [params.initialPrice, currentPrice]);

  // Parse URL parameters on mount
  useEffect(() => {
    const pool = searchParams.get('pool');
    if (pool) {
      setInitialPoolAddress(pool);
    }

    const wallet = searchParams.get('wallet');
    if (wallet) {
      setInitialWallet(wallet);
      setWalletAddress(wallet);
      setSourceTab('wallet');
    }

    const currentPriceStr = searchParams.get('currentPrice');
    if (currentPriceStr) {
      const num = parseFloat(currentPriceStr);
      if (!isNaN(num) && num > 0) {
        setCurrentPrice(num);
      }
    }
  }, [searchParams]);

  const handleClear = () => {
    setParams(defaultParams);
    setCurrentPrice(defaultParams.initialPrice);
    setInitialBins([]);
    setSimulation(null);
    setSelectedPool(null);
    setSourceTab('simulate');
    setTokenSymbols({ base: 'Base', quote: 'Quote' });
    setBaseDecimals(9); // Reset to SOL default
    setQuoteDecimals(6); // Reset to USDC default
    setApplyDecimalAdjustment(true);
    setDecimalsDetermined(false);
    setWalletBins(null);
    setWalletPositions([]);
    setOriginalWalletPositions([]);
    setOriginalPositionBins({});
    setOriginalInitialPrice(null);
    setSimulatedTxs([]);
    setChangeFocus(null);
    setWalletPair(null);
    setWalletPoolError(null);
    setWalletAddress(null);
    setInitialWallet(null);
    setInitialPoolAddress(null);
    setMobileSection('position');
    setClearKey(prev => prev + 1);
  };
  
  const handleInitialPriceChange = (newInitialPrice: number) => {
    setParams(prev => ({...prev, initialPrice: newInitialPrice}));
    setCurrentPrice(newInitialPrice);
  }

  const handleCurrentPriceChange = (newCurrentPrice: number) => {
    setCurrentPrice(newCurrentPrice);
  }

  const applySimulatedTx = (tx: SimulatedTransaction) => {
    if (
      !walletBins
      && originalWalletPositions.length === 0
      && simulationParams
      && tx.type !== 'add-position'
    ) {
      const bins = getInitialBins(simulationParams);
      if (bins.length) {
        const seedPrice = typeof currentPrice === 'number' ? currentPrice : simulationParams.initialPrice;
        const seed = simulatedPositionDetail({
          positionAddress: FORM_SEED_POSITION_ADDRESS,
          minPrice: simulationParams.lowerPrice,
          maxPrice: simulationParams.upperPrice,
          lowerBinId: bins[0].id,
          upperBinId: bins[bins.length - 1].id,
          currentPrice: seedPrice,
          bins,
        });
        setOriginalWalletPositions([seed]);
        setOriginalPositionBins({ [FORM_SEED_POSITION_ADDRESS]: bins });
        setOriginalInitialPrice(simulationParams.initialPrice);
        if (!tx.positionAddress || tx.positionAddress === FORM_SEED_POSITION_ADDRESS) {
          tx = { ...tx, positionAddress: tx.positionAddress || FORM_SEED_POSITION_ADDRESS };
        }
      }
    }
    setSimulatedTxs(prev => {
      const index = prev.findIndex(item => item.id === tx.id);
      if (index === -1) return [...prev, tx];
      const next = [...prev];
      next[index] = tx;
      return next;
    });
    setMobileSection('analysis');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const dropSimulatedTx = (id: string) => {
    setSimulatedTxs(prev => removeTransaction(prev, id));
  };

  const deleteSimulatedPosition = (positionAddress: string) => {
    setSimulatedTxs(prev => removeSimulatedPosition(prev, positionAddress));
    setChangeFocus(prev => (prev?.positionAddress === positionAddress ? null : prev));
  };

  const restoreOriginalPositions = () => {
    const wasWallet = !!walletBins;
    setSimulatedTxs([]);
    setChangeFocus(null);
    if (wasWallet) {
      if (originalInitialPrice != null) {
        setCurrentPrice(originalInitialPrice);
        setParams(prev => ({ ...prev, initialPrice: originalInitialPrice }));
      }
      return;
    }
    if (originalWalletPositions.length && originalInitialPrice != null) {
      const seed = originalWalletPositions[0];
      const bins = originalPositionBins[seed.positionAddress] ?? [];
      const amounts = binsToAmounts(bins, false);
      setCurrentPrice(originalInitialPrice);
      setParams(prev => ({
        ...prev,
        initialPrice: originalInitialPrice,
        strategy: prev.strategy,
        baseAmount: amounts.base,
        quoteAmount: amounts.quote,
        lowerPrice: seed.minPrice,
        upperPrice: seed.maxPrice,
      }));
    }
    setOriginalWalletPositions([]);
    setOriginalPositionBins({});
    setOriginalInitialPrice(null);
    setWalletPositions([]);
  };

  const handlePoolSelect = (pool: MeteoraPair) => {
    setWalletBins(null);
    setWalletPositions([]);
    setOriginalWalletPositions([]);
    setOriginalPositionBins({});
    setOriginalInitialPrice(null);
    setSimulatedTxs([]);
    setChangeFocus(null);
    setWalletPair(null);
    setWalletPoolError(null);
    setMobileSection('position');
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

  const handleWalletPoolSelect = async (payload: {
    wallet: string;
    pair: PairGroup;
    pool: WalletPoolSummary;
  }) => {
    setWalletAddress(payload.wallet);
    setWalletPair(payload.pair);
    setWalletPoolError(null);
    setIsLoadingWalletPool(true);
    setTokenSymbols({ base: payload.pair.tokenX, quote: payload.pair.tokenY });

    try {
      const mintX = payload.pool.tokenXMint || payload.pair.tokenXMint;
      const mintY = payload.pool.tokenYMint || payload.pair.tokenYMint;
      const reverseEngineered = reverseEngineerDecimals(
        payload.pool.poolPrice || 1,
        payload.pool.binStep || 1,
        mintX,
        mintY
      );

      const loaded = await loadPoolSimulation({
        wallet: payload.wallet,
        summary: payload.pool,
        baseDecimals: reverseEngineered.baseDecimals,
        quoteDecimals: reverseEngineered.quoteDecimals,
        applyDecimalAdjustment: reverseEngineered.applyDecimalAdjustment,
      });

      const pool = loaded.pool;
      let poolBaseDecimals = reverseEngineered.baseDecimals;
      let poolQuoteDecimals = reverseEngineered.quoteDecimals;
      let decimalAdjustment = reverseEngineered.applyDecimalAdjustment;

      if (pool.decimals_x != null && pool.decimals_y != null) {
        poolBaseDecimals = pool.decimals_x;
        poolQuoteDecimals = pool.decimals_y;
        decimalAdjustment = reverseEngineerDecimals(
          pool.current_price,
          pool.bin_step,
          pool.mint_x,
          pool.mint_y
        ).applyDecimalAdjustment;
      }

      if (!loaded.positions.length) {
        throw new Error('No open positions found in this pool.');
      }

      const bins = loaded.bins.length
        ? loaded.bins
        : reconstructCombinedBins({
            positions: loaded.positions,
            binStep: pool.bin_step || payload.pool.binStep,
            baseDecimals: poolBaseDecimals,
            quoteDecimals: poolQuoteDecimals,
            applyDecimalAdjustment: decimalAdjustment,
            fallbackActiveBinId: loaded.activeBinId,
          });

      const activeBinId = loaded.activeBinId;
      const reconstructedPrice = activeBinId
        ? getPriceFromId(activeBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, decimalAdjustment)
        : 0;
      const exactBinPrice =
        Number.isFinite(reconstructedPrice) && reconstructedPrice > 0
          ? reconstructedPrice
          : (loaded.activePrice || pool.current_price);

      setSelectedPool(pool);
      setBaseDecimals(poolBaseDecimals);
      setQuoteDecimals(poolQuoteDecimals);
      setApplyDecimalAdjustment(decimalAdjustment);
      setDecimalsDetermined(true);
      setWalletPositions(loaded.positions);
      setOriginalWalletPositions(loaded.positions);
      setOriginalPositionBins(loaded.positionBins);
      setOriginalInitialPrice(exactBinPrice);
      setSimulatedTxs([]);
      setWalletBins(bins.length ? bins : loaded.bins);
      setMobileSection('analysis');
      setParams({
        strategy: 'spot',
        binStep: pool.bin_step || payload.pool.binStep,
        initialPrice: exactBinPrice,
        baseAmount: loaded.combinedBaseAmount,
        quoteAmount: loaded.combinedQuoteAmount,
        lowerPrice: loaded.combinedLowerPrice || (bins[0]?.price ?? exactBinPrice),
        upperPrice: loaded.combinedUpperPrice || (bins[bins.length - 1]?.price ?? exactBinPrice),
      });
      setCurrentPrice(exactBinPrice);
    } catch (error) {
      setWalletBins(null);
      setWalletPositions([]);
      setOriginalWalletPositions([]);
      setOriginalPositionBins({});
      setOriginalInitialPrice(null);
      setSimulatedTxs([]);
      setWalletPoolError(error instanceof Error ? error.message : 'Failed to load pool positions');
    } finally {
      setIsLoadingWalletPool(false);
    }
  };

  const canStackPositions =
    !!selectedPool
    && typeof currentPrice === 'number'
    && typeof params.binStep === 'number'
    && params.binStep > 0
    && currentPrice > 0;

  const stackedPositions = walletPositions;
  const hasPosition = stackedPositions.length > 0 || simulatedTxs.length > 0;

  useEffect(() => {
    if (!hasPosition && mobileSection !== 'position') {
      setMobileSection('position');
    }
  }, [hasPosition, mobileSection]);

  const handleMobileSectionChange = (section: MobileSection) => {
    setMobileSection(section);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const analysis = simulation?.analysis;

  const initialTotalValue = useMemo(() => {
    if (walletSlices.length) return slicesCostBasis(walletSlices);
    if (!initialBins || initialBins.length === 0) return 0;
    return initialBins.reduce((sum, bin) => sum + bin.initialValueInQuote, 0);
  }, [initialBins, walletSlices]);
  
  
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
  const displayBase = isPristine && simulatedTxs.length === 0 && typeof params.baseAmount === 'number' ? params.baseAmount : analysis?.totalBase ?? 0;
  const displayQuote = isPristine && simulatedTxs.length === 0 && typeof params.quoteAmount === 'number' ? params.quoteAmount : analysis?.totalQuote ?? 0;

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
    <div className={cn("flex flex-col", selectedPool ? "gap-2 pb-20 lg:gap-8 lg:pb-0" : "gap-4 lg:gap-8")}>
      <header
        className={cn(
          "rounded-2xl bg-gradient-to-r from-primary/10 via-purple-500/10 to-primary/10 border border-primary/20 backdrop-blur-sm",
          selectedPool
            ? "flex items-center justify-between gap-2 p-2 sm:p-3 lg:p-6"
            : "flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 sm:p-6"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 lg:gap-3">
          <div className={cn("rounded-xl bg-primary/20 backdrop-blur-sm", selectedPool ? "p-1.5 lg:p-2" : "p-2")}>
            <Logo className={cn("text-primary", selectedPool ? "h-6 w-6 lg:h-8 lg:w-8" : "h-8 w-8")} />
          </div>
          <div className="min-w-0">
            <h1
              className={cn(
                "font-bold tracking-tight bg-gradient-to-r from-primary via-purple-400 to-primary bg-clip-text text-transparent",
                selectedPool ? "hidden lg:block text-3xl" : "text-xl sm:text-3xl"
              )}
            >
              Meteora DLMM Position Simulator v2
            </h1>
            {selectedPool ? (
              <p className="truncate text-sm font-semibold lg:mt-1 lg:font-normal lg:text-muted-foreground">
                {selectedPool.name}
                {params.binStep ? ` · ${params.binStep} bin step` : ''}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">Visualize and analyze your liquidity positions</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 lg:gap-2">
          <ShareButton
            currentPrice={currentPrice}
            initialPrice={params.initialPrice}
            selectedPool={selectedPool}
            wallet={walletAddress}
            disabled={!selectedPool && !walletAddress}
            compact={!!selectedPool}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            className={cn(
              "hover:bg-primary/10 transition-all duration-300",
              selectedPool && "h-8 w-8 px-0 lg:h-9 lg:w-auto lg:px-3"
            )}
            aria-label="Clear all"
          >
            <RefreshCcw className={cn("h-4 w-4", selectedPool ? "lg:mr-2" : "mr-2")} />
            <span className={selectedPool ? "hidden lg:inline" : undefined}>Clear All</span>
          </Button>
          <ThemeToggle className={selectedPool ? "h-8 w-8" : undefined} />
        </div>
      </header>

      {!selectedPool && (
        <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">Load a Position</CardTitle>
            <CardDescription>
              Search live pools to model a new position, or paste a wallet to simulate your open liquidity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs
              value={sourceTab}
              onValueChange={(value) => setSourceTab(value as 'simulate' | 'wallet')}
            >
              <TabsList className="grid w-full max-w-md grid-cols-2 mb-4">
                <TabsTrigger value="simulate" className="gap-1.5">
                  <FlaskConical className="h-4 w-4" />
                  New position
                </TabsTrigger>
                <TabsTrigger value="wallet" className="gap-1.5">
                  <Wallet className="h-4 w-4" />
                  My positions
                </TabsTrigger>
              </TabsList>
              <TabsContent value="simulate">
                <PoolSelector key={clearKey} onSelectPool={handlePoolSelect} selectedPool={walletBins ? null : selectedPool} initialPoolAddress={sourceTab === 'simulate' ? initialPoolAddress : null} />
              </TabsContent>
              <TabsContent value="wallet">
                <WalletLoader
                  key={`wallet-${clearKey}`}
                  onSelectPool={handleWalletPoolSelect}
                  selectedPoolAddress={walletBins ? selectedPool?.address : null}
                  initialWallet={initialWallet}
                  initialPoolAddress={sourceTab === 'wallet' ? initialPoolAddress : null}
                  disabled={isLoadingWalletPool}
                />
                {isLoadingWalletPool && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading position details…
                  </div>
                )}
                {walletPoolError && (
                  <div className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {walletPoolError}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {selectedPool && (
      <div className={cn("grid grid-cols-1 gap-6", hasPosition && "lg:grid-cols-3")}>
        <div className={cn(
          "flex flex-col gap-6",
          hasPosition ? "lg:col-span-1" : "lg:max-w-xl",
          mobileSection !== 'position' && "hidden lg:flex"
        )}>
          {typeof currentPrice === 'number' && canStackPositions && (
            <Card className="border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
              <CardHeader className="hidden lg:block">
                <CardTitle className="text-lg">Position management</CardTitle>
                <CardDescription>
                  Add or remove liquidity and open extra positions at the current simulated price.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-3 lg:p-6 lg:pt-0">
                <PositionChanges
                  positions={stackedPositions}
                  transactions={simulatedTxs}
                  currentPrice={currentPrice}
                  tokenSymbols={tokenSymbols}
                  defaultLowerPrice={typeof params.lowerPrice === 'number' ? params.lowerPrice : currentPrice * 0.95}
                  defaultUpperPrice={typeof params.upperPrice === 'number' ? params.upperPrice : currentPrice * 1.05}
                  defaultStrategy={params.strategy}
                  binStep={typeof params.binStep === 'number' ? params.binStep : 0}
                  baseDecimals={baseDecimals}
                  quoteDecimals={quoteDecimals}
                  applyDecimalAdjustment={applyDecimalAdjustment}
                  focusRequest={changeFocus}
                  onApply={applySimulatedTx}
                  onRemoveTx={dropSimulatedTx}
                  onDeletePosition={deleteSimulatedPosition}
                  onRestore={restoreOriginalPositions}
                  onFocusHandled={() => setChangeFocus(null)}
                  emptyHint="No positions yet. Create one to start the simulation."
                />
              </CardContent>
            </Card>
          )}
        </div>

        <div className={cn(
          "lg:col-span-2 flex flex-col",
          (!hasPosition || mobileSection !== 'analysis') && "hidden",
          hasPosition && "lg:flex"
        )}>
          <Card className="flex flex-col border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader className="p-3 pb-2 lg:p-6 lg:pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="p-2 rounded-lg bg-primary/10">
                  <BarChart3 className="h-4 w-4 text-primary" />
                </div>
                <span>
                  Analysis
                  {stackedPositions.length > 1 ? ` · ${stackedPositions.length} positions combined` : ''}
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
            <CardContent className="flex flex-col gap-3 p-3 pt-0 lg:gap-4 lg:p-6 lg:pt-0">
              {canStackPositions && typeof params.initialPrice === 'number' && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <span className="shrink-0 text-xs text-muted-foreground mr-1">Price shock</span>
                  {[-25, -10, -5, -1, 0, 1, 5, 10, 25].map((pct) => (
                    <Button
                      key={pct}
                      type="button"
                      variant={pct === 0 ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-8 shrink-0 px-2.5 text-xs"
                      onClick={() => {
                        if (pct === 0) {
                          handleCurrentPriceChange(params.initialPrice as number);
                          return;
                        }
                        const target = (params.initialPrice as number) * (1 + pct / 100);
                        const binId = getIdFromPrice(
                          target,
                          params.binStep as number,
                          baseDecimals,
                          quoteDecimals,
                          applyDecimalAdjustment
                        );
                        handleCurrentPriceChange(
                          getPriceFromId(binId, params.binStep as number, baseDecimals, quoteDecimals, applyDecimalAdjustment)
                        );
                      }}
                    >
                      {pct === 0 ? 'Reset' : `${pct > 0 ? '+' : ''}${pct}%`}
                    </Button>
                  ))}
                </div>
              )}
              <div className="h-72 w-full lg:h-80">
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
                    lockInitialPrice
                    initialPriceLabel="Pool Price"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    Create a position to see the chart.
                  </div>
                )}
              </div>
              {analysis && (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50">
                    <AnalysisStat label="Initial Value">
                      <FormattedNumber value={initialTotalValue} maximumFractionDigits={4} />
                    </AnalysisStat>
                    <AnalysisStat label="Current Value">
                      <FormattedNumber value={analysis.totalValueInQuote} maximumFractionDigits={4} />
                    </AnalysisStat>
                    <AnalysisStat label="Value Change" className={valueChangeColorClass}>
                      {valueChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label="Profit/Loss" className={plColorClass}>
                      <FormattedNumber value={profitLoss} maximumFractionDigits={4} />
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.base} Tokens`}>
                      <FormattedNumber value={displayBase} maximumFractionDigits={4} />
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.quote} Tokens`}>
                      <FormattedNumber value={displayQuote} maximumFractionDigits={4} />
                    </AnalysisStat>
                    <AnalysisStat label="Price Change" className={priceChangeColorClass}>
                      {priceChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label={avgPriceLabel}>
                      <FormattedNumber value={averagePricePaid} maximumFractionDigits={4} />
                    </AnalysisStat>
                  </div>
                  <p className="text-xs text-muted-foreground px-0.5">
                    {analysis.totalBins} bins
                    <span className="mx-1.5 text-border">·</span>
                    {analysis.baseBins} {tokenSymbols.base}
                    <span className="mx-1.5 text-border">·</span>
                    {analysis.quoteBins} {tokenSymbols.quote}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      )}
      {selectedPool && (
        <MobileSectionNav
          value={mobileSection}
          onChange={handleMobileSectionChange}
          hasPosition={hasPosition}
        />
      )}
    </div>
    </DlmmContext.Provider>
  );
}
