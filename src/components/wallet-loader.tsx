'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  Search,
  Wallet,
  AlertCircle,
} from 'lucide-react';
import { formatUSD } from '@/lib/meteora-api';
import {
  fetchOpenPortfolio,
  isValidSolanaAddress,
  shortenAddress,
  type OpenPortfolio,
  type PairGroup,
  type WalletPoolSummary,
} from '@/lib/wallet-positions';

type DrillLevel = 'pairs' | 'pools';

interface WalletLoaderProps {
  onSelectPool: (payload: { wallet: string; pair: PairGroup; pool: WalletPoolSummary }) => void;
  selectedPoolAddress?: string | null;
  initialWallet?: string | null;
  initialPoolAddress?: string | null;
  disabled?: boolean;
}

function formatPct(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return '0.00%';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function pnlClass(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-muted-foreground';
  return value > 0 ? 'text-green-400' : 'text-red-400';
}

function TokenPairIcons({
  tokenX,
  tokenY,
  iconX,
  iconY,
}: {
  tokenX: string;
  tokenY: string;
  iconX?: string;
  iconY?: string;
}) {
  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {iconX ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={iconX} alt={tokenX} className="h-7 w-7 rounded-full border border-background bg-secondary object-cover" />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-background bg-primary/20 text-[10px] font-semibold text-primary">
            {tokenX.slice(0, 2)}
          </div>
        )}
        {iconY ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={iconY} alt={tokenY} className="h-7 w-7 rounded-full border border-background bg-secondary object-cover" />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-background bg-teal-500/20 text-[10px] font-semibold text-teal-400">
            {tokenY.slice(0, 2)}
          </div>
        )}
      </div>
    </div>
  );
}

export function WalletLoader({
  onSelectPool,
  selectedPoolAddress,
  initialWallet,
  initialPoolAddress,
  disabled,
}: WalletLoaderProps) {
  const [walletInput, setWalletInput] = useState(initialWallet ?? '');
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<OpenPortfolio | null>(null);
  const [level, setLevel] = useState<DrillLevel>('pairs');
  const [selectedPair, setSelectedPair] = useState<PairGroup | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialWallet && initialWallet !== loadedWallet && isValidSolanaAddress(initialWallet)) {
      setWalletInput(initialWallet);
      void handleLoad(initialWallet);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWallet]);

  const handleLoad = async (overrideWallet?: string) => {
    const wallet = (overrideWallet ?? walletInput).trim();
    if (!isValidSolanaAddress(wallet)) {
      setError('Enter a valid Solana wallet address.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSelectedPair(null);
    setLevel('pairs');

    try {
      const result = await fetchOpenPortfolio(wallet);
      setPortfolio(result);
      setLoadedWallet(wallet);
      if (result.pairs.length === 0) {
        setError('No open DLMM positions found for this wallet.');
      } else if (initialPoolAddress) {
        for (const pair of result.pairs) {
          const match = pair.pools.find(pool => pool.poolAddress === initialPoolAddress);
          if (match) {
            setSelectedPair(pair);
            setLevel('pools');
            onSelectPool({ wallet, pair, pool: match });
            break;
          }
        }
      }
    } catch (err) {
      setPortfolio(null);
      setLoadedWallet(null);
      setError(err instanceof Error ? err.message : 'Failed to load wallet positions.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectPair = (pair: PairGroup) => {
    setSelectedPair(pair);
    if (pair.pools.length === 1) {
      onSelectPool({
        wallet: loadedWallet ?? walletInput,
        pair,
        pool: pair.pools[0],
      });
      return;
    }
    setLevel('pools');
  };

  const handleBack = () => {
    setLevel('pairs');
    setSelectedPair(null);
  };

  return (
    <div className="space-y-4">
      <form
        className="flex w-full max-w-2xl flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void handleLoad();
        }}
      >
        <div className="relative flex-1">
          <Wallet className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={walletInput}
            onChange={(event) => setWalletInput(event.target.value.trim())}
            placeholder="Solana wallet address"
            className="pl-10 font-mono text-sm"
            disabled={isLoading || disabled}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" disabled={isLoading || disabled || !walletInput} className="shrink-0">
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
          Load
        </Button>
      </form>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading open positions…
          </div>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && portfolio && portfolio.pairs.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {shortenAddress(portfolio.wallet, 6)} · {portfolio.totalPositions} open {portfolio.totalPositions === 1 ? 'position' : 'positions'}
            </span>
            <span>
              {formatUSD(portfolio.totalBalancesUsd)}
              <span className={`ml-2 ${pnlClass(portfolio.totalPnlUsd)}`}>
                {portfolio.totalPnlUsd >= 0 ? '+' : ''}
                {formatUSD(portfolio.totalPnlUsd)}
              </span>
            </span>
          </div>

          {level === 'pools' && selectedPair && (
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              All pairs
            </button>
          )}

          {level === 'pairs' && (
            <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border p-2">
              {portfolio.pairs.map((pair) => {
                const isActive = pair.pools.some(pool => pool.poolAddress === selectedPoolAddress);
                return (
                <button
                  key={pair.pairKey}
                  type="button"
                  onClick={() => handleSelectPair(pair)}
                  className={`flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent ${
                    isActive ? 'border-primary bg-primary/5' : ''
                  }`}
                >
                  <TokenPairIcons
                    tokenX={pair.tokenX}
                    tokenY={pair.tokenY}
                    iconX={pair.tokenXIcon}
                    iconY={pair.tokenYIcon}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{pair.pairKey}</span>
                      <span className="text-sm font-medium">{formatUSD(pair.balancesUsd)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {pair.poolCount} {pair.poolCount === 1 ? 'pool' : 'pools'}
                      </span>
                      <span>
                        {pair.positionCount} {pair.positionCount === 1 ? 'position' : 'positions'}
                      </span>
                      <span className={pnlClass(pair.pnlUsd)}>
                        PnL {pair.pnlUsd >= 0 ? '+' : ''}
                        {formatUSD(pair.pnlUsd)}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
                );
              })}
            </div>
          )}

          {level === 'pools' && selectedPair && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <TokenPairIcons
                  tokenX={selectedPair.tokenX}
                  tokenY={selectedPair.tokenY}
                  iconX={selectedPair.tokenXIcon}
                  iconY={selectedPair.tokenYIcon}
                />
                <div>
                  <div className="font-semibold">{selectedPair.pairKey}</div>
                  <div className="text-xs text-muted-foreground">
                    Select a pool to simulate all of its positions together
                  </div>
                </div>
              </div>
              <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border p-2">
                {selectedPair.pools.map((pool) => {
                  const isSelected = selectedPoolAddress === pool.poolAddress;
                  return (
                    <button
                      key={pool.poolAddress}
                      type="button"
                      onClick={() => onSelectPool({ wallet: loadedWallet ?? walletInput, pair: selectedPair, pool })}
                      className={`w-full rounded-md border p-3 text-left transition-colors hover:bg-accent ${
                        isSelected ? 'border-primary bg-primary/5' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-sm">Bin step {pool.binStep}</span>
                            <Badge variant="outline" className="font-normal">
                              {pool.baseFee}% fee
                            </Badge>
                            {pool.outOfRange ? (
                              <Badge variant="destructive">Out of range</Badge>
                            ) : (
                              <Badge variant="secondary">In range</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {pool.openPositionCount} {pool.openPositionCount === 1 ? 'position' : 'positions'}
                            </span>
                            <span>Price {pool.poolPrice > 0 ? pool.poolPrice.toPrecision(6) : '—'}</span>
                            <span className="font-mono">{shortenAddress(pool.poolAddress, 4)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium">{formatUSD(pool.balancesUsd)}</div>
                          <div className={`text-xs ${pnlClass(pool.pnlUsd)}`}>
                            {pool.pnlUsd >= 0 ? '+' : ''}
                            {formatUSD(pool.pnlUsd)} ({formatPct(pool.pnlPctChange)})
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
