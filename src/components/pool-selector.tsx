'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Search, Loader2 } from 'lucide-react';
import {
  MeteoraPair,
  LoadingStatus,
  fetchAllPairs,
  filterPairs,
  formatUSD
} from '@/lib/meteora-api';

interface PoolSelectorProps {
  onSelectPool: (pool: MeteoraPair) => void;
  selectedPool?: MeteoraPair | null;
}

export function PoolSelector({ onSelectPool, selectedPool }: PoolSelectorProps) {
  const [allPairs, setAllPairs] = useState<MeteoraPair[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [loadingStatus, setLoadingStatus] = useState<LoadingStatus>({
    isLoading: true,
    pairsLoaded: 0,
    currentPage: 0
  });

  const handlePoolSelect = (pool: MeteoraPair) => {
    onSelectPool(pool);
    // Clear search after selection
    setSearchTerm('');
  };

  // Debounce search term
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [searchTerm]);

  // Load pairs on mount
  useEffect(() => {
    let mounted = true;

    async function loadPairs() {
      try {
        const pairs: MeteoraPair[] = [];
        const seenAddresses = new Set<string>();

        for await (const batch of fetchAllPairs()) {
          if (!mounted) break;

          // Deduplicate pairs by address
          for (const pair of batch.pairs) {
            if (!seenAddresses.has(pair.address)) {
              seenAddresses.add(pair.address);
              pairs.push(pair);
            }
          }

          setAllPairs([...pairs]);
          setLoadingStatus({
            isLoading: batch.shouldContinue,
            pairsLoaded: pairs.length,
            currentPage: batch.page
          });

          // Stop if we shouldn't continue
          if (!batch.shouldContinue) {
            break;
          }
        }
      } catch (error) {
        if (mounted) {
          setLoadingStatus(prev => ({
            ...prev,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to load pairs'
          }));
        }
      }
    }

    loadPairs();

    return () => {
      mounted = false;
    };
  }, []);

  // Filter pairs based on debounced search term
  const filteredPairs = useMemo(() => {
    // Only show results if user has typed something
    if (!debouncedSearchTerm || debouncedSearchTerm.trim() === '') {
      return [];
    }
    return filterPairs(allPairs, debouncedSearchTerm);
  }, [allPairs, debouncedSearchTerm]);

  return (
    <div className="space-y-4">
      {/* Error display */}
      {loadingStatus.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {loadingStatus.error}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search by token symbol, mint address, or pool address..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Results section - only show when user has typed something */}
      {searchTerm && (
        <>
          {/* Results count */}
          {debouncedSearchTerm && filteredPairs.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                Found {filteredPairs.length} matching {filteredPairs.length === 1 ? 'pool' : 'pools'}.
              </span>
              {loadingStatus.isLoading && (
                <>
                  <span>Searching for more...</span>
                  <Loader2 className="h-3 w-3 animate-spin" />
                </>
              )}
            </div>
          )}

          {/* Pool list */}
          <div className="max-h-[400px] space-y-2 overflow-y-auto rounded-lg border p-2">
            {/* No results - still loading */}
            {filteredPairs.length === 0 && debouncedSearchTerm && loadingStatus.isLoading && (
              <div className="py-8 text-center">
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Searching for pools...</span>
                </div>
              </div>
            )}

            {/* No results - loading complete */}
            {filteredPairs.length === 0 && debouncedSearchTerm && !loadingStatus.isLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No matching pools found
              </div>
            )}

            {/* Debouncing in progress */}
            {filteredPairs.length === 0 && !debouncedSearchTerm && searchTerm && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Searching...
              </div>
            )}

            {filteredPairs.map((pair) => {
              const isSelected = selectedPool?.address === pair.address;

              return (
                <button
                  key={pair.address}
                  onClick={() => handlePoolSelect(pair)}
                  className={`w-full rounded-md border p-2 text-left transition-colors hover:bg-accent ${
                    isSelected ? 'border-primary bg-primary/5' : ''
                  }`}
                >
                  <div className="space-y-1">
                    <div className="font-semibold text-sm">{pair.name}</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>Bin: {pair.bin_step}</span>
                      <span>TVL: {formatUSD(pair.liquidity)}</span>
                      <span>30m: {formatUSD(pair.volume.min_30 || 0)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
