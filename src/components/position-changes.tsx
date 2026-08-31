'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Minus, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { formatNumberForDisplay } from '@/lib/display-formatting';
import { formatUSD } from '@/lib/meteora-api';
import { positionDisplayName, shortenAddress, type WalletPositionDetail } from '@/lib/wallet-positions';
import {
  amountsInBinRange,
  binsForPosition,
  describeTransaction,
  findBreakevenBaseAmount,
  findBreakevenMaxPrice,
  formatRealizedPnl,
  measureRemoval,
  newSimulatedPositionAddress,
  newTxId,
  replayTransactions,
  summarizeTransactionEconomics,
  type LiquiditySlice,
  type ReplayOptions,
  type SimulatedTransaction,
  type SimulatedTxType,
} from '@/lib/position-transactions';
import { RangeEditor } from '@/components/range-editor';
import { RemovalRangePicker } from '@/components/removal-range-picker';
import { DEFAULT_POSITION_BINS, depositSide, getIdFromPrice, getPriceFromId, pairAmountForStrategy, rangeForDeposit, type DepositSide, type Strategy } from '@/lib/dlmm';
import { cn } from '@/lib/utils';

export interface ChangeFocus {
  mode: SimulatedTxType;
  positionAddress?: string;
}

interface PositionChangesProps {
  positions: WalletPositionDetail[];
  transactions: SimulatedTransaction[];
  currentPrice: number;
  initialPrice: number;
  tokenSymbols: { base: string; quote: string };
  tokenIcons?: { base?: string; quote?: string };
  defaultLowerPrice: number;
  defaultUpperPrice: number;
  defaultStrategy?: Strategy;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  focusRequest: ChangeFocus | null;
  baseSlices: LiquiditySlice[];
  replayOptions: ReplayOptions | null;
  onApply: (tx: SimulatedTransaction) => void;
  onRemoveTx: (id: string) => void;
  onDeletePosition: (positionAddress: string) => void;
  onRestore: () => void;
  onFocusHandled: () => void;
  onInitialPriceChange?: (price: number) => void;
  poolStartPrice?: number | null;
  emptyHint?: string;
  showRestore?: boolean;
  /** When true, entry price came from on-chain deposit history — skip the set-initial-price prompt. */
  entryPriceFromHistory?: boolean;
  historyStatusMessage?: string | null;
}

const DUST = 1e-9;

function visibleTokens(
  base: number,
  quote: number,
  outOfRange: boolean
): { base: number; quote: number } {
  if (outOfRange) {
    if (base >= quote && base > DUST) return { base, quote: 0 };
    if (quote > DUST) return { base: 0, quote };
    return { base: 0, quote: 0 };
  }
  return {
    base: base > DUST ? base : 0,
    quote: quote > DUST ? quote : 0,
  };
}

function TokenAmounts({
  base,
  quote,
  outOfRange,
  symbols,
  prefix,
}: {
  base: number;
  quote: number;
  outOfRange: boolean;
  symbols: { base: string; quote: string };
  prefix?: string;
}) {
  const tokens = visibleTokens(base, quote, outOfRange);
  const parts: string[] = [];
  if (tokens.base > 0) {
    parts.push(`${formatNumberForDisplay(tokens.base, { maximumFractionDigits: 4 })} ${symbols.base}`);
  }
  if (tokens.quote > 0) {
    parts.push(`${formatNumberForDisplay(tokens.quote, { maximumFractionDigits: 4 })} ${symbols.quote}`);
  }
  if (parts.length === 0) {
    return <span className="text-muted-foreground">{prefix ? `${prefix} none` : 'No liquidity'}</span>;
  }
  return <span>{prefix}{parts.join(' + ')}</span>;
}

export function PositionChanges({
  positions,
  transactions,
  currentPrice,
  initialPrice,
  tokenSymbols,
  tokenIcons,
  defaultLowerPrice,
  defaultUpperPrice,
  defaultStrategy = 'spot',
  binStep,
  baseDecimals,
  quoteDecimals,
  applyDecimalAdjustment,
  focusRequest,
  baseSlices,
  replayOptions,
  onApply,
  onRemoveTx,
  onDeletePosition,
  onRestore,
  onFocusHandled,
  onInitialPriceChange,
  poolStartPrice = null,
  emptyHint,
  showRestore = true,
  entryPriceFromHistory = false,
  historyStatusMessage = null,
}: PositionChangesProps) {
  const [activeForm, setActiveForm] = useState<SimulatedTxType | null>(
    () => (positions.length === 0 ? 'add-position' : null)
  );
  const [positionAddress, setPositionAddress] = useState<string>(positions[0]?.positionAddress ?? '');
  const [strategy, setStrategy] = useState<Strategy>('spot');
  const [baseAmount, setBaseAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [lowerPrice, setLowerPrice] = useState(String(defaultLowerPrice || ''));
  const [upperPrice, setUpperPrice] = useState(String(defaultUpperPrice || ''));
  const [removePct, setRemovePct] = useState(100);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoFill, setAutoFill] = useState(false);
  const [extendToBreakeven, setExtendToBreakeven] = useState(false);
  const [reclaimRemovedBase, setReclaimRemovedBase] = useState(false);
  const preReclaimBaseRef = useRef<string>('');
  const preBreakevenRangeRef = useRef<{ lowerPrice: string; upperPrice: string; baseAmount: string } | null>(null);
  const lastAutoFilled = useRef<'base' | 'quote' | null>(null);
  const rangeTouchedRef = useRef(false);
  const skipEmptyFormRef = useRef(false);
  const lastDepositSideRef = useRef<DepositSide | null>(null);

  const positionTitle = (position: WalletPositionDetail) => positionDisplayName(position, positions);

  const seedRemovalRange = (position: WalletPositionDetail) => {
    if (replayOptions && position.lowerBinId <= position.upperBinId) {
      setLowerPrice(String(getPriceFromId(
        position.lowerBinId,
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      )));
      setUpperPrice(String(getPriceFromId(
        position.upperBinId,
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      )));
      return;
    }
    setLowerPrice(String(position.minPrice));
    setUpperPrice(String(position.maxPrice));
  };

  const txPositionLabel = (address: string) => {
    const match = positions.find(position => position.positionAddress === address);
    if (match) return positionDisplayName(match, positions);
    return shortenAddress(address, 4);
  };

  const templateWidthBins = useMemo(() => {
    const template = positions[0];
    if (template && template.upperBinId >= template.lowerBinId) {
      return Math.max(1, template.upperBinId - template.lowerBinId + 1);
    }
    if (binStep > 0 && Number(defaultLowerPrice) > 0 && Number(defaultUpperPrice) > Number(defaultLowerPrice)) {
      const minId = getIdFromPrice(
        Number(defaultLowerPrice),
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      );
      const maxId = getIdFromPrice(
        Number(defaultUpperPrice),
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      );
      if (maxId >= minId) return maxId - minId + 1;
    }
    return DEFAULT_POSITION_BINS;
  }, [positions, binStep, defaultLowerPrice, defaultUpperPrice, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const seedCreateRange = (sideOverride?: DepositSide) => {
    const template = positions[0];
    if (template && template.upperBinId >= template.lowerBinId && binStep > 0) {
      setLowerPrice(String(getPriceFromId(
        template.lowerBinId,
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      )));
      setUpperPrice(String(getPriceFromId(
        template.upperBinId,
        binStep,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment
      )));
      rangeTouchedRef.current = false;
      lastDepositSideRef.current = sideOverride ?? 'both';
      return;
    }
    const anchorPrice = currentPrice > 0 ? currentPrice : initialPrice;
    if (anchorPrice > 0 && binStep > 0) {
      const side = sideOverride ?? depositSide(Number(baseAmount) || 0, Number(quoteAmount) || 0);
      const range = rangeForDeposit({
        currentPrice: anchorPrice,
        binStep,
        widthBins: DEFAULT_POSITION_BINS,
        side,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment,
      });
      setLowerPrice(String(range.lowerPrice));
      setUpperPrice(String(range.upperPrice));
      rangeTouchedRef.current = false;
      lastDepositSideRef.current = side;
      return;
    }
    setLowerPrice(String(defaultLowerPrice || currentPrice * 0.95));
    setUpperPrice(String(defaultUpperPrice || currentPrice * 1.05));
    rangeTouchedRef.current = false;
    lastDepositSideRef.current = sideOverride ?? 'both';
  };

  const closeForm = () => {
    setEditingId(null);
    setBaseAmount('');
    setQuoteAmount('');
    setAutoFill(false);
    setExtendToBreakeven(false);
    setReclaimRemovedBase(false);
    preBreakevenRangeRef.current = null;
    lastAutoFilled.current = null;
    rangeTouchedRef.current = false;
    if (positions.length === 0 && !skipEmptyFormRef.current) {
      seedCreateRange('both');
      setActiveForm('add-position');
    } else {
      setActiveForm(null);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  useEffect(() => {
    if (!positionAddress && positions[0]) {
      setPositionAddress(positions[0].positionAddress);
    }
  }, [positionAddress, positions]);

  useEffect(() => {
    if (positions.length > 0) {
      skipEmptyFormRef.current = false;
      return;
    }
    if (skipEmptyFormRef.current) {
      skipEmptyFormRef.current = false;
      return;
    }
    if (activeForm !== 'add-position') {
      seedCreateRange('both');
      setActiveForm('add-position');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.length]);

  // Exit the form when the transaction being edited is removed from the log.
  useEffect(() => {
    if (!editingId || editingId.startsWith('tx-')) return;
    if (!transactions.some(tx => tx.id === editingId)) {
      closeForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, transactions]);

  useEffect(() => {
    if (!focusRequest) return;
    setActiveForm(focusRequest.mode);
    if (focusRequest.positionAddress) setPositionAddress(focusRequest.positionAddress);
    if (focusRequest.mode === 'remove-liquidity') {
      const targetAddress = focusRequest.positionAddress
        ?? positionAddress
        ?? positions[0]?.positionAddress;
      const position = positions.find(item => item.positionAddress === targetAddress);
      setEditingId(null);
      setRemovePct(100);
      if (position) seedRemovalRange(position);
    }
    onFocusHandled();
  }, [focusRequest, onFocusHandled]);

  useEffect(() => {
    if (activeForm !== 'add-position' || editingId) return;
    if (rangeTouchedRef.current) return;
    seedCreateRange();
    // Do not re-center when the initial price is dragged — that would
    // prevent placing the price outside the range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeForm, editingId, templateWidthBins, positions.length]);

  useEffect(() => {
    if (activeForm !== 'add-position' || editingId) return;
    if (!(binStep > 0) || !(currentPrice > 0)) return;
    const side = depositSide(Number(baseAmount) || 0, Number(quoteAmount) || 0);
    if (lastDepositSideRef.current === side) return;
    lastDepositSideRef.current = side;
    const range = rangeForDeposit({
      currentPrice,
      binStep,
      widthBins: DEFAULT_POSITION_BINS,
      side,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    });
    setLowerPrice(String(range.lowerPrice));
    setUpperPrice(String(range.upperPrice));
  }, [
    activeForm,
    editingId,
    baseAmount,
    quoteAmount,
    binStep,
    currentPrice,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
  ]);

  const selected = useMemo(
    () => positions.find(position => position.positionAddress === positionAddress),
    [positions, positionAddress]
  );

  const autoFillRange = useMemo(() => {
    if (activeForm === 'add-position') {
      const minP = Number(lowerPrice);
      const maxP = Number(upperPrice);
      if (minP > 0 && maxP >= minP) return { lower: minP, upper: maxP };
      return null;
    }
    if (selected) return { lower: selected.minPrice, upper: selected.maxPrice };
    return null;
  }, [activeForm, lowerPrice, upperPrice, selected]);

  const fillPairedAmount = (
    known: 'base' | 'quote',
    amount: number,
    range = autoFillRange,
    force = false
  ) => {
    if (!force && !autoFill) return;
    if (!range || !(amount > 0) || !(binStep > 0) || !(currentPrice > 0)) return;
    const paired = pairAmountForStrategy({
      strategy,
      binStep,
      activePrice: currentPrice,
      lowerPrice: range.lower,
      upperPrice: range.upper,
      known,
      amount,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    });
    if (known === 'base') setQuoteAmount(paired.quoteAmount ? String(paired.quoteAmount) : '0');
    else setBaseAmount(paired.baseAmount ? String(paired.baseAmount) : '0');
    lastAutoFilled.current = known === 'base' ? 'quote' : 'base';
  };

  const onAutoFillChange = (checked: boolean) => {
    setAutoFill(checked);
    if (!checked || activeForm !== 'add-position') return;
    const base = Number(baseAmount) || 0;
    const quote = Number(quoteAmount) || 0;
    const onlyBase = base > 0 && quote <= 0;
    const onlyQuote = quote > 0 && base <= 0;
    if (!onlyBase && !onlyQuote) return;
    if (!(binStep > 0) || !(currentPrice > 0)) return;

    const centered = rangeForDeposit({
      currentPrice,
      binStep,
      widthBins: DEFAULT_POSITION_BINS,
      side: 'both',
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    });
    lastDepositSideRef.current = 'both';
    setLowerPrice(String(centered.lowerPrice));
    setUpperPrice(String(centered.upperPrice));
    fillPairedAmount(
      onlyBase ? 'base' : 'quote',
      onlyBase ? base : quote,
      { lower: centered.lowerPrice, upper: centered.upperPrice },
      true
    );
  };

  useEffect(() => {
    if (!autoFill || activeForm === 'remove-liquidity' || !autoFillRange) return;
    const base = Number(baseAmount) || 0;
    const quote = Number(quoteAmount) || 0;
    if (lastAutoFilled.current === 'quote' && base > 0) fillPairedAmount('base', base);
    else if (lastAutoFilled.current === 'base' && quote > 0) fillPairedAmount('quote', quote);
    else if (quote > 0) fillPairedAmount('quote', quote);
    else if (base > 0) fillPairedAmount('base', base);
    // Intentionally omit amount fields so typing doesn't double-fire via this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFill, strategy, autoFillRange, currentPrice, binStep, activeForm]);

  const onBaseAmountChange = (value: string) => {
    setBaseAmount(value);
    if (extendToBreakeven) breakevenDriverRef.current = 'amounts';
    const amount = Number(value);
    if (autoFill && amount > 0) fillPairedAmount('base', amount);
  };

  const onQuoteAmountChange = (value: string) => {
    setQuoteAmount(value);
    if (extendToBreakeven) breakevenDriverRef.current = 'amounts';
    const amount = Number(value);
    if (autoFill && amount > 0) fillPairedAmount('quote', amount);
  };

  const removalBins = useMemo(() => {
    if (activeForm !== 'remove-liquidity' || !replayOptions || !positionAddress) return [];
    const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
    const slices = replayTransactions(baseSlices, txs, replayOptions);
    return binsForPosition(slices, positionAddress, currentPrice, replayOptions);
  }, [activeForm, replayOptions, positionAddress, editingId, transactions, baseSlices, currentPrice]);

  const removalRangeIds = useMemo(() => {
    if (!replayOptions || removalBins.length === 0) return null;
    const spanMin = removalBins[0].id;
    const spanMax = removalBins[removalBins.length - 1].id;
    const rawMin = Number(lowerPrice) > 0
      ? getIdFromPrice(Number(lowerPrice), binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
      : spanMin;
    const rawMax = Number(upperPrice) > 0
      ? getIdFromPrice(Number(upperPrice), binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
      : spanMax;
    return {
      minId: Math.min(spanMax, Math.max(spanMin, Math.min(rawMin, rawMax))),
      maxId: Math.min(spanMax, Math.max(spanMin, Math.max(rawMin, rawMax))),
    };
  }, [replayOptions, removalBins, lowerPrice, upperPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const removalPreview = useMemo(() => {
    if (!selected || activeForm !== 'remove-liquidity') return null;
    const factor = removePct / 100;
    if (removalRangeIds && removalBins.length) {
      const inRange = amountsInBinRange(removalBins, removalRangeIds.minId, removalRangeIds.maxId);
      return {
        base: inRange.base * factor,
        quote: inRange.quote * factor,
        outOfRange: false,
      };
    }
    return {
      base: selected.baseAmount * factor,
      quote: selected.quoteAmount * factor,
      outOfRange: selected.isOutOfRange,
    };
  }, [selected, activeForm, removePct, removalRangeIds, removalBins]);

  const removalEconomics = useMemo(() => {
    if (activeForm !== 'remove-liquidity' || !replayOptions || !positionAddress) return null;
    const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
    const slices = replayTransactions(baseSlices, txs, replayOptions);
    const targets = slices.filter(slice => slice.positionAddress === positionAddress);
    return measureRemoval(targets, {
      id: 'preview',
      type: 'remove-liquidity',
      price: currentPrice,
      strategy,
      baseAmount: 0,
      quoteAmount: 0,
      lowerPrice: Number(lowerPrice) || selected?.minPrice || 0,
      upperPrice: Number(upperPrice) || selected?.maxPrice || 0,
      positionAddress,
      removeBps: Math.round(removePct * 100),
    }, replayOptions);
  }, [
    activeForm,
    replayOptions,
    positionAddress,
    editingId,
    transactions,
    baseSlices,
    currentPrice,
    strategy,
    lowerPrice,
    upperPrice,
    selected,
    removePct,
  ]);

  const txLedger = useMemo(() => {
    if (!replayOptions) return null;
    return summarizeTransactionEconomics(baseSlices, transactions, replayOptions);
  }, [replayOptions, baseSlices, transactions]);

  const walletSlices = useMemo(() => {
    if (!replayOptions) return [];
    return replayTransactions(baseSlices, transactions, replayOptions);
  }, [replayOptions, baseSlices, transactions]);

  const isDepositForm = activeForm === 'add-position' || activeForm === 'add-liquidity';

  // "Adjust position to break even": keeps the position breaking even as
  // inputs change. Amount/strategy edits re-solve the top (smallest upper
  // bound whose exit value recovers the invested capital); range edits
  // re-solve the base needed at that top.
  const breakevenPrice = useMemo(() => {
    if (!replayOptions || !walletSlices.length) return null;
    const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
    return findBreakevenMaxPrice({
      baseSlices,
      transactions: txs,
      replay: replayOptions,
      strategy,
      baseAmount: Number(baseAmount) || 0,
      quoteAmount: Number(quoteAmount) || 0,
      lowerPrice: Number(lowerPrice) || 0,
      upperPrice: Number(upperPrice) || 0,
      currentPrice,
    });
  }, [
    replayOptions,
    walletSlices.length,
    baseSlices,
    transactions,
    txLedger,
    editingId,
    strategy,
    baseAmount,
    quoteAmount,
    lowerPrice,
    upperPrice,
    currentPrice,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
  ]);

  const breakevenBinId = useMemo(() => {
    if (!(binStep > 0) || !breakevenPrice) return null;
    const id = getIdFromPrice(
      breakevenPrice,
      binStep,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment
    );
    return id > 0 ? id : null;
  }, [binStep, breakevenPrice, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  // Offered whenever the position is at a loss and the deposit buys base
  // above the current price — the mode then keeps the position breaking even
  // at the range top as inputs change.
  const canExtendToBreakeven = Boolean(
    (activeForm === 'add-position' || activeForm === 'add-liquidity')
    && breakevenBinId != null
    && breakevenBinId > getIdFromPrice(currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
  );

  // Base tokens removed and not yet redeployed can be bought back below their
  // original bins when price is lower, so reinvesting them recovers part of
  // the realized loss. The ledger nets later deposits against removals, so a
  // reinvested credit disappears once the base has been redeployed. The value
  // is rounded to the fill precision so "Use max" and the entered-amount
  // comparison agree, and sub-dust residuals count as no credit.
  const reclaimableBase = useMemo(() => {
    if (!replayOptions) return 0;
    const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
    const ledger = summarizeTransactionEconomics(baseSlices, txs, replayOptions);
    const net = (ledger?.removedBase ?? 0) - (ledger?.reinvestedBase ?? 0);
    return net > 1e-8 ? Number(net.toPrecision(9)) : 0;
  }, [txLedger, editingId, transactions, baseSlices, replayOptions]);

  const canReclaimRemovedBase = Boolean(
    isDepositForm && reclaimableBase > DUST
  );

  // Which form input changed last while the breakeven mode is on. Range edits
  // re-solve the base amount; amount/strategy edits re-solve the upper bound.
  const breakevenDriverRef = useRef<'range' | 'amounts' | 'strategy' | null>(null);

  const applySolvedBaseForUpper = (upper: number, lower: number) => {
    if (!replayOptions || !(upper > 0)) return;
    const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
    const solvedBase = findBreakevenBaseAmount({
      baseSlices,
      transactions: txs,
      replay: replayOptions,
      strategy,
      baseAmount: Number(baseAmount) || 0,
      quoteAmount: Number(quoteAmount) || 0,
      lowerPrice: lower > 0 ? lower : currentPrice,
      upperPrice: upper,
      currentPrice,
    });
    if (solvedBase == null) return;
    setBaseAmount(String(Number(solvedBase.toPrecision(9))));
    if (autoFill) {
      fillPairedAmount('base', solvedBase, { lower: lower > 0 ? lower : currentPrice, upper }, true);
    } else if (Number(quoteAmount) <= 0 && quoteAmount.trim() !== '') {
      setQuoteAmount('');
    }
    lastAutoFilled.current = null;
  };

  const applyBreakevenAdjustment = () => {
    if (!extendToBreakeven || !replayOptions) return;
    if (!(binStep > 0) || !(currentPrice > 0)) return;
    const driver = breakevenDriverRef.current;

    if (driver === 'amounts' || driver === 'strategy') {
      // Amounts/strategy seed the preview; set upper to the smallest top
      // whose exit value recovers the invested capital, then solve base for
      // that top so what gets submitted still breaks even there.
      const txs = editingId ? transactions.filter(tx => tx.id !== editingId) : transactions;
      const maxPrice = findBreakevenMaxPrice({
        baseSlices,
        transactions: txs,
        replay: replayOptions,
        strategy,
        baseAmount: Number(baseAmount) || 0,
        quoteAmount: Number(quoteAmount) || 0,
        lowerPrice: Number(lowerPrice) || 0,
        upperPrice: Number(upperPrice) || 0,
        currentPrice,
      });
      if (maxPrice != null) {
        const activeId = getIdFromPrice(currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        const targetId = Math.max(
          getIdFromPrice(maxPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
          activeId + 1
        );
        const upper = getPriceFromId(targetId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
        const lower = Number(lowerPrice) || currentPrice;
        setUpperPrice(String(upper));
        applySolvedBaseForUpper(upper, lower);
      }
      breakevenDriverRef.current = null;
      return;
    }

    // Range changed (or first activation): keep the range, solve the base
    // amount that breaks even at the top of the range. With Auto-Fill on, the
    // quote side follows the solved base so the paired ratio stays consistent.
    applySolvedBaseForUpper(Number(upperPrice) || 0, Number(lowerPrice) || 0);
    breakevenDriverRef.current = null;
  };

  const onExtendToBreakevenChange = (checked: boolean) => {
    setExtendToBreakeven(checked);
    if (!checked) {
      if (preBreakevenRangeRef.current) {
        setLowerPrice(preBreakevenRangeRef.current.lowerPrice);
        setUpperPrice(preBreakevenRangeRef.current.upperPrice);
        setBaseAmount(preBreakevenRangeRef.current.baseAmount);
        preBreakevenRangeRef.current = null;
      }
      return;
    }
    if (!(binStep > 0) || !(currentPrice > 0) || breakevenBinId == null) return;
    preBreakevenRangeRef.current = { lowerPrice, upperPrice, baseAmount };
    const activeId = getIdFromPrice(currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    const minId = getIdFromPrice(Number(lowerPrice) || currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    const targetId = Math.max(breakevenBinId, activeId + 1);
    const upper = getPriceFromId(targetId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    setUpperPrice(String(upper));
    // Keep the extension anchored at the active bin so the submitted range
    // matches the shape the breakeven was solved for.
    let lower = Number(lowerPrice) || currentPrice;
    if (Number(lowerPrice) > 0 && minId > activeId) {
      lower = getPriceFromId(activeId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
      setLowerPrice(String(lower));
    }
    // Always re-solve the base for the new top: the amount entered for the
    // old range no longer breaks even there.
    breakevenDriverRef.current = 'range';
  };

  // While the breakeven mode is on, react to whichever input changed last
  // (flagged via breakevenDriverRef) once per change.
  useEffect(() => {
    if (!extendToBreakeven || !breakevenDriverRef.current) return;
    applyBreakevenAdjustment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extendToBreakeven, lowerPrice, upperPrice, baseAmount, quoteAmount, strategy]);

  // Reinvest the removed-base credit: fill the base field with the net
  // amount still sitting outside positions. While the breakeven mode is on,
  // flag the amounts driver so the range re-adjusts to the refilled amount —
  // e.g. after range edits shrank the base below the removed amount, the
  // upper bound must come back down to the breakeven level.
  const onReclaimRemovedBase = () => {
    preReclaimBaseRef.current = baseAmount;
    setReclaimRemovedBase(true);
    if (extendToBreakeven && (Number(baseAmount) || 0) < reclaimableBase - DUST) {
      breakevenDriverRef.current = 'amounts';
    }
    setBaseAmount(String(Number(reclaimableBase.toPrecision(9))));
    if (quoteAmount.trim() !== '') setQuoteAmount('');
  };

  const reclaimRemovedBaseHint = useMemo(() => {
    if (!canReclaimRemovedBase || !(currentPrice > 0)) return null;
    return { quoteNeeded: reclaimableBase * currentPrice };
  }, [canReclaimRemovedBase, currentPrice, reclaimableBase]);

  const reinvestDisabled = Boolean(
    !canReclaimRemovedBase
    || (Number(baseAmount) || 0) >= reclaimableBase - DUST
  );

  const apply = () => {
    const price = currentPrice;
    if (!Number.isFinite(price) || price <= 0 || !activeForm) return;

    if (activeForm === 'remove-liquidity') {
      if (!positionAddress || removePct <= 0) return;
      onApply({
        id: editingId ?? newTxId(),
        type: 'remove-liquidity',
        price,
        strategy,
        baseAmount: removalPreview?.base ?? 0,
        quoteAmount: removalPreview?.quote ?? 0,
        lowerPrice: Number(lowerPrice) || selected?.minPrice || 0,
        upperPrice: Number(upperPrice) || selected?.maxPrice || 0,
        positionAddress,
        removeBps: Math.round(removePct * 100),
      });
      skipEmptyFormRef.current = true;
      closeForm();
      return;
    }

    const base = Number(baseAmount) || 0;
    const quote = Number(quoteAmount) || 0;
    if (base <= 0 && quote <= 0) return;

    const minP = Number(lowerPrice);
    const maxP = Number(upperPrice);

    if (activeForm === 'add-position') {
      if (!(minP > 0) || !(maxP > 0) || maxP < minP) return;
      onApply({
        id: editingId ?? newTxId(),
        type: 'add-position',
        price,
        strategy,
        baseAmount: base,
        quoteAmount: quote,
        lowerPrice: minP,
        upperPrice: maxP,
        positionAddress: editingId
          ? (transactions.find(tx => tx.id === editingId)?.positionAddress ?? positionAddress ?? newSimulatedPositionAddress())
          : newSimulatedPositionAddress(),
        removeBps: 0,
      });
      skipEmptyFormRef.current = true;
      closeForm();
      return;
    }

    if (!positionAddress) return;
    onApply({
      id: editingId ?? newTxId(),
      type: 'add-liquidity',
      price,
      strategy,
      baseAmount: base,
      quoteAmount: quote,
      lowerPrice: minP > 0 ? minP : (selected?.minPrice ?? 0),
      upperPrice: maxP > 0 ? maxP : (selected?.maxPrice ?? 0),
      positionAddress,
      removeBps: 0,
    });
    skipEmptyFormRef.current = true;
    closeForm();
  };

  const editTx = (tx: SimulatedTransaction) => {
    setPositionAddress(tx.positionAddress);
    setStrategy(tx.strategy);
    setBaseAmount(tx.baseAmount ? String(tx.baseAmount) : '');
    setQuoteAmount(tx.quoteAmount ? String(tx.quoteAmount) : '');
    setLowerPrice(String(tx.lowerPrice || defaultLowerPrice));
    setUpperPrice(String(tx.upperPrice || defaultUpperPrice));
    setRemovePct(tx.removeBps / 100);
    setEditingId(tx.id);
    setActiveForm(tx.type);
    
    // Auto-enable breakeven if the range top matches the breakeven price
    if (tx.type === 'add-position' || tx.type === 'add-liquidity') {
      const bePrice = findBreakevenMaxPrice({
        baseSlices,
        transactions: transactions.filter(t => t.id !== tx.id),
        replay: replayOptions || { binStep: 0, baseDecimals: 0, quoteDecimals: 0, applyDecimalAdjustment: false, activeBinId: 0 },
        strategy: tx.strategy,
        baseAmount: tx.baseAmount,
        quoteAmount: tx.quoteAmount,
        lowerPrice: tx.lowerPrice,
        upperPrice: tx.upperPrice,
        currentPrice,
      });
      if (bePrice && Math.abs(bePrice - tx.upperPrice) < 1e-9) {
        setExtendToBreakeven(true);
      } else {
        setExtendToBreakeven(false);
      }
    } else {
      setExtendToBreakeven(false);
    }

    setReclaimRemovedBase(false);
    preBreakevenRangeRef.current = null;
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const findCreateTx = (address: string): SimulatedTransaction | undefined =>
    transactions.find(tx => tx.type === 'add-position' && tx.positionAddress === address);

  const editSimulatedPosition = (address: string) => {
    const createTx = findCreateTx(address);
    if (createTx) {
      editTx(createTx);
      return;
    }
    const position = positions.find(p => p.positionAddress === address);
    if (!position) return;
    setPositionAddress(address);
    setLowerPrice(String(position.minPrice));
    setUpperPrice(String(position.maxPrice));
    setBaseAmount(position.baseAmount > DUST ? String(position.baseAmount) : '');
    setQuoteAmount(position.quoteAmount > DUST ? String(position.quoteAmount) : '');
    setStrategy(defaultStrategy);
    setEditingId(`tx-${address}`);
    setActiveForm('add-position');

    // Check if this initial simulated position should have breakeven enabled
    const bePrice = findBreakevenMaxPrice({
      baseSlices,
      transactions: [],
      replay: replayOptions || { binStep: 0, baseDecimals: 0, quoteDecimals: 0, applyDecimalAdjustment: false, activeBinId: 0 },
      strategy: defaultStrategy,
      baseAmount: position.baseAmount,
      quoteAmount: position.quoteAmount,
      lowerPrice: position.minPrice,
      upperPrice: position.maxPrice,
      currentPrice,
    });
    if (bePrice && Math.abs(bePrice - position.maxPrice) < 1e-9) {
      setExtendToBreakeven(true);
    } else {
      setExtendToBreakeven(false);
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const openNewPosition = () => {
    setEditingId(null);
    setBaseAmount('');
    setQuoteAmount('');
    setAutoFill(false);
    setExtendToBreakeven(false);
    setReclaimRemovedBase(false);
    preBreakevenRangeRef.current = null;
    lastAutoFilled.current = null;
    seedCreateRange('both');
    setActiveForm('add-position');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const openAddLiquidity = (address: string) => {
    setEditingId(null);
    setBaseAmount('');
    setQuoteAmount('');
    setAutoFill(false);
    setExtendToBreakeven(false);
    setReclaimRemovedBase(false);
    preBreakevenRangeRef.current = null;
    lastAutoFilled.current = null;
    setPositionAddress(address);
    setActiveForm('add-liquidity');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const openRemoveLiquidity = (address: string) => {
    const position = positions.find(item => item.positionAddress === address);
    setEditingId(null);
    setBaseAmount('');
    setQuoteAmount('');
    setRemovePct(100);
    setPositionAddress(address);
    if (position) seedRemovalRange(position);
    setActiveForm('remove-liquidity');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const hasTokenAmount = (Number(baseAmount) || 0) > 0 || (Number(quoteAmount) || 0) > 0;

  const adjustedPriceNote = useMemo(() => {
    if (!(initialPrice > 0) || !(currentPrice > 0)) return null;
    if (Math.abs(currentPrice - initialPrice) < 1e-9) return null;
    const pct = ((currentPrice - initialPrice) / initialPrice) * 100;
    const signedPct = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    const price = formatNumberForDisplay(currentPrice, { maximumFractionDigits: 6 });
    return { price, signedPct };
  }, [currentPrice, initialPrice]);

  const formTitle = activeForm === 'add-position'
    ? (editingId ? 'Edit simulated position' : 'New position')
    : activeForm === 'remove-liquidity'
      ? 'Remove Liquidity'
      : activeForm === 'add-liquidity'
        ? 'Add Liquidity'
        : 'Positions';

  const submitLabel = editingId
    ? activeForm === 'remove-liquidity'
      ? `Update removal (${removePct}%)`
      : activeForm === 'add-position'
        ? 'Update position'
        : 'Update liquidity'
    : activeForm === 'remove-liquidity'
      ? `Remove ${removePct}%`
      : activeForm === 'add-position'
        ? 'Create position'
        : 'Add liquidity';

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      {activeForm ? (
        <div className="space-y-3 lg:space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-sm font-medium truncate">{formTitle}</div>
            {positions.length > 0 && (
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={closeForm}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
            )}
          </div>

          {adjustedPriceNote && (activeForm === 'add-position' || activeForm === 'add-liquidity') && (
            <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
              Liquidity added will be based on the new adjusted price of{' '}
              <span className="font-medium tabular-nums">{adjustedPriceNote.price}</span>
              {' '}({adjustedPriceNote.signedPct} of simulation starting price).
            </p>
          )}

          {activeForm === 'add-position' && (
            <RangeEditor
              minPrice={Number(lowerPrice)}
              maxPrice={Number(upperPrice)}
              currentPrice={currentPrice}
              strategy={strategy}
              baseAmount={Number(baseAmount) || 0}
              quoteAmount={Number(quoteAmount) || 0}
              binStep={binStep}
              baseDecimals={baseDecimals}
              quoteDecimals={quoteDecimals}
              applyDecimalAdjustment={applyDecimalAdjustment}
              onChange={(nextMin, nextMax) => {
                setLowerPrice(String(nextMin));
                setUpperPrice(String(nextMax));
                rangeTouchedRef.current = true;
                if (extendToBreakeven) breakevenDriverRef.current = 'range';
              }}
              onInitialPriceChange={
                positions.length === 0 && transactions.length === 0
                  ? onInitialPriceChange
                  : undefined
              }
              defaultInitialPrice={
                positions.length === 0 && transactions.length === 0
                  ? poolStartPrice
                  : null
              }
            />
          )}

          {activeForm !== 'remove-liquidity' && (
            <>
              <div className="grid gap-2">
                <Label className="text-xs">Strategy</Label>
                <RadioGroup value={strategy} onValueChange={value => {
                  const next = value as Strategy;
                  if (extendToBreakeven && next !== strategy) breakevenDriverRef.current = 'strategy';
                  setStrategy(next);
                }} className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="spot" id="chg-spot" />
                    <Label htmlFor="chg-spot" className="cursor-pointer text-sm">Spot</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="bid-ask" id="chg-bidask" />
                    <Label htmlFor="chg-bidask" className="cursor-pointer text-sm">Bid-Ask</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="curve" id="chg-curve" />
                    <Label htmlFor="chg-curve" className="cursor-pointer text-sm">Curve</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/50 bg-secondary/50 p-2 lg:p-3">
                <Label htmlFor="chg-autoFill" className="cursor-pointer text-sm font-medium">Auto-Fill</Label>
                <Switch id="chg-autoFill" checked={autoFill} onCheckedChange={onAutoFillChange} />
              </div>
              {isDepositForm && (extendToBreakeven || canExtendToBreakeven) && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2 lg:p-3">
                  <div className="min-w-0">
                    <Label htmlFor="chg-extendToBreakeven" className="cursor-pointer text-sm font-medium">
                      Adjust position to break even
                    </Label>
                    <p className="text-[11px] leading-tight text-muted-foreground">
                      {breakevenPrice
                        ? `Sets the range top to ${formatNumberForDisplay(breakevenPrice, { maximumFractionDigits: 6 })} with ${formatNumberForDisplay(Number(baseAmount) || 0, { maximumFractionDigits: 6 })} ${tokenSymbols.base}.`
                        : ''}
                    </p>
                  </div>
                  <Switch
                    id="chg-extendToBreakeven"
                    checked={extendToBreakeven}
                    onCheckedChange={onExtendToBreakevenChange}
                  />
                </div>
              )}
              {isDepositForm && canReclaimRemovedBase && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-2 lg:p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Label htmlFor="chg-reinvestRemovedBase" className="text-sm font-medium">
                        Reinvest removed {tokenSymbols.base}
                      </Label>
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        {reclaimRemovedBaseHint
                          ? `Fills the position with ${formatNumberForDisplay(reclaimableBase, { maximumFractionDigits: 6 })} ${tokenSymbols.base} removed in earlier steps (≈${formatNumberForDisplay(reclaimRemovedBaseHint.quoteNeeded, { maximumFractionDigits: 4 })} ${tokenSymbols.quote} at current price).`
                          : ''}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      disabled={reinvestDisabled}
                      onClick={onReclaimRemovedBase}
                    >
                      Reinvest {tokenSymbols.base}
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs">{tokenSymbols.base}</Label>
                  <Input
                    value={baseAmount}
                    onChange={event => onBaseAmountChange(event.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">{tokenSymbols.quote}</Label>
                  <Input
                    value={quoteAmount}
                    onChange={event => onQuoteAmountChange(event.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>
            </>
          )}

          {activeForm === 'remove-liquidity' && (
            <div className="grid gap-3">
              {replayOptions && (
                <RemovalRangePicker
                  bins={removalBins}
                  minPrice={Number(lowerPrice) || selected?.minPrice || 0}
                  maxPrice={Number(upperPrice) || selected?.maxPrice || 0}
                  currentPrice={currentPrice}
                  binStep={binStep}
                  baseDecimals={baseDecimals}
                  quoteDecimals={quoteDecimals}
                  applyDecimalAdjustment={applyDecimalAdjustment}
                  tokenSymbols={tokenSymbols}
                  tokenIcons={tokenIcons}
                  removePct={removePct}
                  onRangeChange={(nextMin, nextMax) => {
                    setLowerPrice(String(nextMin));
                    setUpperPrice(String(nextMax));
                  }}
                  onRemovePctChange={setRemovePct}
                />
              )}
              <div className="grid gap-2">
                <div className="flex items-center justify-between text-xs">
                  <Label>Remove {removePct}%</Label>
                  <span className="text-muted-foreground">
                    {removalRangeIds && removalBins.length && (
                      removalRangeIds.minId > removalBins[0].id
                      || removalRangeIds.maxId < removalBins[removalBins.length - 1].id
                    )
                      ? 'of selected bins'
                      : 'of this position'}
                  </span>
                </div>
                <Slider
                  value={[removePct]}
                  min={1}
                  max={100}
                  step={1}
                  onValueChange={([value]) => setRemovePct(value)}
                />
                {removalPreview && (
                  <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs space-y-1">
                    <TokenAmounts
                      base={removalPreview.base}
                      quote={removalPreview.quote}
                      outOfRange={removalPreview.outOfRange}
                      symbols={tokenSymbols}
                      prefix="Removes "
                    />
                    {removalEconomics && (
                      <div className={cn(
                        'font-medium',
                        removalEconomics.proceeds - removalEconomics.costBasis > 1e-9
                          ? 'text-green-400'
                          : removalEconomics.proceeds - removalEconomics.costBasis < -1e-9
                            ? 'text-red-400'
                            : 'text-muted-foreground'
                      )}>
                        {formatRealizedPnl(
                          removalEconomics.proceeds - removalEconomics.costBasis,
                          tokenSymbols.quote
                        )}
                        {' '}at {formatNumberForDisplay(currentPrice, { maximumFractionDigits: 6 })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <Button
            type="button"
            onClick={apply}
            className="w-full"
            disabled={
              activeForm === 'remove-liquidity'
                ? !selected
                : activeForm === 'add-liquidity'
                  ? !selected || !hasTokenAmount
                  : !hasTokenAmount
            }
          >
            {submitLabel}
          </Button>
          {activeForm === 'add-position' && (
            <p className="text-[11px] text-muted-foreground">
              {positions.length === 0 && transactions.length === 0
                ? 'The initial price sets cost basis and how liquidity is split across the range. Drag it outside the min/max handles for a one-sided deposit.'
                : 'New liquidity uses the simulated current price for bin shape and cost basis. One-sided quote is placed at or below that price; one-sided base at or above.'}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Positions</div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={openNewPosition}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New
              </Button>
              {showRestore && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={onRestore}
                  disabled={transactions.length === 0}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Restore original
                </Button>
              )}
            </div>
          </div>

          {showRestore && transactions.length === 0 && !entryPriceFromHistory && (
            <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs leading-snug">
              <span className="font-semibold">Set the initial price</span>
              {' '}on the Analysis chart. It is the cost basis for these loaded wallet positions and locks after the first simulated transaction.
            </p>
          )}

          {showRestore && entryPriceFromHistory && historyStatusMessage && (
            <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs leading-snug text-muted-foreground">
              {historyStatusMessage}
            </p>
          )}

          <div className="space-y-2">
            {positions.length === 0 && (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {emptyHint || 'No positions yet. Create one to start the simulation.'}
                </p>
                <Button type="button" className="mt-3" size="sm" onClick={openNewPosition}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  New position
                </Button>
              </div>
            )}
            {positions.map(position => (
              <div
                key={position.positionAddress}
                className={cn(
                  'w-full rounded-md border p-3 text-left text-xs',
                  position.isSimulated
                    ? 'border-primary/40 bg-secondary/30'
                    : 'border-border/60 bg-secondary/30'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{positionTitle(position)}</span>
                  <div className="flex items-center gap-1">
                    {position.isSimulated && <Badge variant="outline">Simulated</Badge>}
                    {position.isOutOfRange ? (
                      <Badge variant="destructive">OOR</Badge>
                    ) : (
                      <Badge variant="secondary">In range</Badge>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span>{position.minPrice.toPrecision(5)} – {position.maxPrice.toPrecision(5)}</span>
                  <span>{formatUSD(position.valueUsd)}</span>
                </div>
                <div className="mt-1 font-medium">
                  <TokenAmounts
                    base={position.baseAmount}
                    quote={position.quoteAmount}
                    outOfRange={position.isOutOfRange}
                    symbols={tokenSymbols}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => openAddLiquidity(position.positionAddress)}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => openRemoveLiquidity(position.positionAddress)}
                  >
                    <Minus className="mr-1 h-3 w-3" />
                    Remove
                  </Button>
                  {position.isSimulated && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => editSimulatedPosition(position.positionAddress)}
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit
                    </Button>
                  )}
                  {position.isSimulated && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => onDeletePosition(position.positionAddress)}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {transactions.length > 0 && (
            <div className="space-y-2 border-t border-border/50 pt-3">
              <div className="text-sm font-medium">Simulated transaction log</div>
              <div className="space-y-2">
                {transactions.map((tx, index) => {
                  const economics = txLedger?.perTx[index];
                  const realized = economics?.realizedPnl ?? 0;
                  return (
                  <div key={tx.id} className="rounded-md border bg-secondary/30 p-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-normal">#{index + 1}</Badge>
                          <span className="font-medium capitalize">{tx.type.replace('-', ' ')}</span>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {describeTransaction(tx, tokenSymbols)}
                        </p>
                        {tx.type === 'remove-liquidity' && economics && (
                          <p className={cn(
                            'mt-0.5 font-medium',
                            realized > 1e-9 ? 'text-green-400' : realized < -1e-9 ? 'text-red-400' : 'text-muted-foreground'
                          )}>
                            {formatRealizedPnl(realized, tokenSymbols.quote)}
                          </p>
                        )}
                        <p className="mt-0.5 font-mono text-muted-foreground">
                          {txPositionLabel(tx.positionAddress)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => editTx(tx)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onRemoveTx(tx.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
