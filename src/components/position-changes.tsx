'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Minus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/utils';
import { formatNumberForDisplay } from '@/lib/display-formatting';
import { formatUSD } from '@/lib/meteora-api';
import { shortenAddress, type WalletPositionDetail } from '@/lib/wallet-positions';
import {
  describeTransaction,
  newSimulatedPositionAddress,
  newTxId,
  type SimulatedTransaction,
  type SimulatedTxType,
} from '@/lib/position-transactions';
import type { Strategy } from '@/lib/dlmm';

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
  focusRequest: ChangeFocus | null;
  onApply: (tx: SimulatedTransaction) => void;
  onRemoveTx: (id: string) => void;
  onRestore: () => void;
  onFocusHandled: () => void;
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
  focusRequest,
  onApply,
  onRemoveTx,
  onRestore,
  onFocusHandled,
}: PositionChangesProps) {
  const [mode, setMode] = useState<SimulatedTxType>('add-liquidity');
  const [positionAddress, setPositionAddress] = useState<string>(positions[0]?.positionAddress ?? '');
  const [strategy, setStrategy] = useState<Strategy>('spot');
  const [baseAmount, setBaseAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [lowerPrice, setLowerPrice] = useState(String(defaultLowerPrice || ''));
  const [upperPrice, setUpperPrice] = useState(String(defaultUpperPrice || ''));
  const [removePct, setRemovePct] = useState(25);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!positionAddress && positions[0]) {
      setPositionAddress(positions[0].positionAddress);
    }
  }, [positionAddress, positions]);

  useEffect(() => {
    if (!focusRequest) return;
    setMode(focusRequest.mode);
    if (focusRequest.positionAddress) setPositionAddress(focusRequest.positionAddress);
    onFocusHandled();
  }, [focusRequest, onFocusHandled]);

  const selected = useMemo(
    () => positions.find(position => position.positionAddress === positionAddress),
    [positions, positionAddress]
  );

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
      if (!(minP > 0) || !(maxP > minP)) return;
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
          ? (transactions.find(tx => tx.id === editingId)?.positionAddress ?? newSimulatedPositionAddress())
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
        {positions.map(position => {
          const isSelected = position.positionAddress === positionAddress && mode !== 'add-position';
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
                  {position.isSimulated ? 'Simulated' : shortenAddress(position.positionAddress, 4)}
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
              <div className="mt-2 flex gap-1" onClick={event => event.stopPropagation()}>
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
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-4 border-t border-border/50 pt-3">
        <div className="text-sm font-medium">
          {mode === 'add-position'
            ? 'New position'
            : selected
              ? `${mode === 'remove-liquidity' ? 'Remove from' : 'Add to'} ${selected.isSimulated ? 'simulated position' : shortenAddress(selected.positionAddress, 4)}`
              : 'Select a position'}
        </div>

        <Tabs value={mode} onValueChange={(value) => { setMode(value as SimulatedTxType); setEditingId(null); }}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="add-liquidity" className="text-xs sm:text-sm">Add liquidity</TabsTrigger>
            <TabsTrigger value="remove-liquidity" className="text-xs sm:text-sm">Remove</TabsTrigger>
            <TabsTrigger value="add-position" className="text-xs sm:text-sm">Create</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'add-position' && (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="chg-min-price" className="text-xs">Min price</Label>
              <Input id="chg-min-price" value={lowerPrice} onChange={event => setLowerPrice(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="chg-max-price" className="text-xs">Max price</Label>
              <Input id="chg-max-price" value={upperPrice} onChange={event => setUpperPrice(event.target.value)} />
            </div>
          </div>
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
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">{tokenSymbols.base}</Label>
                <Input
                  value={baseAmount}
                  onChange={event => setBaseAmount(event.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{tokenSymbols.quote}</Label>
                <Input
                  value={quoteAmount}
                  onChange={event => setQuoteAmount(event.target.value)}
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
          {editingId ? 'Update' : 'Apply'} at {formatNumber(currentPrice, 6)}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          New liquidity is allocated using the simulated current price, which sets the bin shape and cost basis.
        </p>
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
                      {shortenAddress(tx.positionAddress, 4)}
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
