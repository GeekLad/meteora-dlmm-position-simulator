'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/utils';
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
        baseAmount: 0,
        quoteAmount: 0,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Simulate changes</div>
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

      <Tabs value={mode} onValueChange={(value) => { setMode(value as SimulatedTxType); setEditingId(null); }}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="add-liquidity" className="text-xs sm:text-sm">Add liquidity</TabsTrigger>
          <TabsTrigger value="remove-liquidity" className="text-xs sm:text-sm">Remove</TabsTrigger>
          <TabsTrigger value="add-position" className="text-xs sm:text-sm">Create</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode !== 'add-position' && (
        <div className="grid gap-2">
          <Label className="text-xs">Position</Label>
          <Select value={positionAddress} onValueChange={setPositionAddress}>
            <SelectTrigger>
              <SelectValue placeholder="Select a position" />
            </SelectTrigger>
            <SelectContent>
              {positions.map(position => (
                <SelectItem key={position.positionAddress} value={position.positionAddress}>
                  {position.isSimulated ? 'Sim · ' : ''}
                  {shortenAddress(position.positionAddress, 4)}
                  {' · '}
                  {position.minPrice.toPrecision(4)}–{position.maxPrice.toPrecision(4)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <p className="text-xs text-muted-foreground">
              Range {selected.minPrice.toPrecision(5)} – {selected.maxPrice.toPrecision(5)}
              {selected.isSimulated ? ' · simulated' : ''}
            </p>
          )}
        </div>
      )}

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
        </div>
      )}

      <Button type="button" onClick={apply} className="w-full">
        {editingId ? 'Update' : 'Apply'} at {formatNumber(currentPrice, 6)}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        New liquidity is allocated using the simulated current price, which sets the bin shape and cost basis.
      </p>

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
