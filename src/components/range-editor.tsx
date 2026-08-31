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
import { ResetToInitialButton } from '@/components/reset-to-initial-button';

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
  onInitialPriceChange?: (price: number) => void;
  defaultInitialPrice?: number | null;
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
  return `${pct < 0 ? '-' : ''}${body}%`;
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
  onInitialPriceChange,
  defaultInitialPrice = null,
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
        onInitialPriceChange={onInitialPriceChange}
        defaultInitialPrice={defaultInitialPrice}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-2">
        <PriceBoundField
          label="Min Price"
          price={bounds?.min.price ?? minPrice}
          currentPrice={currentPrice}
          onPriceChange={setMinPrice}
          onStep={stepMin}
          canStepDown={bounds ? bounds.bins < MAX_POSITION_BINS : false}
          canStepUp={bounds ? bounds.bins > 1 : false}
        />
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

      <div className="text-xs text-muted-foreground">
        Total Bins:{' '}
        <span className="font-semibold text-foreground">{bounds?.bins ?? '—'}</span>
      </div>
    </div>
  );
}

function viewWindow(minBinId: number, maxBinId: number, activeId: number | null, draggingPrice: boolean) {
  const width = Math.max(1, maxBinId - minBinId + 1);
  const pad = Math.max(6, Math.ceil(width * 0.12));
  let viewMin = minBinId - pad;
  let viewMax = maxBinId + pad;
  const extra = draggingPrice ? Math.max(10, pad) : Math.max(3, Math.ceil(pad / 2));
  if (activeId != null && Number.isFinite(activeId)) {
    if (activeId - extra < viewMin) viewMin = activeId - extra;
    if (activeId + extra > viewMax) viewMax = activeId + extra;
  }
  return { viewMin, viewMax };
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
  onInitialPriceChange,
  defaultInitialPrice = null,
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
  onInitialPriceChange?: (price: number) => void;
  defaultInitialPrice?: number | null;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    edge: 'min' | 'max' | 'price';
    startX: number;
    startId: number;
    pxPerBin: number;
  } | null>(null);
  const [dragging, setDragging] = useState<'min' | 'max' | 'price' | null>(null);

  const hasAmounts = baseAmount > DUST || quoteAmount > DUST;
  const priceEditable = typeof onInitialPriceChange === 'function';

  const activeId = enabled && binStep > 0 && currentPrice > 0
    ? getIdFromPrice(currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : null;

  const { viewMin, viewMax } = useMemo(
    () => viewWindow(minBinId, maxBinId, activeId, dragging === 'price'),
    [minBinId, maxBinId, activeId, dragging]
  );
  const viewSpan = Math.max(1, viewMax - viewMin);
  const idToPct = (id: number) => ((id - viewMin) / viewSpan) * 100;

  const bins = useMemo(() => {
    if (!enabled || !hasAmounts || !(binStep > 0) || !(currentPrice > 0) || maxBinId < minBinId) return [];
    const resolvedActive = activeId ?? minBinId;
    return getInitialBinsForBinRange({
      binStep,
      minBinId,
      maxBinId,
      activeBinId: resolvedActive,
      baseAmount,
      quoteAmount,
      strategy,
      baseDecimals,
      quoteDecimals,
      applyDecimalAdjustment,
    });
  }, [
    activeId,
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

  const binById = useMemo(() => {
    const map = new Map<number, (typeof bins)[number]>();
    for (const bin of bins) map.set(bin.id, bin);
    return map;
  }, [bins]);

  const maxValue = useMemo(() => {
    if (bins.length === 0) return 1;
    return Math.max(...bins.map(bin => binInitialDisplayValue(bin)), 0) || 1;
  }, [bins]);

  const viewIds = useMemo(() => {
    if (!enabled || viewMax < viewMin) return [];
    const ids: number[] = [];
    for (let id = viewMin; id <= viewMax; id++) ids.push(id);
    return ids;
  }, [enabled, viewMin, viewMax]);

  const ticks = useMemo(() => {
    if (!enabled || !(binStep > 0) || viewMax < viewMin) return [];
    return [0, 0.5, 1].map(t => {
      const id = Math.round(viewMin + t * viewSpan);
      return {
        price: getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
        position: t * 100,
      };
    });
  }, [applyDecimalAdjustment, baseDecimals, binStep, enabled, quoteDecimals, viewMin, viewMax, viewSpan]);

  const minBoundPrice = enabled && binStep > 0
    ? getPriceFromId(minBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : 0;
  const maxBoundPrice = enabled && binStep > 0
    ? getPriceFromId(maxBinId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : 0;
  const activePrice = activeId != null && binStep > 0
    ? getPriceFromId(activeId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : currentPrice;

  const outsideHint = activeId == null
    ? null
    : activeId < minBinId
      ? 'Below range · all base'
      : activeId > maxBinId
        ? 'Above range · all quote'
        : null;

  const clientXToId = useCallback((clientX: number, target: HTMLElement | null) => {
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    const raw = viewMin + ((clientX - rect.left) / rect.width) * viewSpan;
    const width = Math.max(1, maxBinId - minBinId + 1);
    const limit = width * 6;
    return Math.round(Math.max(minBinId - limit, Math.min(maxBinId + limit, raw)));
  }, [maxBinId, minBinId, viewMin, viewSpan]);

  const applyDrag = useCallback((clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.edge === 'price') {
      const id = clientXToId(clientX, previewRef.current);
      if (id != null && onInitialPriceChange && binStep > 0) {
        onInitialPriceChange(getPriceFromId(id, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment));
      }
      return;
    }
    if (!(drag.pxPerBin > 0)) return;
    const deltaBins = Math.round((clientX - drag.startX) / drag.pxPerBin);
    const nextId = drag.startId + deltaBins;
    if (drag.edge === 'min') onDragMin(nextId);
    else onDragMax(nextId);
  }, [applyDecimalAdjustment, baseDecimals, binStep, clientXToId, onDragMax, onDragMin, onInitialPriceChange, quoteDecimals]);

  const startRangeDrag = (edge: 'min' | 'max', event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || !chartRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = chartRef.current.getBoundingClientRect();
    dragRef.current = {
      edge,
      startX: event.clientX,
      startId: edge === 'min' ? minBinId : maxBinId,
      pxPerBin: rect.width / viewSpan,
    };
    setDragging(edge);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startPriceDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || !priceEditable || !onInitialPriceChange) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      edge: 'price',
      startX: event.clientX,
      startId: activeId ?? minBinId,
      pxPerBin: 0,
    };
    setDragging('price');
    event.currentTarget.setPointerCapture(event.pointerId);
    applyDrag(event.clientX);
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

  const minPct = idToPct(minBinId);
  const maxPct = idToPct(maxBinId);
  const pricePct = activeId != null ? Math.max(0, Math.min(100, idToPct(activeId))) : 50;
  const columnGap = viewIds.length > 80 ? '' : 'gap-px';

  const canResetInitial = Boolean(
    priceEditable
    && defaultInitialPrice
    && defaultInitialPrice > 0
    && Math.abs(activePrice - defaultInitialPrice) > 1e-9
  );

  return (
    <div className="space-y-1 px-2.5">
      <div className="relative">
        <div
          ref={previewRef}
          className={`relative h-20 select-none ${priceEditable ? 'cursor-ew-resize' : ''}`}
          style={{ touchAction: 'none' }}
          onPointerDown={priceEditable ? startPriceDrag : undefined}
          onPointerMove={event => dragging === 'price' && applyDrag(event.clientX)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className={`flex h-full items-end ${columnGap}`}>
            {viewIds.map(id => {
              const inRange = id >= minBinId && id <= maxBinId;
              const bin = binById.get(id);
              const value = bin ? binInitialDisplayValue(bin) : 0;
              const hasValue = value > DUST;
              const height = hasValue
                ? Math.max((value / maxValue) * 100, 4)
                : inRange
                  ? 6
                  : 2;
              const color = bin
                ? (bin.initialTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)')
                : 'var(--color-quote)';
              return (
                <div
                  key={id}
                  className="min-w-0 flex-1 rounded-t-[1px]"
                  style={{
                    height: `${height}%`,
                    backgroundColor: inRange ? color : 'transparent',
                    opacity: hasValue ? 0.95 : inRange ? 0.2 : 0,
                    boxShadow: inRange && !hasValue ? 'inset 0 -1px 0 hsl(var(--border) / 0.7)' : undefined,
                  }}
                />
              );
            })}
          </div>

          {priceEditable && activeId != null && (
            <div
              role="slider"
              tabIndex={0}
              aria-label="Initial price"
              aria-valuenow={activePrice}
              aria-valuetext={formatBoundPrice(activePrice)}
              className="absolute top-0 bottom-0 z-20 w-7 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${pricePct}%`, touchAction: 'none' }}
              onKeyDown={event => {
                if (activeId == null || !onInitialPriceChange) return;
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  onInitialPriceChange(getPriceFromId(activeId - 1, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment));
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  onInitialPriceChange(getPriceFromId(activeId + 1, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment));
                }
              }}
            >
              <div
                className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-gradient-to-b from-primary/80 to-primary/40 border-foreground/80 border-dashed border-l"
                style={{ boxShadow: '0 0 8px rgba(66, 153, 225, 0.45)' }}
              />
              <div
                className="absolute bottom-0 left-1/2 h-2 w-5 -translate-x-1/2 rounded-t-sm bg-primary"
                style={{ boxShadow: '0 0 8px rgba(66, 153, 225, 0.45)' }}
              />
            </div>
          )}
        </div>
      </div>

      <div
        ref={chartRef}
        className="relative h-5 select-none"
        style={{ touchAction: 'none' }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-border" />
        <div
          className="pointer-events-none absolute top-1/2 h-0.5 -translate-y-1/2 bg-primary/80"
          style={{ left: `${minPct}%`, width: `${Math.max(0, maxPct - minPct)}%` }}
        />
        <Handle
          edge="min"
          leftPct={minPct}
          dragging={dragging === 'min'}
          onPointerDown={event => startRangeDrag('min', event)}
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
          leftPct={maxPct}
          dragging={dragging === 'max'}
          onPointerDown={event => startRangeDrag('max', event)}
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
      {priceEditable && (
        <div className={canResetInitial ? 'relative h-[4.25rem]' : 'relative h-10'}>
          <div
            className="absolute top-0 -translate-x-1/2 flex flex-col items-center text-center"
            style={{ left: `${pricePct}%` }}
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
              Initial Price
            </div>
            <div className="text-[11px] font-bold tabular-nums text-primary leading-tight whitespace-nowrap">
              {formatBoundPrice(activePrice, true)}
            </div>
            {outsideHint && (
              <div className="text-[9px] text-muted-foreground leading-tight whitespace-nowrap">{outsideHint}</div>
            )}
            {canResetInitial && defaultInitialPrice && onInitialPriceChange && (
              <ResetToInitialButton onClick={() => onInitialPriceChange(defaultInitialPrice)} />
            )}
          </div>
        </div>
      )}
      {priceEditable && (
        <p className="text-[10px] text-muted-foreground">
          Drag the vertical bar to set the initial simulation price. Move it outside the min/max handles for a one-sided position.
        </p>
      )}
    </div>
  );
}

function Handle({
  edge,
  leftPct,
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
  leftPct: number;
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
      style={{ left: `${leftPct}%`, touchAction: 'none' }}
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
      <div className="flex h-14 min-w-0 overflow-hidden rounded-lg border border-input bg-background lg:h-11 lg:rounded-md">
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
          className="min-w-0 flex-1 bg-transparent px-3 text-lg font-semibold tabular-nums outline-none lg:px-2 lg:text-sm"
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
          className="w-[5.25rem] shrink-0 border-l border-input bg-transparent px-2 text-right text-sm tabular-nums text-muted-foreground outline-none lg:w-[4.25rem] lg:px-1.5 lg:text-xs"
        />
        <div className="flex w-10 shrink-0 flex-col border-l border-input lg:w-7">
          <button
            type="button"
            aria-label={`Increase ${label}`}
            disabled={!canStepUp}
            onClick={() => onStep(1)}
            className="flex h-1/2 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-4 w-4 lg:h-3 lg:w-3" />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            disabled={!canStepDown}
            onClick={() => onStep(-1)}
            className="flex h-1/2 items-center justify-center border-t border-input text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Minus className="h-4 w-4 lg:h-3 lg:w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
