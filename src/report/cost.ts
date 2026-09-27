import type { StoredEvent } from '../engine/events.js';
import type { UsageRow } from '../store/store.js';
import { formatTokens, formatUsd } from '../util.js';

export type GroupBy = 'step' | 'model' | 'day' | 'pipeline' | 'run';

export interface CostRow {
  key: string;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd: number;
  savingsUsd: number;
  /** Calls whose cost could not be determined (provider did not report usage, or no price). */
  unpriced: number;
}

export function groupUsage(rows: UsageRow[], by: GroupBy): CostRow[] {
  const map = new Map<string, CostRow>();
  for (const r of rows) {
    const key =
      by === 'step' ? `${r.step_id} #${r.iteration}` : by === 'model' ? `${r.provider}/${r.model}` : by === 'day' ? r.at.slice(0, 10) : by === 'run' ? r.run_id : r.pipeline_name;
    const row = map.get(key) ?? { key, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, savingsUsd: 0, unpriced: 0 };
    row.calls += 1;
    row.input += r.input ?? 0;
    row.cacheRead += r.cache_read ?? 0;
    row.cacheWrite += r.cache_write ?? 0;
    row.output += r.output ?? 0;
    row.costUsd += r.cost_usd ?? 0;
    row.savingsUsd += r.savings_usd ?? 0;
    if (r.cost_usd == null) row.unpriced += 1;
    map.set(key, row);
  }
  return [...map.values()];
}

export function formatCostTable(rows: CostRow[], by: GroupBy): string[] {
  const header = [by, 'calls', 'input', 'cache read', 'output', 'cost', 'saved by cache'];
  const body = rows.map((r) => [
    r.key,
    String(r.calls),
    formatTokens(r.input),
    formatTokens(r.cacheRead),
    formatTokens(r.output),
    r.unpriced === r.calls ? 'not reported' : `${formatUsd(r.costUsd)}${r.unpriced ? '*' : ''}`,
    formatUsd(r.savingsUsd),
  ]);
  const total = rows.reduce(
    (a, r) => ({
      calls: a.calls + r.calls,
      input: a.input + r.input,
      cacheRead: a.cacheRead + r.cacheRead,
      output: a.output + r.output,
      cost: a.cost + r.costUsd,
      saved: a.saved + r.savingsUsd,
      unpriced: a.unpriced + r.unpriced,
    }),
    { calls: 0, input: 0, cacheRead: 0, output: 0, cost: 0, saved: 0, unpriced: 0 },
  );
  body.push([
    'total',
    String(total.calls),
    formatTokens(total.input),
    formatTokens(total.cacheRead),
    formatTokens(total.output),
    `${formatUsd(total.cost)}${total.unpriced ? '*' : ''}`,
    formatUsd(total.saved),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  const lines = [fmt(header), widths.map((w) => '─'.repeat(w)).join('  '), ...body.slice(0, -1).map(fmt), widths.map((w) => '─'.repeat(w)).join('  '), fmt(body[body.length - 1])];
  if (total.unpriced) lines.push(`* ${total.unpriced} call(s) without a known cost (provider did not report usage, or no price in the table)`);
  return lines;
}

/** "Step validate #2 read 38k cached tokens (prefix from code #1), saving $0.41" */
export function cacheAttribution(events: StoredEvent[]): string[] {
  const lines: string[] = [];
  const sources = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'ContextBuilt' && e.cacheSource) sources.set(`${e.stepId}#${e.iteration}`, `${e.cacheSource.stepId} #${e.cacheSource.iteration}`);
  }
  const perStep = new Map<string, { read: number; saved: number }>();
  for (const e of events) {
    if (e.type !== 'UsageRecorded' || !e.usage.cacheReadTokens) continue;
    const key = `${e.stepId}#${e.iteration}`;
    const agg = perStep.get(key) ?? { read: 0, saved: 0 };
    agg.read += e.usage.cacheReadTokens;
    agg.saved += e.savingsUsd ?? 0;
    perStep.set(key, agg);
  }
  for (const [key, agg] of perStep) {
    const [step, iter] = key.split('#');
    const from = sources.get(key);
    lines.push(
      `${step} #${iter} read ${formatTokens(agg.read)} cached tokens${from ? ` (prefix first sent by ${from})` : ' (from its own earlier turns)'}, saving ${formatUsd(agg.saved)}`,
    );
  }
  return lines;
}
