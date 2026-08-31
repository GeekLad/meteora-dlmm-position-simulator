/**
 * Fetch a wallet's real per-bin DLMM liquidity from on-chain PositionV2 + BinArray accounts.
 * REST APIs only return total token balances, which is why a spot reconstruction looks flat.
 */

import { PublicKey } from '@solana/web3.js';
import { getPriceFromId, trimEmptyEdgeBins, type SimulatedBin } from './dlmm';
import { toSimulatorBinId } from './dlmm-sdk-wrapper';

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const MAX_BIN_PER_ARRAY = 70;
const DEFAULT_BIN_PER_POSITION = 70;
const POSITION_BASE_SIZE = 8120;
const POSITION_EXTRA_BIN_SIZE = 112;
const BIN_SIZE = 144;
const BIN_ARRAY_BINS_OFFSET = 56;
const RPC_URLS = [
  'https://solana-rpc.publicnode.com',
];

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readI32(data: Uint8Array, offset: number): number {
  return viewOf(data).getInt32(offset, true);
}

function readI64(data: Uint8Array, offset: number): number {
  return Number(viewOf(data).getBigInt64(offset, true));
}

function readU64(data: Uint8Array, offset: number): bigint {
  return viewOf(data).getBigUint64(offset, true);
}

function readU128(data: Uint8Array, offset: number): bigint {
  const view = viewOf(data);
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  return (hi << BigInt(64)) + lo;
}

function readPubkey(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function i64le(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
  return bytes;
}

function binIdToArrayIndex(binId: number): number {
  const idx = binId < 0 ? -Math.floor(Math.abs(binId) / MAX_BIN_PER_ARRAY) : Math.floor(binId / MAX_BIN_PER_ARRAY);
  const mod = binId - idx * MAX_BIN_PER_ARRAY;
  return binId < 0 && mod !== 0 ? idx - 1 : idx;
}

function arrayIndexToFirstBinId(index: number): number {
  return index * MAX_BIN_PER_ARRAY;
}

function deriveBinArrayPda(lbPair: PublicKey, index: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bin_array'), lbPair.toBytes(), i64le(index)],
    DLMM_PROGRAM_ID
  )[0];
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (const url of RPC_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!response.ok) {
        lastError = new Error(`RPC ${response.status}`);
        continue;
      }
      const json = await response.json() as { result?: T; error?: { message?: string } };
      if (json.error) {
        lastError = new Error(json.error.message || 'RPC error');
        continue;
      }
      return json.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('RPC failed');
    }
  }
  throw lastError ?? new Error('RPC unavailable');
}

async function getMultipleAccounts(addresses: string[]): Promise<(Uint8Array | null)[]> {
  if (addresses.length === 0) return [];
  const result = await rpcCall<{ value: Array<{ data: [string, string] } | null> }>(
    'getMultipleAccounts',
    [addresses, { encoding: 'base64' }]
  );
  return (result?.value ?? []).map(account => {
    if (!account?.data?.[0]) return null;
    const binary = atob(account.data[0]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });
}

interface DecodedPosition {
  address: string;
  lbPair: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  shares: bigint[];
}

interface DecodedBin {
  amountX: bigint;
  amountY: bigint;
  liquiditySupply: bigint;
}

function decodePosition(address: string, data: Uint8Array): DecodedPosition {
  const lowerBinId = readI32(data, 7912);
  const upperBinId = readI32(data, 7916);
  const width = upperBinId - lowerBinId + 1;
  const shares: bigint[] = [];
  for (let i = 0; i < DEFAULT_BIN_PER_POSITION; i++) {
    shares.push(readU128(data, 72 + i * 16));
  }
  let offset = POSITION_BASE_SIZE;
  while (offset + POSITION_EXTRA_BIN_SIZE <= data.length && shares.length < width) {
    shares.push(readU128(data, offset));
    offset += POSITION_EXTRA_BIN_SIZE;
  }
  return {
    address,
    lbPair: readPubkey(data, 8),
    lowerBinId,
    upperBinId,
    shares,
  };
}

function decodeBinArray(data: Uint8Array): { index: number; bins: DecodedBin[] } {
  const bins: DecodedBin[] = [];
  for (let i = 0; i < MAX_BIN_PER_ARRAY; i++) {
    const offset = BIN_ARRAY_BINS_OFFSET + i * BIN_SIZE;
    bins.push({
      amountX: readU64(data, offset),
      amountY: readU64(data, offset + 8),
      liquiditySupply: readU128(data, offset + 32),
    });
  }
  return { index: readI64(data, 8), bins };
}

function shareToAmounts(share: bigint, bin: DecodedBin): { x: bigint; y: bigint } {
  if (share === BigInt(0) || bin.liquiditySupply === BigInt(0)) return { x: BigInt(0), y: BigInt(0) };
  return {
    x: (share * bin.amountX) / bin.liquiditySupply,
    y: (share * bin.amountY) / bin.liquiditySupply,
  };
}

function toSimulatedBin(options: {
  onChainBinId: number;
  baseAmount: number;
  quoteAmount: number;
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  activeBinId: number;
}): SimulatedBin {
  const id = toSimulatorBinId(options.onChainBinId);
  const price = getPriceFromId(
    id,
    options.binStep,
    options.baseDecimals,
    options.quoteDecimals,
    options.applyDecimalAdjustment
  );
  const marketPrice = getPriceFromId(
    toSimulatorBinId(options.activeBinId),
    options.binStep,
    options.baseDecimals,
    options.quoteDecimals,
    options.applyDecimalAdjustment
  );
  const decimalAdjustment = options.quoteDecimals - options.baseDecimals;
  const pricePerLamport = price * Math.pow(10, decimalAdjustment);
  const quoteValue = options.quoteAmount + options.baseAmount * (marketPrice > 0 ? marketPrice : price);
  const onQuoteSide = options.onChainBinId < options.activeBinId
    || (options.onChainBinId === options.activeBinId && options.quoteAmount >= options.baseAmount * (price || 0));
  const tokenType: 'base' | 'quote' = onQuoteSide ? 'quote' : 'base';
  const amount = tokenType === 'quote'
    ? (options.quoteAmount > 0 || options.baseAmount === 0 ? options.quoteAmount : quoteValue)
    : (options.baseAmount > 0 || options.quoteAmount === 0 ? options.baseAmount : (price > 0 ? quoteValue / price : 0));

  return {
    id,
    price,
    pricePerLamport,
    initialTokenType: tokenType,
    initialAmount: amount,
    initialValueInQuote: quoteValue,
    initialDisplayValue: options.quoteAmount + options.baseAmount * price,
    currentTokenType: tokenType,
    currentAmount: amount,
    currentValueInQuote: quoteValue,
  };
}

export interface OnChainPositionLiquidity {
  combined: SimulatedBin[];
  byPosition: Record<string, SimulatedBin[]>;
}

function amountsToBins(
  merged: Map<number, { base: number; quote: number }>,
  options: {
    binStep: number;
    baseDecimals: number;
    quoteDecimals: number;
    applyDecimalAdjustment: boolean;
    activeBinId: number;
  }
): SimulatedBin[] {
  const liquidIds = [...merged.keys()].sort((a, b) => a - b);
  if (liquidIds.length === 0) return [];
  const minId = liquidIds[0];
  const maxId = liquidIds[liquidIds.length - 1];
  const result: SimulatedBin[] = [];
  for (let binId = minId; binId <= maxId; binId++) {
    const amounts = merged.get(binId) ?? { base: 0, quote: 0 };
    result.push(toSimulatedBin({
      onChainBinId: binId,
      baseAmount: amounts.base,
      quoteAmount: amounts.quote,
      binStep: options.binStep,
      baseDecimals: options.baseDecimals,
      quoteDecimals: options.quoteDecimals,
      applyDecimalAdjustment: options.applyDecimalAdjustment,
      activeBinId: options.activeBinId,
    }));
  }
  return result;
}

export async function fetchOnChainPositionLiquidity(options: {
  positionAddresses: string[];
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  fallbackActiveBinId: number;
}): Promise<OnChainPositionLiquidity> {
  const {
    positionAddresses,
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    fallbackActiveBinId,
  } = options;

  const uniqueAddresses = [...new Set(positionAddresses.filter(Boolean))];
  if (uniqueAddresses.length === 0) return { combined: [], byPosition: {} };

  const positionAccounts = await getMultipleAccounts(uniqueAddresses);
  const positions: DecodedPosition[] = [];
  for (let i = 0; i < uniqueAddresses.length; i++) {
    const data = positionAccounts[i];
    if (!data || data.length < POSITION_BASE_SIZE) continue;
    positions.push(decodePosition(uniqueAddresses[i], data));
  }
  if (positions.length === 0) return { combined: [], byPosition: {} };

  const needed = new Map<string, { pair: PublicKey; index: number }>();
  for (const position of positions) {
    const minIdx = binIdToArrayIndex(position.lowerBinId);
    const maxIdx = binIdToArrayIndex(position.upperBinId);
    for (let index = minIdx; index <= maxIdx; index++) {
      const key = `${position.lbPair.toBase58()}:${index}`;
      if (!needed.has(key)) needed.set(key, { pair: position.lbPair, index });
    }
  }

  const arrayMetas = [...needed.values()];
  const arrayAddresses = arrayMetas.map(meta => deriveBinArrayPda(meta.pair, meta.index).toBase58());
  const arrayAccounts = await getMultipleAccounts(arrayAddresses);
  const arrays = new Map<string, DecodedBin[]>();
  for (let i = 0; i < arrayMetas.length; i++) {
    const data = arrayAccounts[i];
    if (!data) continue;
    const decoded = decodeBinArray(data);
    arrays.set(`${arrayMetas[i].pair.toBase58()}:${arrayMetas[i].index}`, decoded.bins);
  }

  const onChainActive = fallbackActiveBinId > 100000
    ? fallbackActiveBinId - 262144
    : fallbackActiveBinId;

  const combinedMap = new Map<number, { base: number; quote: number }>();
  const byPosition: Record<string, SimulatedBin[]> = {};
  const binOptions = {
    binStep,
    baseDecimals,
    quoteDecimals,
    applyDecimalAdjustment,
    activeBinId: onChainActive,
  };

  for (const position of positions) {
    const posMap = new Map<number, { base: number; quote: number }>();
    for (let i = 0; i < position.upperBinId - position.lowerBinId + 1; i++) {
      const binId = position.lowerBinId + i;
      const share = position.shares[i] ?? BigInt(0);
      const arrIdx = binIdToArrayIndex(binId);
      const bins = arrays.get(`${position.lbPair.toBase58()}:${arrIdx}`);
      const offset = binId - arrayIndexToFirstBinId(arrIdx);
      const bin = bins?.[offset];
      const amounts = bin ? shareToAmounts(share, bin) : { x: BigInt(0), y: BigInt(0) };
      const base = Number(amounts.x) / 10 ** baseDecimals;
      const quote = Number(amounts.y) / 10 ** quoteDecimals;
      if (base <= 0 && quote <= 0) continue;
      const local = posMap.get(binId) ?? { base: 0, quote: 0 };
      local.base += base;
      local.quote += quote;
      posMap.set(binId, local);
      const combined = combinedMap.get(binId) ?? { base: 0, quote: 0 };
      combined.base += base;
      combined.quote += quote;
      combinedMap.set(binId, combined);
    }
    byPosition[position.address] = amountsToBins(posMap, binOptions);
  }

  return {
    combined: trimEmptyEdgeBins(amountsToBins(combinedMap, binOptions)),
    byPosition,
  };
}

export async function fetchOnChainCombinedBins(options: {
  positionAddresses: string[];
  binStep: number;
  baseDecimals: number;
  quoteDecimals: number;
  applyDecimalAdjustment: boolean;
  fallbackActiveBinId: number;
}): Promise<SimulatedBin[]> {
  const result = await fetchOnChainPositionLiquidity(options);
  return result.combined;
}
