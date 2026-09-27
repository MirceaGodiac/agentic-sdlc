import { spawn } from 'node:child_process';
import { estimateTokens } from '../util.js';
import type { AgentRequest, AgentResult, Chunk, ProviderAdapter, ProviderCapabilities, Usage } from './types.js';

export interface CursorOptions {
  apiKey: () => Promise<string | null>;
  /** Cursor's headless agent CLI. Override with AGENTP_CURSOR_BIN. */
  bin?: string;
}

// Linux rejects single arguments above 128 KiB.
const MAX_PROMPT_BYTES = 120_000;

/**
 * Cursor adapter (experimental). Runs Cursor's headless agent CLI in the run's worktree, where Cursor uses
 * its own tools to read and edit files. Which usage and cache figures Cursor exposes is still being verified
 * (PRD Q3), so anything the CLI does not report is recorded as null ("not reported"), never estimated.
 */
export class CursorAdapter implements ProviderAdapter {
  readonly id = 'cursor' as const;
  constructor(private opts: CursorOptions) {}

  capabilities(): ProviderCapabilities {
    return { structuredOutput: false, promptCache: 'unknown', reportsCacheWrites: false, reportsUsage: false, customTools: false };
  }

  async run(req: AgentRequest, onChunk: (c: Chunk) => void): Promise<AgentResult> {
    const prompt = req.messages.map((m) => m.content ?? '').join('\n\n');
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      throw new Error(`prompt is ${Buffer.byteLength(prompt)} bytes; the Cursor CLI accepts at most ${MAX_PROMPT_BYTES}. Lower max_input_chars.`);
    }
    await req.beforeCall({ turn: 1, estimatedInputTokens: estimateTokens(prompt), maxOutputTokens: req.maxOutputTokens });

    const bin = this.opts.bin ?? process.env.AGENTP_CURSOR_BIN ?? 'cursor-agent';
    const key = await this.opts.apiKey();
    const args = ['--print', '--output-format', 'json', '--force', '--model', req.model, prompt];
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: req.workspace ?? process.cwd(),
        env: { ...process.env, ...(key ? { CURSOR_API_KEY: key } : {}) },
        signal: req.signal,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        onChunk({ text: d.toString() });
      });
      child.on('error', (e) =>
        reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Cursor CLI "${bin}" not found (set AGENTP_CURSOR_BIN)`) : e),
      );
      child.on('close', (c) => resolve({ stdout: out, stderr: err, code: c }));
    });
    if (code !== 0) throw new Error(`Cursor CLI exited with ${code}: ${(stderr || stdout).slice(0, 500)}`);

    const parsed = parseCursorJson(stdout);
    if (parsed.isError) throw new Error(`Cursor agent failed: ${parsed.result.slice(0, 500)}`);
    onChunk({ text: parsed.result });
    await req.afterCall({ turn: 1, usage: parsed.usage });
    return { output: parsed.result, turns: 1 };
  }
}

export function parseCursorJson(stdout: string): { result: string; isError: boolean; usage: Usage } {
  const lines = stdout.trim().split('\n').filter(Boolean);
  let obj: Record<string, unknown> | null = null;
  for (let i = lines.length - 1; i >= 0 && !obj; i--) {
    try {
      const candidate = JSON.parse(lines[i]);
      if (candidate && typeof candidate === 'object') obj = candidate;
    } catch {
      /* not JSON */
    }
  }
  if (!obj) return { result: stdout.trim(), isError: false, usage: emptyUsage() };
  const u = (obj.usage ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof u[k] === 'number') return u[k] as number;
    return null;
  };
  return {
    result: String(obj.result ?? ''),
    isError: obj.is_error === true,
    usage: {
      inputTokens: num('input_tokens', 'inputTokens', 'prompt_tokens'),
      outputTokens: num('output_tokens', 'outputTokens', 'completion_tokens'),
      cacheReadTokens: num('cache_read_tokens', 'cacheReadTokens', 'cache_read_input_tokens'),
      cacheWriteTokens: num('cache_write_tokens', 'cacheWriteTokens', 'cache_creation_input_tokens'),
      providerCostUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    },
  };
}

const emptyUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  providerCostUsd: null,
});
