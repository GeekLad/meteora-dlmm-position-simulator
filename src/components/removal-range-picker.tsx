'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { formatNumberForDisplay } from '@/lib/display-formatting';
import {
  binCurrentDisplayValue,
  getIdFromPrice,
  getPriceFromId,
  type SimulatedBin,
} from '@/lib/dlmm';
import { cn } from '@/lib/utils';

const DUST = 1e-12;

interface RemovalRangePickerProps {
  bins: SimulatedBin[];
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  tokenSymbols: { base: string; quote: string };
  tokenIcons?: { base?: string; quote?: string };
  removePct: number;
  onRangeChange: (minPrice: number, maxPrice: number) => void;
  onRemovePctChange: (pct: number) => void;
}

function rangeForToken(
  bins: SimulatedBin[],
  tokenType: 'base' | 'quote'
): { minId: number; maxId: number } | null {
  let minId = Infinity;
  let maxId = -Infinity;
  for (const bin of bins) {
    if (bin.currentTokenType === tokenType && bin.currentAmount > DUST) {
      if (bin.id < minId) minId = bin.id;
      if (bin.id > maxId) maxId = bin.id;
    }
  }
  if (!Number.isFinite(minId) || maxId < minId) return null;
  return { minId, maxId };
}

function formatBoundPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return '';
  if (price >= 1) {
    return price.toLocaleString('en-US', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
  }
  return formatNumberForDisplay(price, { maximumFractionDigits: 4, minimumFractionDigits: 2 });
}

function binStartPct(id: number, spanMin: number, count: number): number {
  return ((id - spanMin) / count) * 100;
}

function binEndPct(id: number, spanMin: number, count: number): number {
  return ((id - spanMin + 1) / count) * 100;
}

function clientXToBinId(clientX: number, rect: DOMRect, spanMin: number, spanMax: number): number {
  const count = Math.max(1, spanMax - spanMin + 1);
  const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
  const index = Math.min(count - 1, Math.max(0, Math.floor(t * count)));
  return spanMin + index;
}

export function RemovalRangePicker({
  bins,
  minPrice,
  maxPrice,
  currentPrice,
  binStep,
  baseDecimals,
  quoteDecimals,
  applyDecimalAdjustment,
  tokenSymbols,
  tokenIcons,
  removePct,
  onRangeChange,
  onRemovePctChange,
}: RemovalRangePickerProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: 'min' | 'max' | 'span';
    startX: number;
    startMin: number;
    startMax: number;
    pxPerBin: number;
  } | null>(null);
  const [dragging, setDragging] = useState<'min' | 'max' | 'span' | null>(null);

  const span = useMemo(() => {
    if (!bins.length) return null;
    return { minId: bins[0].id, maxId: bins[bins.length - 1].id };
  }, [bins]);

  const selected = useMemo(() => {
    if (!span || !(binStep > 0)) return null;
    const rawMin = minPrice > 0
      ? getIdFromPrice(minPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
      : span.minId;
    const rawMax = maxPrice > 0
      ? getIdFromPrice(maxPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
      : span.maxId;
    const minId = Math.min(span.maxId, Math.max(span.minId, Math.min(rawMin, rawMax)));
    const maxId = Math.min(span.maxId, Math.max(span.minId, Math.max(rawMin, rawMax)));
    return { minId, maxId };
  }, [applyDecimalAdjustment, baseDecimals, binStep, maxPrice, minPrice, quoteDecimals, span]);

  const maxValue = useMemo(() => {
    if (bins.length === 0) return 1;
    return Math.max(...bins.map(bin => binCurrentDisplayValue(bin)), 0) || 1;
  }, [bins]);

  const hasBase = bins.some(bin => bin.currentTokenType === 'base' && bin.currentAmount > DUST);
  const hasQuote = bins.some(bin => bin.currentTokenType === 'quote' && bin.currentAmount > DUST);
  const quoteRange = useMemo(() => rangeForToken(bins, 'quote'), [bins]);
  const baseRange = useMemo(() => rangeForToken(bins, 'base'), [bins]);

  const commitRange = useCallback((minId: number, maxId: number) => {
    if (!span || !(binStep > 0)) return;
    let nextMin = Math.min(maxId, Math.max(span.minId, minId));
    let nextMax = Math.max(minId, Math.min(span.maxId, maxId));
    if (nextMin > nextMax) nextMax = nextMin;
    if (selected && nextMin === selected.minId && nextMax === selected.maxId) return;
    onRangeChange(
      getPriceFromId(nextMin, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment),
      getPriceFromId(nextMax, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    );
  }, [applyDecimalAdjustment, baseDecimals, binStep, onRangeChange, quoteDecimals, selected, span]);

  const applyDrag = useCallback((clientX: number) => {
    const drag = dragRef.current;
    const rect = chartRef.current?.getBoundingClientRect();
    if (!drag || !span || !rect) return;
    if (drag.mode === 'span') {
      if (!(drag.pxPerBin > 0)) return;
      const width = drag.startMax - drag.startMin;
      const delta = Math.round((clientX - drag.startX) / drag.pxPerBin);
      let nextMin = drag.startMin + delta;
      let nextMax = nextMin + width;
      if (nextMin < span.minId) {
        nextMin = span.minId;
        nextMax = nextMin + width;
      }
      if (nextMax > span.maxId) {
        nextMax = span.maxId;
        nextMin = nextMax - width;
      }
      commitRange(nextMin, nextMax);
      return;
    }
    const id = clientXToBinId(clientX, rect, span.minId, span.maxId);
    if (drag.mode === 'min') commitRange(Math.min(id, drag.startMax), drag.startMax);
    else commitRange(drag.startMin, Math.max(id, drag.startMin));
  }, [commitRange, span]);

  const startDrag = (mode: 'min' | 'max' | 'span', event: React.PointerEvent<HTMLElement>) => {
    if (!span || !chartRef.current || !selected) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = chartRef.current.getBoundingClientRect();
    const count = Math.max(1, span.maxId - span.minId + 1);
    dragRef.current = {
      mode,
      startX: event.clientX,
      startMin: selected.minId,
      startMax: selected.maxId,
      pxPerBin: rect.width / count,
    };
    setDragging(mode);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
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

  if (!span || !selected || bins.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/60 text-xs text-muted-foreground">
        No liquidity in this position to remove.
      </div>
    );
  }

  const count = span.maxId - span.minId + 1;
  const minPct = binStartPct(selected.minId, span.minId, count);
  const maxPct = binEndPct(selected.maxId, span.minId, count);
  const minBoundPrice = getPriceFromId(selected.minId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const maxBoundPrice = getPriceFromId(selected.maxId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment);
  const activeBinId = currentPrice > 0
    ? getIdFromPrice(currentPrice, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)
    : null;
  const showPoolPrice = activeBinId != null && activeBinId >= span.minId && activeBinId <= span.maxId;
  const poolPricePct = activeBinId != null && showPoolPrice
    ? (binStartPct(activeBinId, span.minId, count) + binEndPct(activeBinId, span.minId, count)) / 2
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          {hasBase && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-base)' }} />
              {tokenSymbols.base}
            </span>
          )}
          {hasQuote && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-quote)' }} />
              {tokenSymbols.quote}
            </span>
          )}
          {!hasBase && !hasQuote && <span>Empty bins</span>}
        </div>
        <span className="text-right tabular-nums">
          {showPoolPrice ? (
            <>
              Pool Price{' '}
              <span className="text-foreground">{formatBoundPrice(currentPrice)}</span>
              <span className="ml-1 opacity-70">{tokenSymbols.quote}/{tokenSymbols.base}</span>
            </>
          ) : (
            <>{tokenSymbols.quote}/{tokenSymbols.base}</>
          )}
        </span>
      </div>

      <div className="relative space-y-1 px-2.5">
        <div className="relative h-20">
          <div className={`relative flex h-full items-end ${count > 80 ? '' : 'gap-px'}`}>
            {bins.map(bin => {
              const value = binCurrentDisplayValue(bin);
              const inRange = bin.id >= selected.minId && bin.id <= selected.maxId;
              const height = value > DUST ? Math.max((value / maxValue) * 100, 6) : 0;
              const color = bin.currentTokenType === 'base' ? 'var(--color-base)' : 'var(--color-quote)';
              const removedShare = inRange ? Math.min(100, Math.max(0, removePct)) : 0;
              const remainShare = 100 - removedShare;
              return (
                <div
                  key={bin.id}
                  className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-t-[1px]"
                  style={{ height: `${height}%` }}
                >
                  {removedShare > 0 && (
                    <div
                      className="w-full"
                      style={{ height: `${removedShare}%`, backgroundColor: color }}
                    />
                  )}
                  {remainShare > 0 && (
                    <div
                      className="w-full bg-muted-foreground/35"
                      style={{ height: `${remainShare}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {showPoolPrice && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-[1] w-px bg-foreground/80"
              style={{ left: `${poolPricePct}%` }}
              title={`Pool price ${formatBoundPrice(currentPrice)}`}
            />
          )}
        </div>

        <div
          ref={chartRef}
          className="relative h-5 select-none"
          style={{ touchAction: 'none' }}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-border" />
          <div
            className={`absolute top-1/2 h-5 -translate-y-1/2 ${dragging === 'span' ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{
              left: `${minPct}%`,
              width: `${Math.max(maxPct - minPct, 1)}%`,
              touchAction: 'none',
            }}
            onPointerDown={event => startDrag('span', event)}
            onPointerMove={event => applyDrag(event.clientX)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/80" />
          </div>
          <Handle
            edge="min"
            position={minPct}
            dragging={dragging === 'min'}
            onPointerDown={event => startDrag('min', event)}
            onPointerMove={event => applyDrag(event.clientX)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); commitRange(selected.minId - 1, selected.maxId); }
              if (event.key === 'ArrowRight') { event.preventDefault(); commitRange(selected.minId + 1, selected.maxId); }
            }}
            ariaValue={minBoundPrice}
            ariaMin={getPriceFromId(span.minId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)}
            ariaMax={maxBoundPrice}
          />
          <Handle
            edge="max"
            position={maxPct}
            dragging={dragging === 'max'}
            onPointerDown={event => startDrag('max', event)}
            onPointerMove={event => applyDrag(event.clientX)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); commitRange(selected.minId, selected.maxId - 1); }
              if (event.key === 'ArrowRight') { event.preventDefault(); commitRange(selected.minId, selected.maxId + 1); }
            }}
            ariaValue={maxBoundPrice}
            ariaMin={minBoundPrice}
            ariaMax={getPriceFromId(span.maxId, binStep, baseDecimals, quoteDecimals, applyDecimalAdjustment)}
          />
        </div>

        <div className="relative h-4">
          <div
            className="absolute text-[10px] tabular-nums text-muted-foreground"
            style={{ left: `${minPct}%`, transform: minPct < 8 ? 'translateX(0)' : 'translateX(-50%)' }}
          >
            {formatBoundPrice(minBoundPrice)}
          </div>
          {selected.maxId !== selected.minId && (
            <div
              className="absolute text-[10px] tabular-nums text-muted-foreground"
              style={{
                left: `${maxPct}%`,
                transform: maxPct > 92 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {formatBoundPrice(maxBoundPrice)}
            </div>
          )}
          {showPoolPrice && Math.abs(poolPricePct - maxPct) > 8 && Math.abs(poolPricePct - minPct) > 8 && (
            <div
              className="absolute text-[10px] tabular-nums text-muted-foreground"
              style={{
                left: `${poolPricePct}%`,
                transform: poolPricePct > 92 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {formatBoundPrice(currentPrice)}
            </div>
          )}
        </div>
      </div>

      {(hasQuote || hasBase) && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Remove only</span>
          <div className={cn('grid gap-2', hasQuote && hasBase ? 'grid-cols-2' : 'grid-cols-1')}>
            {hasQuote && quoteRange && (
              <TokenOnlyButton
                symbol={tokenSymbols.quote}
                iconSrc={tokenIcons?.quote}
                color="var(--color-quote)"
                selected={selected.minId === quoteRange.minId && selected.maxId === quoteRange.maxId}
                onClick={() => commitRange(quoteRange.minId, quoteRange.maxId)}
              />
            )}
            {hasBase && baseRange && (
              <TokenOnlyButton
                symbol={tokenSymbols.base}
                iconSrc={tokenIcons?.base}
                color="var(--color-base)"
                selected={selected.minId === baseRange.minId && selected.maxId === baseRange.maxId}
                onClick={() => commitRange(baseRange.minId, baseRange.maxId)}
              />
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Select Bin Range</span>
        <div className="flex gap-1">
          {[50, 100].map(pct => (
            <button
              key={pct}
              type="button"
              onClick={() => onRemovePctChange(pct)}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors',
                removePct === pct
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              )}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TokenGlyph({
  src,
  symbol,
  color,
}: {
  src?: string;
  symbol: string;
  color: string;
}) {
  const [failed, setFailed] = useState(false);
  const letters = symbol.slice(0, 2).toUpperCase();
  if (!src || failed) {
    return (
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-background"
        style={{ backgroundColor: color }}
        aria-hidden
      >
        {letters}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className="h-5 w-5 shrink-0 rounded-full border border-background/40 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function TokenOnlyButton({
  symbol,
  iconSrc,
  color,
  selected,
  onClick,
}: {
  symbol: string;
  iconSrc?: string;
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`Select all ${symbol} bins`}
      className={cn(
        'inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
        selected
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-foreground hover:bg-secondary/80'
      )}
    >
      <TokenGlyph src={iconSrc} symbol={symbol} color={color} />
      <span className="truncate">{symbol}</span>
    </button>
  );
}

function Handle({
  edge,
  position,
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
  position: number;
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
      aria-label={edge === 'min' ? 'Minimum bin' : 'Maximum bin'}
      aria-valuemin={ariaMin}
      aria-valuemax={Number.isFinite(ariaMax) ? ariaMax : undefined}
      aria-valuenow={ariaValue}
      aria-valuetext={formatBoundPrice(ariaValue)}
      className="absolute top-1/2 z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
      style={{ left: `${position}%`, touchAction: 'none' }}
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
