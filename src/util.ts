import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const newRunId = (): string => randomBytes(3).toString('hex');

/** Rough token estimate used only for budget pre-checks (actual usage always comes from the provider). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string | number): number {
  if (typeof value === 'number') return value * 1000;
  const m = DURATION.exec(value.trim());
  if (!m) throw new Error(`invalid duration "${value}" (use e.g. 90s, 30m, 24h, 2d)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

/** Pull a JSON object out of model text: bare JSON, a fenced block, or the outermost {...}. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('no JSON object found in output');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function formatUsd(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
