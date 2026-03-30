/**
 * Meteora DLMM API Service
 * Fetches and manages DLMM pool data from the Meteora API
 */

const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';
const PAIRS_ENDPOINT = '/pools';
const PAGE_SIZE = 1000;

export interface MeteoraToken {
  mint: string;
  symbol: string;
}

// Raw API response types
interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders?: number;
  freeze_authority_disabled?: boolean;
  total_supply?: number;
  price?: number;
  market_cap?: number;
}

interface PoolConfig {
  bin_step: number;
  base_fee_pct: number;
  max_fee_pct: number;
  protocol_fee_pct: number;
}

interface VolumeData {
  '30m'?: number;
  '1h'?: number;
  '2h'?: number;
  '4h'?: number;
  '12h'?: number;
  '24h'?: number;
}

interface RawMeteoraPair {
  address: string;
  name: string;
  token_x: TokenInfo;
  token_y: TokenInfo;
  reserve_x: string;
  reserve_y: string;
  token_x_amount: number;
  token_y_amount: number;
  created_at: number;
  reward_mint_x: string;
  reward_mint_y: string;
  pool_config: PoolConfig;
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  apr: number;
  apy: number;
  has_farm: boolean;
  farm_apr: number;
  farm_apy: number;
  volume: VolumeData;
  fees: VolumeData;
  protocol_fees: VolumeData;
  fee_tvl_ratio: VolumeData;
  cumulative_metrics: {
    volume: number;
    fees: number;
  };
  is_blacklisted: boolean;
  launchpad: string;
  tags: string[];
}

interface RawPairsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: RawMeteoraPair[];
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
  decimals_x?: number;
  decimals_y?: number;
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
 * Transforms raw API response to the internal MeteoraPair format
 */
function transformRawPair(raw: RawMeteoraPair): MeteoraPair {
  return {
    address: raw.address,
    name: raw.name,
    mint_x: raw.token_x.address,
    mint_y: raw.token_y.address,
    bin_step: raw.pool_config.bin_step,
    current_price: raw.current_price,
    liquidity: raw.tvl.toString(),
    trade_volume_24h: raw.volume['24h'] || 0,
    volume: {
      min_30: raw.volume['30m'],
      hour_1: raw.volume['1h'],
      hour_2: raw.volume['2h'],
      hour_4: raw.volume['4h'],
      hour_12: raw.volume['12h'],
      hour_24: raw.volume['24h']
    },
    reserve_x_amount: raw.token_x_amount,
    reserve_y_amount: raw.token_y_amount,
    is_verified: raw.token_x.is_verified && raw.token_y.is_verified,
    decimals_x: raw.token_x.decimals,
    decimals_y: raw.token_y.decimals
  };
}

/**
 * Fetches a single page of DLMM pairs from the Meteora API
 */
export async function fetchPairsPage(page: number): Promise<PairsResponse> {
  const url = new URL(PAIRS_ENDPOINT, METEORA_API_BASE);
  url.searchParams.set('page', page.toString());
  url.searchParams.set('page_size', PAGE_SIZE.toString());
  url.searchParams.set('sort_by', 'volume_24h:desc');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch pairs: ${response.statusText}`);
  }

  const data = (await response.json()) as RawPairsResponse;

  return {
    pairs: data.data.map(transformRawPair),
    total: data.total
  };
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
  let page = 1;
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
