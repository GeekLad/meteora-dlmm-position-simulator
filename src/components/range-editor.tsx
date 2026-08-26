'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatNumberForDisplay } from '@/lib/display-formatting';
import {
  binInitialDisplayValue,
  getIdFromPrice,
  getInitialBinsForBinRange,
  getPriceFromId,
  type Strategy,
} from '@/lib/dlmm';

const MAX_POSITION_BINS = 1400;
const DUST = 1e-9;

interface RangeEditorProps {
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  strategy: Strategy;
  baseAmount: number;
  quoteAmount: number;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  onChange: (minPrice: number, maxPrice: number) => void;
}

function snapPrice(
  price: number,
  binStep: number,
  baseDecimals: number,
  quoteDecimals: number,
  applyDecimalAdjustment: boolean
): { id: number; price: number } {
  const id = getIdFromPrice(price, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  return {
    id,
    price: getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
  };
}

function priceFromPct(currentPrice: number, pct: number): number {
  return currentPrice * (1 + pct / 100);
}

function pctFromPrice(price: number, currentPrice: number): number {
  if (!(currentPrice > 0)) return 0;
  return ((price / currentPrice) - 1) * 100;
}

function formatBoundPrice(price: number, compact = false): string {
  if (!(price > 0) || !Number.isFinite(price)) return '';
  if (price >= 1) {
    return price.toLocaleString('en-US', {
      maximumFractionDigits: compact ? 2 : 4,
      minimumFractionDigits: 2,
    });
  }
  return formatNumberForDisplay(price, { maximumFractionDigits: compact ? 4 : 8, minimumFractionDigits: 2 });
}

function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '';
  const abs = Math.abs(pct);
  const body = abs.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (Math.abs(pct) < 0.005) return '0.00%';
  return `${pct > 0 ? '+' : '-'}${body}%`;
}

function parsePrice(raw: string): number | null {
  const n = Number(raw.trim().replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePct(raw: string): number | null {
  const cleaned = raw.trim().replace(/%/g, '').replace(/\+/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function RangeEditor({
  minPrice,
  maxPrice,
  currentPrice,
  strategy,
  baseAmount,
  quoteAmount,
  binStep,
  baseDecimals,
  quoteDecimals,
  applyDecimalAdjustment,
  onChange,
}: RangeEditorProps) {
  const bounds = useMemo(() => {
    if (!(binStep > 0) || !(minPrice > 0) || !(maxPrice > 0)) return null;
    const min = snapPrice(minPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    const max = snapPrice(maxPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    if (max.id < min.id) return null;
    return { min, max, bins: max.id - min.id + 1 };
  }, [minPrice, maxPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment]);

  const clampRange = useCallback((minId: number, maxId: number) => {
    let nextMin = minId;
    let nextMax = maxId;
    if (nextMin > nextMax) {
      if (bounds && maxId === bounds.max.id) nextMin = nextMax;
      else nextMax = nextMin;
    }
    const count = nextMax - nextMin + 1;
    if (count > MAX_POSITION_BINS) {
      const grewLeft = bounds ? nextMin < bounds.min.id : false;
      if (grewLeft) nextMax = nextMin + MAX_POSITION_BINS - 1;
      else nextMin = nextMax - MAX_POSITION_BINS + 1;
    }
    if (bounds && nextMin === bounds.min.id && nextMax === bounds.max.id) return;
    onChange(
      getPriceFromId(nextMin, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
      getPriceFromId(nextMax, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    );
  }, [applyDecimalAdjustment, baseDecimals, binStep, bounds, onChange, quoteDecimals]);

  const stepMin = (delta: number) => {
    if (!bounds) return;
    clampRange(bounds.min.id + delta, bounds.max.id);
  };

  const setMinPrice = (price: number) => {
    if (!bounds || !(price > 0)) return;
    const snapped = snapPrice(price, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    clampRange(Math.min(snapped.id, bounds.max.id), bounds.max.id);
  };

  const stepMax = (delta: number) => {
    if (!bounds) return;
    clampRange(bounds.min.id, bounds.max.id + delta);
  };

  const setMaxPrice = (price: number) => {
    if (!bounds || !(price > 0)) return;
    const snapped = snapPrice(price, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
    clampRange(bounds.min.id, Math.max(snapped.id, bounds.min.id));
  };

  return (
    <div className="space-y-2 lg:space-y-3">
      <RangePreview
        minBinId={bounds?.min.id ?? 0}
        maxBinId={bounds?.max.id ?? 0}
        currentPrice={currentPrice}
        strategy={strategy}
        baseAmount={baseAmount}
        quoteAmount={quoteAmount}
        binStep={binStep}
        baseDecimals={baseDecimals}
        quoteDecimals={quoteDecimals}
        applyDecimalAdjustment={applyDecimalAdjustment}
        enabled={Boolean(bounds)}
        onDragMin={id => bounds && clampRange(id, bounds.max.id)}
        onDragMax={id => bounds && clampRange(bounds.min.id, id)}
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
        <PriceBoundField
          label="Min Price"
          price={bounds?.min.price ?? minPrice}
          currentPrice={currentPrice}
          onPriceChange={setMinPrice}
          onStep={stepMin}
          canStepDown={bounds ? bounds.bins < MAX_POSITION_BINS : false}
          canStepUp={bounds ? bounds.bins > 1 : false}
        />
        </div>
        <div className="min-w-0">
        <PriceBoundField
          label="Max Price"
          price={bounds?.max.price ?? maxPrice}
          currentPrice={currentPrice}
          onPriceChange={setMaxPrice}
          onStep={stepMax}
          canStepDown={bounds ? bounds.bins > 1 : false}
          canStepUp={bounds ? bounds.bins < MAX_POSITION_BINS : false}
        />
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Total Bins:{' '}
        <span className="font-semibold text-foreground">{bounds?.bins ?? '—'}</span>
      </div>
    </div>
  );
}

function RangePreview({
  minBinId,
  maxBinId,
  currentPrice,
  strategy,
  baseAmount,
  quoteAmount,
  binStep,
  baseDecimals,
  quoteDecimals,
  applyDecimalAdjustment,
  enabled,
  onDragMin,
  onDragMax,
}: {
  minBinId: number;
  maxBinId: number;
  currentPrice: number;
  strategy: Strategy;
  baseAmount: number;
  quoteAmount: number;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  enabled: boolean;
  onDragMin: (binId: number) => void;
  onDragMax: (binId: number) => void;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    edge: 'min' | 'max';
    startX: number;
    startId: number;
    pxPerBin: number;
  } | null>(null);
  const [dragging, setDragging] = useState<'min' | 'max' | null>(null);

  const hasAmounts = baseAmount > DUST || quoteAmount > DUST;

  const bins = useMemo(() => {
    if (!enabled || !hasAmounts || !(binStep > 0) || !(currentPrice > 0) || maxBinId < minBinId) return [];
    const activeId = getIdFromPrice(
      currentPrice,
      binStep,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment
    );
    return getInitialBinsForBinRange({
      binStep,
      minBinId,
      maxBinId,
      activeBinId: activeId,
      baseAmount,
      quoteAmount,
      strategy,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    });
  }, [
    applyDecimalAdjustment,
    baseAmount,
    baseDecimals,
    binStep,
    currentPrice,
    enabled,
    hasAmounts,
    maxBinId,
    minBinId,
    quoteAmount,
    quoteDecimals,
    strategy,
  ]);

  const maxValue = useMemo(() => {
    if (bins.length === 0) return 1;
    return Math.max(...bins.map(bin => binInitialDisplayValue(bin)), 0) || 1;
  }, [bins]);

  const ticks = useMemo(() => {
    if (!enabled || !(binStep > 0) || maxBinId < minBinId) return [];
    const count = Math.min(3, maxBinId - minBinId + 1);
    if (count === 1) {
      return [{
        price: getPriceFromId(minBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
        position: 50,
      }];
    }
    return Array.from({ length: count }, (_, i) => {
      const id = Math.round(minBinId + (i / (count - 1)) * (maxBinId - minBinId));
      const position = (i / (count - 1)) * 100;
      return {
        price: getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
        position,
      };
    });
  }, [applyDecimalAdjustment, baseDecimals, binStep, enabled, maxBinId, minBinId, quoteDecimals]);

  const minBoundPrice = enabled && binStep > 0
    ? getPriceFromId(minBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : 0;
  const maxBoundPrice = enabled && binStep > 0
    ? getPriceFromId(maxBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : 0;

  const applyDrag = useCallback((clientX: number) => {
    const drag = dragRef.current;
    if (!drag || !(drag.pxPerBin > 0)) return;
    const deltaBins = Math.round((clientX - drag.startX) / drag.pxPerBin);
    const nextId = drag.startId + deltaBins;
    if (drag.edge === 'min') onDragMin(nextId);
    else onDragMax(nextId);
  }, [onDragMax, onDragMin]);

  const startDrag = (edge: 'min' | 'max', event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || !chartRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = chartRef.current.getBoundingClientRect();
    const count = Math.max(1, maxBinId - minBinId + 1);
    dragRef.current = {
      edge,
      startX: event.clientX,
      startId: edge === 'min' ? minBinId : maxBinId,
      pxPerBin: rect.width / Math.max(count, 20),
    };
    setDragging(edge);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already have been released.
      }
    }
    dragRef.current = null;
    setDragging(null);
  };

  if (!enabled) {
    return (
      <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/60 text-xs text-muted-foreground">
        Set a min and max price to preview the range.
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2.5">
      {hasAmounts && bins.length > 0 && (
        <div className={`flex h-16 items-end ${bins.length > 80 ? '' : 'gap-px'}`}>
          {bins.map(bin => {
            const value = binInitialDisplayValue(bin);
            const height = value > DUST ? Math.max((value / maxValue) * 100, 4) : 3;
            const color = bin.initialTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)';
            return (
              <div
                key={bin.id}
                className="min-w-0 flex-1 rounded-t-[1px]"
                style={{
                  height: `${height}%`,
                  backgroundColor: color,
                  opacity: value > DUST ? 0.95 : 0.25,
                }}
              />
            );
          })}
        </div>
      )}

      <div
        ref={chartRef}
        className="relative h-5 select-none"
        style={{ touchAction: 'none' }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-primary/80" />
        <Handle
          edge="min"
          dragging={dragging === 'min'}
          onPointerDown={event => startDrag('min', event)}
          onPointerMove={event => applyDrag(event.clientX)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); onDragMin(minBinId - 1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); onDragMin(minBinId + 1); }
          }}
          ariaValue={minBoundPrice}
          ariaMin={0}
          ariaMax={maxBoundPrice}
        />
        <Handle
          edge="max"
          dragging={dragging === 'max'}
          onPointerDown={event => startDrag('max', event)}
          onPointerMove={event => applyDrag(event.clientX)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); onDragMax(maxBinId - 1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); onDragMax(maxBinId + 1); }
          }}
          ariaValue={maxBoundPrice}
          ariaMin={minBoundPrice}
          ariaMax={Number.POSITIVE_INFINITY}
        />
      </div>

      <div className="relative h-4">
        {ticks.map((tick, index) => (
          <div
            key={`${tick.price}-${index}`}
            className="absolute text-[10px] tabular-nums text-muted-foreground"
            style={{
              left: `${tick.position}%`,
              transform: tick.position === 0 ? 'translateX(0)' : tick.position === 100 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {formatBoundPrice(tick.price, true)}
          </div>
        ))}
      </div>
    </div>
  );
}

function Handle({
  edge,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  ariaValue,
  ariaMin,
  ariaMax,
}: {
  edge: 'min' | 'max';
  dragging: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  ariaValue: number;
  ariaMin: number;
  ariaMax: number;
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={edge === 'min' ? 'Minimum price' : 'Maximum price'}
      aria-valuemin={ariaMin}
      aria-valuemax={Number.isFinite(ariaMax) ? ariaMax : undefined}
      aria-valuenow={ariaValue}
      aria-valuetext={formatBoundPrice(ariaValue)}
      className="absolute top-1/2 z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
      style={{ left: edge === 'min' ? '0%' : '100%', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full border-2 border-background bg-primary shadow-md ${
          dragging ? 'scale-110 ring-2 ring-primary/40' : ''
        }`}
      />
    </div>
  );
}

function PriceBoundField({
  label,
  price,
  currentPrice,
  onPriceChange,
  onStep,
  canStepDown,
  canStepUp,
}: {
  label: string;
  price: number;
  currentPrice: number;
  onPriceChange: (price: number) => void;
  onStep: (deltaBins: number) => void;
  canStepDown: boolean;
  canStepUp: boolean;
}) {
  const priceId = useId();
  const pctId = useId();
  const [priceDraft, setPriceDraft] = useState<string | null>(null);
  const [pctDraft, setPctDraft] = useState<string | null>(null);
  const pct = pctFromPrice(price, currentPrice);

  useEffect(() => {
    setPriceDraft(null);
    setPctDraft(null);
  }, [price]);

  const commitPrice = (raw: string) => {
    const parsed = parsePrice(raw);
    setPriceDraft(null);
    if (parsed != null) onPriceChange(parsed);
  };

  const commitPct = (raw: string) => {
    const parsed = parsePct(raw);
    setPctDraft(null);
    if (parsed == null || !(currentPrice > 0)) return;
    onPriceChange(priceFromPct(currentPrice, parsed));
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={priceId} className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex h-11 min-w-0 overflow-hidden rounded-md border border-input bg-background">
        <input
          id={priceId}
          inputMode="decimal"
          value={priceDraft ?? formatBoundPrice(price)}
          onChange={event => setPriceDraft(event.target.value)}
          onFocus={event => event.target.select()}
          onBlur={event => {
            if (event.target.value.trim() === formatBoundPrice(price)) {
              setPriceDraft(null);
              return;
            }
            commitPrice(event.target.value);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 bg-transparent px-1.5 text-xs font-semibold tabular-nums outline-none sm:px-2 sm:text-sm"
        />
        <input
          id={pctId}
          aria-label={`${label} percent from current price`}
          inputMode="decimal"
          value={pctDraft ?? formatPct(pct)}
          onChange={event => setPctDraft(event.target.value)}
          onFocus={event => event.target.select()}
          onBlur={event => {
            const raw = event.target.value.trim();
            if (raw === formatPct(pct) || raw === formatPct(pct).replace('%', '')) {
              setPctDraft(null);
              return;
            }
            commitPct(event.target.value);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
          className="w-14 shrink-0 border-l border-input bg-transparent px-1 text-[11px] tabular-nums text-muted-foreground outline-none sm:w-[4.25rem] sm:px-1.5 sm:text-xs"
        />
        <div className="flex w-7 shrink-0 flex-col border-l border-input">
          <button
            type="button"
            aria-label={`Increase ${label}`}
            disabled={!canStepUp}
            onClick={() => onStep(1)}
            className="flex h-1/2 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            disabled={!canStepDown}
            onClick={() => onStep(-1)}
            className="flex h-1/2 items-center justify-center border-t border-input text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Minus className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
