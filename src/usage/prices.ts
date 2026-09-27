import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Usage } from '../providers/types.js';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
}

export interface PriceTable {
  version: string;
  /** Prices are per this many tokens (default 1M). */
  per: number;
  models: Record<string, ModelPrice>;
}

export const BUNDLED_PRICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prices.yaml');

export function loadPrices(file: string): PriceTable {
  const raw = YAML.parse(readFileSync(file, 'utf8')) as {
    version?: string;
    per?: number;
    models?: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>;
  };
  if (!raw?.version) throw new Error(`${file}: price table needs a "version"`);
  const models: Record<string, ModelPrice> = {};
  for (const [k, v] of Object.entries(raw.models ?? {})) {
    models[k] = { input: v.input, output: v.output, cacheRead: v.cache_read ?? v.input, cacheWrite: v.cache_write ?? null };
  }
  return { version: String(raw.version), per: raw.per ?? 1_000_000, models };
}

/** Finds the price table: explicit path, then <home>/prices.yaml, then the one shipped with agentp. */
export function resolvePrices(home: string, explicit?: string): PriceTable {
  const candidates = [explicit, process.env.AGENTP_PRICES, path.join(home, 'prices.yaml'), BUNDLED_PRICES];
  for (const c of candidates) if (c && existsSync(c)) return loadPrices(c);
  return { version: 'none', per: 1_000_000, models: {} };
}

export function priceFor(table: PriceTable, provider: string, model: string): ModelPrice | null {
  return table.models[`${provider}/${model}`] ?? null;
}

export interface Metered {
  costUsd: number | null;
  savingsUsd: number | null;
  priceVersion: string | null;
}

/** Usage Meter: turns raw usage into cost. Provider-reported cost wins over the calculated one. */
export function meter(usage: Usage, price: ModelPrice | null, table: PriceTable): Metered {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const savingsUsd = price && usage.cacheReadTokens != null ? (cacheRead * (price.input - price.cacheRead)) / table.per : null;
  if (usage.providerCostUsd != null) return { costUsd: usage.providerCostUsd, savingsUsd, priceVersion: null };
  if (!price || usage.inputTokens == null || usage.outputTokens == null) {
    return { costUsd: null, savingsUsd, priceVersion: price ? table.version : null };
  }
  const uncached = Math.max(0, usage.inputTokens - cacheRead);
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cost =
    uncached * price.input +
    cacheRead * price.cacheRead +
    cacheWrite * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return { costUsd: cost / table.per, savingsUsd, priceVersion: table.version };
}
