/**
 * Meteora DLMM API Service
 * Fetches and manages DLMM pool data from the Meteora API
 */

const METEORA_API_BASE = 'https://dlmm-api.meteora.ag';
const PAIRS_ENDPOINT = '/pair/all_with_pagination';
const PAGE_SIZE = 100;

export interface MeteoraToken {
  mint: string;
  symbol: string;
}

export interface MeteoraPair {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  bin_step: number;
  current_price: number;
  liquidity: string;
  trade_volume_24h: number;
  volume: {
    min_30?: number;
    hour_1?: number;
    hour_2?: number;
    hour_4?: number;
    hour_12?: number;
    hour_24?: number;
  };
  reserve_x_amount: number;
  reserve_y_amount: number;
  is_verified: boolean;
  decimals_x?: number; // Token X decimals (for future API enhancement)
  decimals_y?: number; // Token Y decimals (for future API enhancement)
}

export interface PairsResponse {
  pairs: MeteoraPair[];
  total: number;
}

export interface LoadingStatus {
  isLoading: boolean;
  pairsLoaded: number;
  currentPage: number;
  error?: string;
}

/**
 * Fetches a single page of DLMM pairs from the Meteora API
 */
export async function fetchPairsPage(page: number): Promise<PairsResponse> {
  const url = new URL(PAIRS_ENDPOINT, METEORA_API_BASE);
  url.searchParams.set('page', page.toString());
  url.searchParams.set('limit', PAGE_SIZE.toString());

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch pairs: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetches all DLMM pairs with pagination, stopping when pairs have no 24h volume
 */
export async function* fetchAllPairs(): AsyncGenerator<{
  pairs: MeteoraPair[];
  page: number;
  total: number;
  shouldContinue: boolean;
}> {
  let page = 0;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await fetchPairsPage(page);

      // Check if we should stop (no 24h volume)
      const hasVolume = response.pairs.some(pair =>
        pair.trade_volume_24h > 0
      );

      // If this page has no pairs with volume, we're done
      if (!hasVolume && response.pairs.length > 0) {
        hasMorePages = false;
      }

      // If we got fewer pairs than page size, we've reached the end
      if (response.pairs.length < PAGE_SIZE) {
        hasMorePages = false;
      }

      yield {
        pairs: response.pairs,
        page,
        total: response.total,
        shouldContinue: hasMorePages
      };

      page++;

      // Add a small delay to respect rate limits (30 RPS)
      await new Promise(resolve => setTimeout(resolve, 35));

    } catch (error) {
      console.error(`Error fetching page ${page}:`, error);
      hasMorePages = false;
      throw error;
    }
  }
}

/**
 * Parses token symbols from the pair name
 * Expected format: "TOKEN1-TOKEN2" or similar
 */
export function parseTokenSymbols(pairName: string): { base: string; quote: string } {
  // Try to split on common delimiters
  const delimiters = ['-', '/', '_'];

  for (const delimiter of delimiters) {
    if (pairName.includes(delimiter)) {
      const parts = pairName.split(delimiter);
      if (parts.length >= 2) {
        return {
          base: parts[0].trim(),
          quote: parts[1].trim()
        };
      }
    }
  }

  // Fallback if no delimiter found
  return {
    base: pairName,
    quote: 'UNKNOWN'
  };
}

/**
 * Filters pairs based on search term (token symbols, mint addresses, or pool address)
 */
export function filterPairs(pairs: MeteoraPair[], searchTerm: string): MeteoraPair[] {
  if (!searchTerm || searchTerm.trim() === '') {
    return [];
  }

  const term = searchTerm.toLowerCase().trim();

  // Check if search term looks like a pair name (contains delimiter)
  const pairDelimiters = ['-', '/'];
  let isPairSearch = false;
  let searchTokens: string[] = [];

  for (const delimiter of pairDelimiters) {
    if (term.includes(delimiter)) {
      searchTokens = term.split(delimiter).map(t => t.trim()).filter(t => t.length > 0);
      if (searchTokens.length === 2) {
        isPairSearch = true;
        break;
      }
    }
  }

  return pairs.filter(pair => {
    // If it's a pair search (e.g., "SOL-USDC"), only match exact token combinations
    if (isPairSearch && searchTokens.length === 2) {
      const pairName = pair.name.toLowerCase();
      const [token1, token2] = searchTokens;

      // Check if pair contains both tokens in any order
      const hasBothTokens =
        (pairName.includes(token1) && pairName.includes(token2));

      // Additional check: parse the pair name and compare tokens
      const symbols = parseTokenSymbols(pair.name);
      const symbol1 = symbols.base.toLowerCase();
      const symbol2 = symbols.quote.toLowerCase();

      const exactMatch =
        (symbol1 === token1 && symbol2 === token2) ||
        (symbol1 === token2 && symbol2 === token1);

      return hasBothTokens || exactMatch;
    }

    // Otherwise, do a general search
    // Search in pool address
    if (pair.address.toLowerCase().includes(term)) {
      return true;
    }

    // Search in mint addresses
    if (pair.mint_x.toLowerCase().includes(term) ||
        pair.mint_y.toLowerCase().includes(term)) {
      return true;
    }

    // Search in pair name (token symbols)
    if (pair.name.toLowerCase().includes(term)) {
      return true;
    }

    return false;
  });
}

/**
 * Formats USD value with appropriate precision
 */
export function formatUSD(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(num)) return '$0.00';

  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(2)}M`;
  } else if (num >= 1_000) {
    return `$${(num / 1_000).toFixed(2)}K`;
  } else {
    return `$${num.toFixed(2)}`;
  }
}
