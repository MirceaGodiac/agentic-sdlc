import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Engine, type EngineHooks } from '../engine/engine.js';
import { defaultProviders } from '../providers/registry.js';
import { Store } from '../store/store.js';
import { type PriceTable, resolvePrices } from '../usage/prices.js';

export interface Config {
  budget?: { max_cost_usd_per_day?: number };
}

/** The agentp home: --home, AGENTP_HOME, the nearest .agentp directory above cwd, or ./.agentp. */
export function resolveHome(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.AGENTP_HOME) return path.resolve(process.env.AGENTP_HOME);
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, '.agentp');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), '.agentp');
    dir = parent;
  }
}

export interface Ctx {
  home: string;
  store: Store;
  prices: PriceTable;
  config: Config;
  engine: Engine;
}

export function openContext(opts: { home?: string; prices?: string }, hooks?: EngineHooks): Ctx {
  const home = resolveHome(opts.home);
  const store = new Store(home);
  const prices = resolvePrices(home, opts.prices);
  const configFile = path.join(home, 'config.yaml');
  const config = (existsSync(configFile) ? YAML.parse(readFileSync(configFile, 'utf8')) : {}) as Config;
  const engine = new Engine({
    store,
    providers: defaultProviders(),
    prices,
    globalDailyCapUsd: config.budget?.max_cost_usd_per_day,
    hooks,
  });
  return { home, store, prices, config, engine };
}
