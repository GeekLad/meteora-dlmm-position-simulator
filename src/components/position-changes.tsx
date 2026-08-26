'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Minus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { formatNumberForDisplay } from '@/lib/display-formatting';
import { formatUSD } from '@/lib/meteora-api';
import { positionDisplayName, shortenAddress, type WalletPositionDetail } from '@/lib/wallet-positions';
import {
  describeTransaction,
  newSimulatedPositionAddress,
  newTxId,
  type SimulatedTransaction,
  type SimulatedTxType,
} from '@/lib/position-transactions';
import { RangeEditor } from '@/components/range-editor';
import { depositSide, getIdFromPrice, pairAmountForStrategy, rangeForDeposit, type Strategy } from '@/lib/dlmm';

export interface ChangeFocus {
  mode: SimulatedTxType;
  positionAddress?: string;
}

interface PositionChangesProps {
  positions: WalletPositionDetail[];
  transactions: SimulatedTransaction[];
  currentPrice: number;
  tokenSymbols: { base: string; quote: string };
  defaultLowerPrice: number;
  defaultUpperPrice: number;
  defaultStrategy?: Strategy;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  focusRequest: ChangeFocus | null;
  onApply: (tx: SimulatedTransaction) => void;
  onRemoveTx: (id: string) => void;
  onDeletePosition: (positionAddress: string) => void;
  onRestore: () => void;
  onFocusHandled: () => void;
  emptyHint?: string;
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
  tokenSymbols,
  defaultLowerPrice,
  defaultUpperPrice,
  defaultStrategy = 'spot',
  binStep,
  baseDecimals,
  quoteDecimals,
  applyDecimalAdjustment,
  focusRequest,
  onApply,
  onRemoveTx,
  onDeletePosition,
  onRestore,
  onFocusHandled,
  emptyHint,
}: PositionChangesProps) {
  const [mode, setMode] = useState<SimulatedTxType>(() => {
    const onlyDrafts = positions.length === 0 || positions.every(position => position.isSimulated);
    return transactions.length === 0 && onlyDrafts ? 'add-position' : 'add-liquidity';
  });
  const [positionAddress, setPositionAddress] = useState<string>(positions[0]?.positionAddress ?? '');
  const [strategy, setStrategy] = useState<Strategy>('spot');
  const [baseAmount, setBaseAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [lowerPrice, setLowerPrice] = useState(String(defaultLowerPrice || ''));
  const [upperPrice, setUpperPrice] = useState(String(defaultUpperPrice || ''));
  const [removePct, setRemovePct] = useState(25);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoFill, setAutoFill] = useState(false);
  const lastAutoFilled = useRef<'base' | 'quote' | null>(null);
  const rangeTouchedRef = useRef(false);

  const positionTitle = (position: WalletPositionDetail) => positionDisplayName(position, positions);

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
    return 69;
  }, [positions, binStep, defaultLowerPrice, defaultUpperPrice, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const seedCreateRange = () => {
    if (currentPrice > 0 && binStep > 0) {
      const side = depositSide(Number(baseAmount) || 0, Number(quoteAmount) || 0);
      const range = rangeForDeposit({
        currentPrice,
        binStep,
        widthBins: templateWidthBins,
        side,
        baseDecimals,
        quoteDecimals,
        applyDecimalAdjustment,
      });
      setLowerPrice(String(range.lowerPrice));
      setUpperPrice(String(range.upperPrice));
      rangeTouchedRef.current = false;
      return;
    }
    setLowerPrice(String(defaultLowerPrice || currentPrice * 0.95));
    setUpperPrice(String(defaultUpperPrice || currentPrice * 1.05));
    rangeTouchedRef.current = false;
  };

  useEffect(() => {
    if (!positionAddress && positions[0]) {
      setPositionAddress(positions[0].positionAddress);
    }
  }, [positionAddress, positions]);

  // Exit edit mode when the transaction being edited is removed.
  useEffect(() => {
    if (editingId && !transactions.some(tx => tx.id === editingId)) {
      setEditingId(null);
      if (mode === 'add-position') setMode('add-liquidity');
    }
  }, [editingId, transactions, mode]);

  useEffect(() => {
    if (!focusRequest) return;
    setMode(focusRequest.mode);
    if (focusRequest.positionAddress) setPositionAddress(focusRequest.positionAddress);
    onFocusHandled();
  }, [focusRequest, onFocusHandled]);

  useEffect(() => {
    if (mode !== 'add-position' || editingId) return;
    if (rangeTouchedRef.current) return;
    if (!(currentPrice > 0) || !(binStep > 0)) return;
    seedCreateRange();
    // Re-place an unedited Create range when price moves or the deposit becomes one-sided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, mode, editingId, baseAmount, quoteAmount, templateWidthBins]);

  const selected = useMemo(
    () => positions.find(position => position.positionAddress === positionAddress),
    [positions, positionAddress]
  );

  const autoFillRange = useMemo(() => {
    if (mode === 'add-position') {
      const minP = Number(lowerPrice);
      const maxP = Number(upperPrice);
      if (minP > 0 && maxP >= minP) return { lower: minP, upper: maxP };
      return null;
    }
    if (selected) return { lower: selected.minPrice, upper: selected.maxPrice };
    return null;
  }, [mode, lowerPrice, upperPrice, selected]);

  const fillPairedAmount = (known: 'base' | 'quote', amount: number) => {
    if (!autoFill || !autoFillRange || !(amount > 0) || !(binStep > 0) || !(currentPrice > 0)) return;
    const paired = pairAmountForStrategy({
      strategy,
      binStep,
      activePrice: currentPrice,
      lowerPrice: autoFillRange.lower,
      upperPrice: autoFillRange.upper,
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

  useEffect(() => {
    if (!autoFill || mode === 'remove-liquidity' || !autoFillRange) return;
    const base = Number(baseAmount) || 0;
    const quote = Number(quoteAmount) || 0;
    if (lastAutoFilled.current === 'quote' && base > 0) fillPairedAmount('base', base);
    else if (lastAutoFilled.current === 'base' && quote > 0) fillPairedAmount('quote', quote);
    else if (quote > 0) fillPairedAmount('quote', quote);
    else if (base > 0) fillPairedAmount('base', base);
    // Intentionally omit amount fields so typing doesn't double-fire via this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFill, strategy, autoFillRange, currentPrice, binStep, mode]);

  const onBaseAmountChange = (value: string) => {
    setBaseAmount(value);
    const amount = Number(value);
    if (autoFill && amount > 0) fillPairedAmount('base', amount);
  };

  const onQuoteAmountChange = (value: string) => {
    setQuoteAmount(value);
    const amount = Number(value);
    if (autoFill && amount > 0) fillPairedAmount('quote', amount);
  };

  const removalPreview = useMemo(() => {
    if (!selected || mode !== 'remove-liquidity') return null;
    const factor = removePct / 100;
    return {
      base: selected.baseAmount * factor,
      quote: selected.quoteAmount * factor,
      outOfRange: selected.isOutOfRange,
    };
  }, [selected, mode, removePct]);

  const resetFormAmounts = () => {
    setBaseAmount('');
    setQuoteAmount('');
    setEditingId(null);
  };

  const apply = () => {
    const price = currentPrice;
    if (!Number.isFinite(price) || price <= 0) return;

    if (mode === 'remove-liquidity') {
      if (!positionAddress || removePct <= 0) return;
      onApply({
        id: editingId ?? newTxId(),
        type: 'remove-liquidity',
        price,
        strategy,
        baseAmount: removalPreview?.base ?? 0,
        quoteAmount: removalPreview?.quote ?? 0,
        lowerPrice: selected?.minPrice ?? 0,
        upperPrice: selected?.maxPrice ?? 0,
        positionAddress,
        removeBps: Math.round(removePct * 100),
      });
      resetFormAmounts();
      return;
    }

    const base = Number(baseAmount) || 0;
    const quote = Number(quoteAmount) || 0;
    if (base <= 0 && quote <= 0) return;

    if (mode === 'add-position') {
      const minP = Number(lowerPrice);
      const maxP = Number(upperPrice);
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
      resetFormAmounts();
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
      lowerPrice: selected?.minPrice ?? 0,
      upperPrice: selected?.maxPrice ?? 0,
      positionAddress,
      removeBps: 0,
    });
    resetFormAmounts();
  };

  const editTx = (tx: SimulatedTransaction) => {
    setMode(tx.type);
    setPositionAddress(tx.positionAddress);
    setStrategy(tx.strategy);
    setBaseAmount(tx.baseAmount ? String(tx.baseAmount) : '');
    setQuoteAmount(tx.quoteAmount ? String(tx.quoteAmount) : '');
    setLowerPrice(String(tx.lowerPrice || defaultLowerPrice));
    setUpperPrice(String(tx.upperPrice || defaultUpperPrice));
    setRemovePct(tx.removeBps / 100);
    setEditingId(tx.id);
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
    setMode('add-position');
    setPositionAddress(address);
    setLowerPrice(String(position.minPrice));
    setUpperPrice(String(position.maxPrice));
    setBaseAmount(position.baseAmount > DUST ? String(position.baseAmount) : '');
    setQuoteAmount(position.quoteAmount > DUST ? String(position.quoteAmount) : '');
    setStrategy(defaultStrategy);
    setEditingId(`tx-${address}`);
  };

  const selectPosition = (address: string, nextMode?: SimulatedTxType) => {
    setPositionAddress(address);
    if (nextMode) setMode(nextMode);
    else if (mode === 'add-position') setMode('add-liquidity');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Positions</div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              setMode('add-position');
              setEditingId(null);
              seedCreateRange();
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New
          </Button>
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
        </div>
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto">
        {positions.length === 0 && (
          <p className="text-xs text-muted-foreground">{emptyHint || 'No positions yet. Create one below.'}</p>
        )}
        {positions.map(position => {
          const isEditingThis = Boolean(editingId) && mode === 'add-position' && position.positionAddress === positionAddress;
          const isSelected = (position.positionAddress === positionAddress && mode !== 'add-position') || isEditingThis;
          return (
            <div
              key={position.positionAddress}
              role="button"
              tabIndex={0}
              onClick={() => selectPosition(position.positionAddress)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectPosition(position.positionAddress);
                }
              }}
              className={`w-full cursor-pointer rounded-md border p-2.5 text-left text-xs transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/10'
                  : position.isSimulated
                    ? 'border-primary/40 bg-secondary/30 hover:border-primary/60'
                    : 'bg-secondary/30 hover:border-primary/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono">
                  {positionTitle(position)}
                </span>
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
              <div className="mt-2 flex flex-wrap gap-1" onClick={event => event.stopPropagation()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => selectPosition(position.positionAddress, 'add-liquidity')}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => selectPosition(position.positionAddress, 'remove-liquidity')}
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
          );
        })}
      </div>

      <div className="space-y-4 border-t border-border/50 pt-3">
        <div className="text-sm font-medium">
          {mode === 'add-position'
            ? (editingId ? 'Edit simulated position' : 'New position')
            : selected
              ? `${mode === 'remove-liquidity' ? 'Remove from' : 'Add to'} ${selected.isSimulated ? 'simulated position' : shortenAddress(selected.positionAddress, 4)}`
              : 'Select a position'}
        </div>

        <Tabs value={mode} onValueChange={(value) => {
          const next = value as SimulatedTxType;
          setMode(next);
          setEditingId(null);
          if (next === 'add-position') seedCreateRange();
        }}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="add-liquidity" className="text-xs sm:text-sm">Add liquidity</TabsTrigger>
            <TabsTrigger value="remove-liquidity" className="text-xs sm:text-sm">Remove</TabsTrigger>
            <TabsTrigger value="add-position" className="text-xs sm:text-sm">Create</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'add-position' && (
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
              rangeTouchedRef.current = true;
              setLowerPrice(String(nextMin));
              setUpperPrice(String(nextMax));
            }}
          />
        )}

        {mode !== 'remove-liquidity' && (
          <>
            <div className="grid gap-2">
              <Label className="text-xs">Strategy</Label>
              <RadioGroup value={strategy} onValueChange={value => setStrategy(value as Strategy)} className="flex gap-4">
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
            <div className="flex items-center justify-between rounded-lg border border-border/50 bg-secondary/50 p-3">
              <Label htmlFor="chg-autoFill" className="cursor-pointer text-sm font-medium">Auto-Fill</Label>
              <Switch id="chg-autoFill" checked={autoFill} onCheckedChange={setAutoFill} />
            </div>
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

        {mode === 'remove-liquidity' && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-xs">
              <Label>Remove {removePct}%</Label>
              <span className="text-muted-foreground">of this position</span>
            </div>
            <Slider
              value={[removePct]}
              min={1}
              max={100}
              step={1}
              onValueChange={([value]) => setRemovePct(value)}
            />
            {removalPreview && (
              <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                <TokenAmounts
                  base={removalPreview.base}
                  quote={removalPreview.quote}
                  outOfRange={removalPreview.outOfRange}
                  symbols={tokenSymbols}
                  prefix="Removes "
                />
              </div>
            )}
          </div>
        )}

        <Button type="button" onClick={apply} className="w-full" disabled={mode !== 'add-position' && !selected}>
          {editingId
            ? mode === 'remove-liquidity'
              ? `Update removal (${removePct}%)`
              : mode === 'add-position'
                ? 'Update position'
                : 'Update liquidity'
            : mode === 'remove-liquidity'
              ? `Remove ${removePct}%`
              : mode === 'add-position'
                ? 'Create position'
                : 'Add liquidity'}
        </Button>
        {mode === 'add-position' && (
          <p className="text-[11px] text-muted-foreground">
            New liquidity uses the simulated current price for bin shape and cost basis.
            One-sided quote is placed at or below that price; one-sided base at or above.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border/50 pt-3">
        <div className="text-sm font-medium">Transaction log</div>
        {transactions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No simulated changes yet.</p>
        ) : (
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {transactions.map((tx, index) => (
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
