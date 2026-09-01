
"use client";

import { useState, useMemo, useEffect, useRef, createContext, useContext, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getInitialBins, runSimulation, getIdFromPrice, getPriceFromId, rangeForDeposit, DEFAULT_POSITION_BINS, type SimulationParams, type Analysis, type SimulatedBin, type Strategy } from "@/lib/dlmm";
import { LiquidityChart } from "@/components/liquidity-chart";
import { Logo } from "@/components/icons";
import { BarChart3, ChartScatter, Ellipsis, ExternalLink, Wallet, FlaskConical, Loader2, Undo2 } from "lucide-react";
import { formatNumberForDisplay } from "@/lib/display-formatting";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PoolSelector } from "@/components/pool-selector";
import { WalletLoader } from "@/components/wallet-loader";
import { PositionChanges, type ChangeFocus } from "@/components/position-changes";
import { ShareButton } from '@/components/share-button';
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileSectionNav, type MobileSection } from "@/components/mobile-section-nav";
import { cn } from "@/lib/utils";
import { fetchPoolByAddress, MeteoraPair, parseTokenSymbols } from "@/lib/meteora-api";
import { reverseEngineerDecimals } from "@/lib/dlmm-sdk-wrapper";
import {
  fetchOpenPortfolio,
  isValidSolanaAddress,
  loadPoolSimulation,
  reconstructCombinedBins,
  type PairGroup,
  type WalletPoolSummary,
  type WalletPositionDetail,
} from "@/lib/wallet-positions";
import type { LoadedPositionHistory } from "@/lib/position-history";
import {
  analyzeCurrentBins,
  binsToAmounts,
  combineSliceBins,
  findBreakevenPrice,
  FORM_SEED_POSITION_ADDRESS,
  isHistoricalTx,
  isSimulatedTx,
  originalSlices,
  positionsFromSlices,
  removeTransaction,
  removeSimulatedPosition,
  replayTransactions,
  simulateSlices,
  simulatedPositionDetail,
  slicesCostBasis,
  stackLiquidityTransactions,
  summarizeTransactionEconomics,
  type LiquiditySlice,
  type SimulatedTransaction,
} from "@/lib/position-transactions";
import { hasShareOverlay, hasShareTarget, parseShareSearchParams } from "@/lib/share-state";
import { CHART_SCATTER_OPTIONS } from "@/lib/price-scatter";

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


// formatNumber widens precision for values below 1 by the number of leading
// zeros, so the value must be quantized first for the decimal cap to hold.
function quantizeToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 10 ** decimals;
  if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) return value;
  return Math.round(scaled) / 10 ** decimals;
}

const FormattedNumber = ({ value, maximumFractionDigits = 4 }: { value: number; maximumFractionDigits?: number }) => {
  const formatted = formatNumberForDisplay(quantizeToDecimals(value, maximumFractionDigits), { maximumFractionDigits });

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
  dense,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <div className={cn(
      "flex min-w-0 flex-col gap-0.5 bg-gradient-to-br from-secondary/80 to-secondary/40 px-3 py-2.5",
      dense && "gap-0 px-2 py-1.5"
    )}>
      <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground leading-tight">{label}</span>
      <span className={cn(
        "font-semibold tabular-nums text-[15px] leading-tight",
        dense && "text-[13px] truncate",
        className
      )}>{children}</span>
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
  const [poolStartPrice, setPoolStartPrice] = useState<number | null>(null);
  const [walletHistory, setWalletHistory] = useState<LoadedPositionHistory | null>(null);
  const [historicalSlices, setHistoricalSlices] = useState<LiquiditySlice[]>([]);
  const [simulatedTxs, setSimulatedTxs] = useState<SimulatedTransaction[]>([]);
  const [changeFocus, setChangeFocus] = useState<ChangeFocus | null>(null);
  const [mobileSection, setMobileSection] = useState<MobileSection>('position');
  const [scatterOpen, setScatterOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const shareFromUrl = useMemo(() => parseShareSearchParams(searchParams), [searchParams]);
  const pendingShareRef = useRef(shareFromUrl);
  const shareOverlayAppliedRef = useRef(false);
  const shareHydrateStartedRef = useRef(false);
  const shareCancelledRef = useRef(false);
  const shareBootstrapDoneRef = useRef(false);
  const [shareHydrating, setShareHydrating] = useState(() => hasShareTarget(shareFromUrl));
  const [shareHydrateError, setShareHydrateError] = useState<string | null>(null);

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

  const firstTxPrice = simulatedTxs[0]?.price;
  const historyLocksInitialPrice = Boolean(
    historicalSlices.length > 0
    && walletHistory
    && walletHistory.initialPrice > 0
  );
  const costBasisPrice =
    typeof params.initialPrice === 'number' && params.initialPrice > 0
      ? params.initialPrice
      : originalInitialPrice;
  const walletReplay = useMemo(() => {
    if (typeof params.binStep !== 'number') return null;
    if (originalWalletPositions.length === 0 && simulatedTxs.length === 0 && historicalSlices.length === 0) {
      return null;
    }
    // Prefer the first-deposit active bin from history so cost basis stays fixed
    // while the chart still simulates to the dragged current price.
    const historyActive = walletHistory?.initialActiveBinId;
    const replayPrice = originalInitialPrice ?? firstTxPrice ?? 0;
    return {
      binStep: params.binStep,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
      activeBinId: historyActive && historyActive > 0
        ? historyActive
        : (replayPrice
            ? getIdFromPrice(replayPrice, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
            : 0),
    };
  }, [
    params.binStep,
    originalInitialPrice,
    firstTxPrice,
    simulatedTxs.length,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    originalWalletPositions.length,
    historicalSlices.length,
    walletHistory?.initialActiveBinId,
  ]);

  const hasHistoricalTxs = simulatedTxs.some(isHistoricalTx);
  const currentPriceNumber = typeof currentPrice === 'number' ? currentPrice : 0;

  const baseSlices = useMemo(() => {
    if (!walletReplay) return [];
    // Unified log: historical txs live in simulatedTxs and stack from empty.
    // Only use snapshot slices when there is no historical tx list yet.
    if (hasHistoricalTxs) return [];
    if (historicalSlices.length > 0) return historicalSlices;
    if (originalWalletPositions.length && costBasisPrice != null) {
      return originalSlices(originalWalletPositions, originalPositionBins, costBasisPrice);
    }
    return [];
  }, [
    walletReplay,
    hasHistoricalTxs,
    historicalSlices,
    originalWalletPositions,
    originalPositionBins,
    costBasisPrice,
  ]);

  const walletSlices = useMemo(() => {
    if (!walletReplay) return [];
    if (simulatedTxs.length > 0) {
      return stackLiquidityTransactions(
        simulatedTxs,
        walletReplay,
        currentPriceNumber || walletHistory?.initialPrice || 0
      ).slices;
    }
    if (baseSlices.length === 0) return [];
    return replayTransactions(baseSlices, [], walletReplay);
  }, [walletReplay, baseSlices, simulatedTxs, currentPriceNumber, walletHistory?.initialPrice]);

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
    setWalletHistory(null);
    setHistoricalSlices([]);
  }, [walletBins, simulatedTxs.length, originalWalletPositions.length]);

  useEffect(() => {
    if (params.initialPrice !== '' && currentPrice === '') {
        setCurrentPrice(params.initialPrice);
    }
  }, [params.initialPrice, currentPrice]);

  useEffect(() => {
    pendingShareRef.current = shareFromUrl;
  }, [shareFromUrl]);

  const applyShareOverlay = (poolAddress: string) => {
    const share = pendingShareRef.current;
    if (shareOverlayAppliedRef.current) return;
    if (share.pool && share.pool !== poolAddress) return;
    if (!hasShareOverlay(share)) return;

    shareOverlayAppliedRef.current = true;
    if (share.initialPrice != null) {
      setParams(prev => (
        prev.initialPrice === share.initialPrice
          ? prev
          : { ...prev, initialPrice: share.initialPrice as number }
      ));
    }
    const overlayPrice = share.currentPrice ?? share.initialPrice;
    if (overlayPrice != null) {
      setCurrentPrice(overlayPrice);
    }
    if (share.transactions.length) {
      setSimulatedTxs(share.transactions);
    }
  };

  const handleClear = () => {
    // Abort any in-flight share hydrate, then drop shared simulation state
    // from the address bar so Reset returns to a clean landing URL.
    shareCancelledRef.current = true;
    shareHydrateStartedRef.current = false;
    shareBootstrapDoneRef.current = false;
    shareOverlayAppliedRef.current = false;
    setShareHydrating(false);
    setShareHydrateError(null);
    if (typeof window !== 'undefined') {
      const target = pathname || window.location.pathname;
      window.history.replaceState({}, '', target);
      router.replace(target);
    }

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
    setWalletHistory(null);
    setHistoricalSlices([]);
    setPoolStartPrice(null);
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
    if (simulatedTxs.length > 0 || historyLocksInitialPrice) return;
    setParams(prev => (prev.initialPrice === newInitialPrice ? prev : { ...prev, initialPrice: newInitialPrice }));
  }

  const handleCreatePositionPriceChange = (newInitialPrice: number) => {
    if (simulatedTxs.length > 0) return;
    setParams(prev => (prev.initialPrice === newInitialPrice ? prev : { ...prev, initialPrice: newInitialPrice }));
    setCurrentPrice(newInitialPrice);
  }

  const handleCurrentPriceChange = (newCurrentPrice: number) => {
    setCurrentPrice(newCurrentPrice);
  }

  // Shock buttons move price the given percent from the initial price,
  // snapped to the nearest bin like dragging the handle would.
  const handlePriceShock = (pct: number) => {
    if (typeof params.initialPrice !== 'number' || typeof params.binStep !== 'number') return;
    const target = params.initialPrice * (1 + pct / 100);
    const binId = getIdFromPrice(
      target,
      params.binStep,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment
    );
    handleCurrentPriceChange(
      getPriceFromId(binId, params.binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    );
  }

  // Scatter buttons multiply the current price so repeated taps compound.
  const handlePriceScatter = (pct: number) => {
    if (typeof currentPrice !== 'number' || currentPrice <= 0) return;
    handleCurrentPriceChange(currentPrice * (1 + pct / 100));
  }

  const applySimulatedTx = (tx: SimulatedTransaction) => {
    const nextTx: SimulatedTransaction = { ...tx, source: tx.source ?? 'simulated' };
    if (
      !walletBins
      && originalWalletPositions.length === 0
      && simulatedTxs.filter(isSimulatedTx).length === 0
      && !hasHistoricalTxs
      && simulationParams
      && nextTx.type !== 'add-position'
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
        if (!nextTx.positionAddress || nextTx.positionAddress === FORM_SEED_POSITION_ADDRESS) {
          nextTx.positionAddress = nextTx.positionAddress || FORM_SEED_POSITION_ADDRESS;
        }
      }
    }
    if (originalInitialPrice == null && typeof params.initialPrice === 'number' && params.initialPrice > 0) {
      setOriginalInitialPrice(params.initialPrice);
    }
    setSimulatedTxs(prev => {
      const index = prev.findIndex(item => item.id === nextTx.id);
      if (index === -1) return [...prev, nextTx];
      if (isHistoricalTx(prev[index])) return prev;
      const next = [...prev];
      next[index] = nextTx;
      return next;
    });
    setMobileSection('analysis');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const dropSimulatedTx = (id: string) => {
    setSimulatedTxs(prev => {
      const target = prev.find(tx => tx.id === id);
      if (target && isHistoricalTx(target)) return prev;
      return removeTransaction(prev, id);
    });
  };

  const deleteSimulatedPosition = (positionAddress: string) => {
    // Never drop on-chain history — only remove simulated txs for this address.
    setSimulatedTxs(prev =>
      prev.filter(tx => isHistoricalTx(tx) || tx.positionAddress !== positionAddress)
    );
    setChangeFocus(prev => (prev?.positionAddress === positionAddress ? null : prev));
  };

  const restoreOriginalPositions = () => {
    const wasWallet = !!walletBins;
    // Keep on-chain history; drop only user-simulated overlays.
    setSimulatedTxs(prev => prev.filter(isHistoricalTx));
    setChangeFocus(null);
    if (wasWallet) {
      if (originalInitialPrice != null) {
        setCurrentPrice(poolStartPrice ?? originalInitialPrice);
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
    setWalletHistory(null);
    setHistoricalSlices([]);
    setWalletPositions([]);
  };

  const handlePoolSelect = (pool: MeteoraPair) => {
    setWalletBins(null);
    setWalletPositions([]);
    setOriginalWalletPositions([]);
    setOriginalPositionBins({});
    setOriginalInitialPrice(null);
    setWalletHistory(null);
    setHistoricalSlices([]);
    setPoolStartPrice(null);
    if (!shareOverlayAppliedRef.current) {
      setSimulatedTxs([]);
    }
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

    const currentBinId = getIdFromPrice(pool.current_price, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    const exactBinPrice = getPriceFromId(currentBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, applyDecimalAdjustment);
    const seededRange = rangeForDeposit({
      currentPrice: exactBinPrice,
      binStep: pool.bin_step,
      widthBins: DEFAULT_POSITION_BINS,
      side: 'both',
      baseDecimals: poolBaseDecimals,
      quoteDecimals: poolQuoteDecimals,
      applyDecimalAdjustment,
    });
    const lowerPrice = seededRange.lowerPrice;
    const upperPrice = seededRange.upperPrice;

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
    setPoolStartPrice(exactBinPrice);
    applyShareOverlay(pool.address);
  };

  const handleWalletPoolSelect = async (payload: {
    wallet: string;
    pair: PairGroup;
    pool: WalletPoolSummary;
  }): Promise<string | null> => {
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

      const history = loaded.history;
      // When pool mint decimals are known, always apply decimal adjustment for
      // entry-price conversion — reverse-engineering against a 0 API price can
      // flip the flag and show lamport prices on the chart.
      if (pool.decimals_x != null && pool.decimals_y != null) {
        decimalAdjustment = true;
      }

      const activeBinId = loaded.activeBinId;
      const reconstructedPrice = activeBinId
        ? getPriceFromId(activeBinId, pool.bin_step, poolBaseDecimals, poolQuoteDecimals, decimalAdjustment)
        : 0;
      const poolActivePrice =
        Number.isFinite(reconstructedPrice) && reconstructedPrice > 0
          ? reconstructedPrice
          : (loaded.activePrice || pool.current_price);

      const historyInitialFromBin =
        history && history.initialActiveBinId > 0
          ? getPriceFromId(
              history.initialActiveBinId,
              pool.bin_step || payload.pool.binStep,
              poolBaseDecimals,
              poolQuoteDecimals,
              decimalAdjustment
            )
          : 0;
      const historyInitial =
        loaded.useHistoricalShape && history
          ? (historyInitialFromBin > 0 ? historyInitialFromBin : history.initialPrice)
          : null;
      const costBasisInitial =
        historyInitial && historyInitial > 0 ? historyInitial : poolActivePrice;

      setSelectedPool(pool);
      setBaseDecimals(poolBaseDecimals);
      setQuoteDecimals(poolQuoteDecimals);
      setApplyDecimalAdjustment(decimalAdjustment);
      setDecimalsDetermined(true);
      setWalletPositions(loaded.positions);
      setOriginalWalletPositions(loaded.positions);
      setOriginalPositionBins(loaded.positionBins);
      setWalletHistory(history);
      setHistoricalSlices(
        loaded.useHistoricalShape && history ? history.historicalSlices : []
      );
      setOriginalInitialPrice(costBasisInitial);
      setPoolStartPrice(poolActivePrice);
      // Seed the unified tx log with on-chain history; share overlays append after.
      const historicalTxs = (history?.stackedTxs ?? []).map(tx => ({
        ...tx,
        source: 'historical' as const,
      }));
      if (!shareOverlayAppliedRef.current) {
        setSimulatedTxs(historicalTxs);
      } else {
        setSimulatedTxs(prev => [
          ...historicalTxs,
          ...prev.filter(isSimulatedTx),
        ]);
      }
      setWalletBins(bins.length ? bins : loaded.bins);
      setMobileSection('analysis');
      setParams({
        strategy: 'spot',
        binStep: pool.bin_step || payload.pool.binStep,
        initialPrice: costBasisInitial,
        baseAmount: loaded.combinedBaseAmount,
        quoteAmount: loaded.combinedQuoteAmount,
        lowerPrice: loaded.combinedLowerPrice || (bins[0]?.price ?? poolActivePrice),
        upperPrice: loaded.combinedUpperPrice || (bins[bins.length - 1]?.price ?? poolActivePrice),
      });
      // Start the scrubber at the live pool price; cost basis comes from history.
      setCurrentPrice(poolActivePrice);
      applyShareOverlay(pool.address);
      if (history && !history.shapeValidation.ok && history.stackedTxs.length > 0) {
        console.warn(history.shapeValidation.message, history.shapeValidation);
      }
      return null;
    } catch (error) {
      setWalletBins(null);
      setWalletPositions([]);
      setOriginalWalletPositions([]);
      setOriginalPositionBins({});
      setOriginalInitialPrice(null);
      setWalletHistory(null);
      setHistoricalSlices([]);
      setSimulatedTxs([]);
      const message = error instanceof Error ? error.message : 'Failed to load pool positions';
      setWalletPoolError(message);
      return message;
    } finally {
      setIsLoadingWalletPool(false);
    }
  };

  const handlePoolSelectRef = useRef(handlePoolSelect);
  const handleWalletPoolSelectRef = useRef(handleWalletPoolSelect);
  handlePoolSelectRef.current = handlePoolSelect;
  handleWalletPoolSelectRef.current = handleWalletPoolSelect;

  useEffect(() => {
    if (shareHydrateStartedRef.current || shareCancelledRef.current) return;
    if (hasShareTarget(shareFromUrl)) {
      setShareHydrating(true);
    }
  }, [shareFromUrl]);

  useEffect(() => {
    if (!shareHydrating || shareHydrateStartedRef.current || shareCancelledRef.current) return;
    shareHydrateStartedRef.current = true;
    const share = shareFromUrl;

    async function hydrateShare() {
      try {
        if (share.wallet) {
          if (!isValidSolanaAddress(share.wallet)) {
            throw new Error('Enter a valid Solana wallet address.');
          }
          const portfolio = await fetchOpenPortfolio(share.wallet);
          if (shareCancelledRef.current) return;
          if (portfolio.pairs.length === 0) {
            throw new Error('No open DLMM positions found for this wallet.');
          }

          let match: { pair: PairGroup; pool: WalletPoolSummary } | null = null;
          if (share.pool) {
            for (const pair of portfolio.pairs) {
              const pool = pair.pools.find(item => item.poolAddress === share.pool);
              if (pool) {
                match = { pair, pool };
                break;
              }
            }
            if (!match) {
              throw new Error('Shared pool not found in this wallet.');
            }
          } else if (portfolio.pairs.length === 1 && portfolio.pairs[0].pools.length === 1) {
            match = { pair: portfolio.pairs[0], pool: portfolio.pairs[0].pools[0] };
          }

          if (!match) {
            setInitialWallet(share.wallet);
            setWalletAddress(share.wallet);
            setSourceTab('wallet');
            setShareHydrating(false);
            return;
          }

          const error = await handleWalletPoolSelectRef.current({
            wallet: share.wallet,
            pair: match.pair,
            pool: match.pool,
          });
          if (shareCancelledRef.current) return;
          if (error) {
            setInitialWallet(share.wallet);
            setWalletAddress(share.wallet);
            setSourceTab('wallet');
            setShareHydrateError(error);
            setShareHydrating(false);
            return;
          }
          shareBootstrapDoneRef.current = true;
          return;
        }

        if (share.pool) {
          const pool = await fetchPoolByAddress(share.pool);
          if (shareCancelledRef.current) return;
          if (!pool) {
            throw new Error('Could not load the shared pool.');
          }
          handlePoolSelectRef.current(pool);
          shareBootstrapDoneRef.current = true;
        }
      } catch (error) {
        if (shareCancelledRef.current) return;
        const message = error instanceof Error ? error.message : 'Failed to load shared simulation';
        setShareHydrateError(message);
        if (share.wallet) {
          setInitialWallet(share.wallet);
          setWalletAddress(share.wallet);
          setSourceTab('wallet');
        } else if (share.pool) {
          setInitialPoolAddress(share.pool);
          setSourceTab('simulate');
        }
        setShareHydrating(false);
      }
    }

    void hydrateShare();
  }, [shareHydrating, shareFromUrl]);

  useEffect(() => {
    if (!shareHydrating || !shareBootstrapDoneRef.current) return;
    if (isLoadingWalletPool) return;

    const share = pendingShareRef.current;
    const expectsChart = !!(share.wallet || share.transactions.length);
    if (expectsChart) {
      if (!selectedPool || !simulation || !simulationParams) return;
    } else if (share.pool && !selectedPool) {
      return;
    }

    setShareHydrating(false);
  }, [shareHydrating, selectedPool, simulation, simulationParams, isLoadingWalletPool]);

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

  const txLedger = useMemo(() => {
    if (!walletReplay) return null;
    if (hasHistoricalTxs) {
      const stacked = stackLiquidityTransactions(
        simulatedTxs,
        walletReplay,
        currentPriceNumber || walletHistory?.initialPrice || 0
      );
      return summarizeTransactionEconomics([], stacked.transactions, walletReplay);
    }
    return summarizeTransactionEconomics(baseSlices, simulatedTxs, walletReplay);
  }, [
    walletReplay,
    baseSlices,
    simulatedTxs,
    hasHistoricalTxs,
    currentPriceNumber,
    walletHistory?.initialPrice,
  ]);

  const remainingCost = useMemo(() => {
    if (typeof params.initialPrice !== 'number') {
      return walletSlices.length ? slicesCostBasis(walletSlices) : 0;
    }
    const startPrice = params.initialPrice;
    // With real deposit history, cost basis comes from stacked txs — never
    // force it equal to mark-to-market just because price matches initial.
    if (
      !historyLocksInitialPrice
      && simulatedTxs.length === 0
      && analysis
      && typeof currentPrice === 'number'
      && Math.abs(currentPrice - startPrice) < 1e-9
    ) {
      return analysis.totalValueInQuote;
    }
    if (walletSlices.length) return slicesCostBasis(walletSlices);
    if (!initialBins.length) return 0;
    return runSimulation(initialBins, startPrice, startPrice).analysis.totalValueInQuote;
  }, [
    walletSlices,
    params.initialPrice,
    simulatedTxs.length,
    analysis,
    currentPrice,
    initialBins,
    historyLocksInitialPrice,
  ]);

  const claimedFeeValue = useMemo(() => {
    const fees = walletHistory?.claimedFees;
    if (!fees) return 0;
    const price = typeof currentPrice === 'number' && currentPrice > 0
      ? currentPrice
      : (typeof params.initialPrice === 'number' ? params.initialPrice : 0);
    return fees.quote + fees.base * (price > 0 ? price : 0);
  }, [walletHistory?.claimedFees, currentPrice, params.initialPrice]);

  const realizedPnl = (txLedger?.realizedPnl ?? 0) + claimedFeeValue;
  // Fresh capital the user put in: every deposit minus the value of tokens
  // redeposited from earlier removals (those move pocketed cash, not new
  // money). Withdrawals never reduce it — the withdrawn tokens still belong
  // to the user, held as pocketed cash below.
  const netInvestment = txLedger
    ? txLedger.deposits - txLedger.reinvestedValue
    : remainingCost;
  // Withdrawn funds not yet redeployed, plus claimed fees/rewards.
  const pocketedCash = (txLedger
    ? txLedger.withdrawals - txLedger.reinvestedValue
    : 0) + claimedFeeValue;
  // Everything the user owns right now: open positions plus pocketed cash.
  const portfolioValue = (analysis?.totalValueInQuote ?? 0) + pocketedCash;

  // Position Value Change — return on the net investment.
  const valueChange = analysis && netInvestment > 0
    ? ((portfolioValue - netInvestment) / netInvestment) * 100
    : 0;
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

  // P&L breakdown: open positions vs their cost basis (unrealized), closed
  // lots from removals (realized), and their sum (net). The net always
  // equals portfolio value (positions + pocketed cash) minus net investment.
  const unrealizedPnl = analysis ? analysis.totalValueInQuote - remainingCost : 0;
  const realizedPnlValue = realizedPnl;
  const netPnl = portfolioValue - netInvestment;

  const pnlColorClass = (value: number): string | undefined => {
    if (Math.abs(value) < 1e-9) return undefined;
    return value > 0 ? 'text-green-400' : 'text-red-400';
  };

  // Discrete breakeven against the net investment: the first liquidity bin
  // where positions + pocketed cash together cover the fresh capital put in.
  // That equals remaining cost minus realized P&L, which is what
  // findBreakevenPrice solves.
  const breakevenPrice = useMemo(() => {
    if (!walletSlices.length) return null;
    return findBreakevenPrice(walletSlices, remainingCost, realizedPnl);
  }, [walletSlices, remainingCost, realizedPnl]);

  const compositionPrice = originalInitialPrice ?? firstTxPrice;
  const isPristine = typeof currentPrice === 'number'
    && simulatedTxs.length === 0
    && (
      compositionPrice != null
        ? Math.abs(currentPrice - compositionPrice) < 1e-9
        : typeof params.initialPrice === 'number' && Math.abs(currentPrice - params.initialPrice) < 1e-9
    );
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

  const avgPriceLabel = useMemo(() => {
    if (typeof currentPrice !== 'number' || typeof params.initialPrice !== 'number') {
      return 'Avg Price';
    }
    if (Math.abs(currentPrice - params.initialPrice) < 1e-9) {
      return 'Avg Price';
    }
    return currentPrice < params.initialPrice ? 'Avg Price Paid' : 'Avg Price Sold';
  }, [currentPrice, params.initialPrice]);


  const showSimulation = !!selectedPool && !shareHydrating;

  return (
    <DlmmContext.Provider value={{params, baseDecimals, quoteDecimals, applyDecimalAdjustment, tokenSymbols}}>
    <div className={cn("flex flex-col", showSimulation ? "gap-2 pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] lg:gap-8 lg:pb-0" : "gap-4 lg:gap-8")}>
      <header
        className={cn(
          "flex items-center justify-between rounded-2xl bg-gradient-to-r from-primary/10 via-purple-500/10 to-primary/10 border border-primary/20 backdrop-blur-sm",
          showSimulation
            ? "gap-2 p-2 sm:p-3 lg:p-6"
            : "gap-4 p-4 sm:p-6"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 lg:gap-3">
          <div className={cn("rounded-xl bg-primary/20 backdrop-blur-sm", showSimulation ? "p-1.5 lg:p-2" : "p-2")}>
            <Logo className={cn("text-primary", showSimulation ? "h-6 w-6 lg:h-8 lg:w-8" : "h-8 w-8")} />
          </div>
          <div className="min-w-0">
            <h1
              className={cn(
                "font-bold tracking-tight bg-gradient-to-r from-primary via-purple-400 to-primary bg-clip-text text-transparent",
                showSimulation ? "hidden lg:block text-3xl" : "text-xl sm:text-3xl"
              )}
            >
              Meteora DLMM Position Simulator v2
            </h1>
            {showSimulation && selectedPool ? (
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
          {showSimulation && (
            <>
              <ShareButton
                currentPrice={currentPrice}
                initialPrice={params.initialPrice}
                selectedPool={selectedPool}
                wallet={walletAddress}
                transactions={simulatedTxs}
                compact
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleClear}
                className="h-8 w-8 px-0 hover:bg-primary/10 transition-all duration-300 lg:h-9 lg:w-auto lg:px-3"
                aria-label="Reset"
              >
                <Undo2 className="h-4 w-4 lg:mr-2" />
                <span className="hidden lg:inline">Reset</span>
              </Button>
            </>
          )}
          <ThemeToggle className={showSimulation ? "h-8 w-8" : undefined} />
        </div>
      </header>

      {shareHydrating && (
        <Card className="w-full max-w-2xl border-primary/20 bg-card/50 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Loading shared simulation…</p>
          </CardContent>
        </Card>
      )}

      {!shareHydrating && !selectedPool && (
        <Card className="w-full max-w-2xl border-primary/20 bg-card/50 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">Load a Position</CardTitle>
            <CardDescription>
              Search live pools to model a new position, or paste a wallet to simulate your open liquidity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {shareHydrateError && (
              <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {shareHydrateError}
              </div>
            )}
            <Tabs
              value={sourceTab}
              onValueChange={(value) => setSourceTab(value as 'simulate' | 'wallet')}
            >
              <TabsList className="grid w-full max-w-lg grid-cols-2 mb-4">
                <TabsTrigger
                  value="simulate"
                  className="gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <FlaskConical className="h-4 w-4" />
                  New position
                </TabsTrigger>
                <TabsTrigger
                  value="wallet"
                  className="gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <Wallet className="h-4 w-4" />
                  Read Wallet
                </TabsTrigger>
              </TabsList>
              <TabsContent value="simulate">
                <PoolSelector key={clearKey} onSelectPool={handlePoolSelect} selectedPool={walletBins ? null : selectedPool} initialPoolAddress={sourceTab === 'simulate' ? initialPoolAddress : null} />
              </TabsContent>
              <TabsContent value="wallet">
                <WalletLoader
                  key={`wallet-${clearKey}`}
                  onSelectPool={handleWalletPoolSelect}
                  selectedPoolAddress={null}
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

      {showSimulation && (
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
                  initialPrice={typeof params.initialPrice === 'number' ? params.initialPrice : currentPrice}
                  tokenSymbols={tokenSymbols}
                  tokenIcons={
                    walletPair
                      ? {
                          base: walletPair.tokenXIcon || undefined,
                          quote: walletPair.tokenYIcon || undefined,
                        }
                      : selectedPool
                        ? {
                            base: `https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/assets/mainnet/${selectedPool.mint_x}/logo.png`,
                            quote: `https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/assets/mainnet/${selectedPool.mint_y}/logo.png`,
                          }
                        : undefined
                  }
                  defaultLowerPrice={typeof params.lowerPrice === 'number' ? params.lowerPrice : currentPrice * 0.95}
                  defaultUpperPrice={typeof params.upperPrice === 'number' ? params.upperPrice : currentPrice * 1.05}
                  defaultStrategy={params.strategy}
                  binStep={typeof params.binStep === 'number' ? params.binStep : 0}
                  baseDecimals={baseDecimals}
                  quoteDecimals={quoteDecimals}
                  applyDecimalAdjustment={applyDecimalAdjustment}
                  focusRequest={changeFocus}
                  baseSlices={baseSlices}
                  replayOptions={walletReplay}
                  onApply={applySimulatedTx}
                  onRemoveTx={dropSimulatedTx}
                  onDeletePosition={deleteSimulatedPosition}
                  onRestore={restoreOriginalPositions}
                  onFocusHandled={() => setChangeFocus(null)}
                  onInitialPriceChange={handleCreatePositionPriceChange}
                  poolStartPrice={poolStartPrice}
                  showRestore={!!walletBins}
                  entryPriceFromHistory={historyLocksInitialPrice}
                  historyStatusMessage={(() => {
                    if (!walletHistory) return null;
                    const missing = walletHistory.missingSignatures.length;
                    const loaded = walletHistory.stackedTxs.length;
                    if (loaded <= 0 && missing > 0) {
                      return `Could not fetch historical transactions from Solana RPC (${missing} signature${missing === 1 ? '' : 's'}). Set the initial price manually for cost basis.`;
                    }
                    if (loaded <= 0) return null;
                    const parts = [
                      `Loaded ${loaded} historical liquidity tx${loaded === 1 ? '' : 's'}; entry price from first deposit.`,
                      walletHistory.reconciledToOnChain
                        ? (walletHistory.shapeValidation.message || 'Stacked history aligned to live totals.')
                        : (walletHistory.shapeValidation.ok
                            ? 'Stacked shape matches on-chain.'
                            : walletHistory.shapeValidation.message),
                    ];
                    if (missing > 0) {
                      parts.push(
                        `${missing} signature${missing === 1 ? '' : 's'} still missing after retries (rate limit or pruned RPC history); cost basis may be slightly incomplete.`
                      );
                    }
                    return parts.filter(Boolean).join(' ');
                  })()}
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
                <div className="flex items-center justify-between gap-1.5">
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Price shock</span>
                  {/* One-row on mobile: core ±% shocks inline, wide ±25% swings behind the overflow menu; all shown from sm up. */}
                  {[-1, 0, 1].map((pct) => (
                    <Button
                      key={pct}
                      type="button"
                      variant={pct === 0 ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-7 min-w-9 shrink-0 px-2 text-xs sm:hidden sm:min-w-0 sm:h-8 sm:px-2.5"
                      onClick={() => {
                        if (pct === 0) {
                          handleCurrentPriceChange(params.initialPrice as number);
                          return;
                        }
                        handlePriceShock(pct);
                      }}
                    >
                      {pct === 0 ? 'Reset' : `${pct > 0 ? '+' : ''}${pct}%`}
                    </Button>
                  ))}
                  <div className="hidden items-center gap-2 sm:flex sm:flex-wrap">
                    {[-25, -10, -5, 1, 5, 10, 25].map((pct) => (
                      <Button
                        key={pct}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 px-2.5 text-xs"
                        onClick={() => handlePriceShock(pct)}
                      >
                        {`${pct > 0 ? '+' : ''}${pct}%`}
                      </Button>
                    ))}
                  </div>
                  <Popover open={scatterOpen} onOpenChange={setScatterOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 shrink-0 px-0 sm:hidden"
                        aria-label="More price shocks"
                      >
                        <Ellipsis className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2" align="end">
                      <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">Price shock, % from initial · <ChartScatter className="inline h-3 w-3 text-muted-foreground" /> nudges current price</p>
                      <div className="flex items-center gap-1.5">
                        {[-25, -10, -5].map((pct) => (
                          <Button
                            key={pct}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2.5 text-xs"
                            title={`Set price to ${pct}% from initial`}
                            onClick={() => {
                              handlePriceShock(pct);
                              setScatterOpen(false);
                            }}
                          >
                            {`${pct}%`}
                          </Button>
                        ))}
                        {CHART_SCATTER_OPTIONS.map((pct) => (
                          <Button
                            key={pct}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs"
                            title={`Multiply current price by ${pct > 0 ? '+' : ''}${pct}% (repeated taps compound)`}
                            onClick={() => {
                              handlePriceScatter(pct);
                              setScatterOpen(false);
                            }}
                          >
                            <ChartScatter className="h-3.5 w-3.5 text-muted-foreground" />
                            {`${pct > 0 ? '+' : ''}${pct}%`}
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              )}
              <div className={cn(
                "h-64 w-full lg:h-96",
                !!walletBins && simulatedTxs.length === 0 && "h-[19rem] lg:h-[28rem]"
              )}>
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
                    initialPriceLocked={simulatedTxs.length > 0 || historyLocksInitialPrice}
                    initialPriceLabel={historyLocksInitialPrice ? 'Entry Price' : 'Initial Price'}
                    promptSetInitialPrice={
                      !!walletBins && simulatedTxs.length === 0 && !historyLocksInitialPrice
                    }
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    Create a position to see the chart.
                  </div>
                )}
              </div>
              {analysis && (
                <div className="flex flex-col gap-2">
                  {/* Mobile: every desktop stat, grouped so related values share a row —
                      Net P&L % sits directly under Net P&L (same column). */}
                  <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50 sm:hidden">
                    <AnalysisStat label="Net In." dense>
                      <FormattedNumber value={netInvestment} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Pos Value" dense>
                      <FormattedNumber value={analysis.totalValueInQuote} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Net P&L" dense className={pnlColorClass(netPnl)}>
                      <FormattedNumber value={netPnl} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Unreal. P&L" dense className={pnlColorClass(unrealizedPnl)}>
                      <FormattedNumber value={unrealizedPnl} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Real. P&L" dense className={pnlColorClass(realizedPnlValue)}>
                      <FormattedNumber value={realizedPnlValue} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Net P&L" dense className={valueChangeColorClass}>
                      {valueChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label="Init Price" dense>
                      {typeof params.initialPrice === 'number' ? (
                        <FormattedNumber value={params.initialPrice} maximumFractionDigits={quoteDecimals} />
                      ) : '—'}
                    </AnalysisStat>
                    <AnalysisStat label="Price Chg" dense className={priceChangeColorClass}>
                      {priceChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label="Breakeven" dense>
                      {breakevenPrice != null ? (
                        <FormattedNumber value={breakevenPrice} maximumFractionDigits={quoteDecimals} />
                      ) : 'N/A'}
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.base} Tokens`} dense>
                      <FormattedNumber value={displayBase} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.quote} Tokens`} dense>
                      <FormattedNumber value={displayQuote} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label={avgPriceLabel} dense>
                      <FormattedNumber value={averagePricePaid} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat
                      label="Cur. Value"
                      dense
                      className={pocketedCash > 1e-9 ? 'col-span-2' : 'col-span-3'}
                    >
                      <FormattedNumber value={portfolioValue} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    {pocketedCash > 1e-9 && (
                      <AnalysisStat label="Pocketed" dense>
                        <FormattedNumber value={pocketedCash} maximumFractionDigits={quoteDecimals} />
                      </AnalysisStat>
                    )}
                  </div>
                  <div className="hidden grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50 sm:grid-cols-4 sm:grid">
                    <AnalysisStat label="Net Investment">
                      <FormattedNumber value={netInvestment} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Position Value">
                      <FormattedNumber value={analysis.totalValueInQuote} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Unrealized P&L" className={pnlColorClass(unrealizedPnl)}>
                      <FormattedNumber value={unrealizedPnl} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Realized P&L" className={pnlColorClass(realizedPnlValue)}>
                      <FormattedNumber value={realizedPnlValue} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Net P&L" className={pnlColorClass(netPnl)}>
                      <FormattedNumber value={netPnl} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Net P&L" className={valueChangeColorClass}>
                      {valueChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label="Initial Price">
                      {typeof params.initialPrice === 'number' ? (
                        <FormattedNumber value={params.initialPrice} maximumFractionDigits={quoteDecimals} />
                      ) : '—'}
                    </AnalysisStat>
                    <AnalysisStat label="Price Change" className={priceChangeColorClass}>
                      {priceChangeDisplay}
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.base} Tokens`}>
                      <FormattedNumber value={displayBase} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label={`${tokenSymbols.quote} Tokens`}>
                      <FormattedNumber value={displayQuote} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label={avgPriceLabel}>
                      <FormattedNumber value={averagePricePaid} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    <AnalysisStat label="Breakeven">
                      {breakevenPrice != null ? (
                        <FormattedNumber value={breakevenPrice} maximumFractionDigits={quoteDecimals} />
                      ) : 'N/A'}
                    </AnalysisStat>
                    <AnalysisStat
                      label="Current Value"
                      className={pocketedCash > 1e-9 ? undefined : 'col-span-2'}
                    >
                      <FormattedNumber value={portfolioValue} maximumFractionDigits={quoteDecimals} />
                    </AnalysisStat>
                    {pocketedCash > 1e-9 && (
                      <AnalysisStat label="Pocketed Value">
                        <FormattedNumber value={pocketedCash} maximumFractionDigits={quoteDecimals} />
                      </AnalysisStat>
                    )}
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
      {showSimulation && (
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
