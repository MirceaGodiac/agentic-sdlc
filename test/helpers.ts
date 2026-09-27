import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine, type EngineHooks } from '../src/engine/engine.js';
import { silentNotifier } from '../src/gates/notify.js';
import { loadPipeline } from '../src/pipeline/loader.js';
import type { AgentRequest, ProviderAdapter, ProviderRegistry, Usage } from '../src/providers/types.js';
import { Store } from '../src/store/store.js';
import type { PriceTable } from '../src/usage/prices.js';

export const PRICES: PriceTable = {
  version: 'test-1',
  per: 1_000_000,
  models: { 'openai/m1': { input: 1, output: 4, cacheRead: 0.25, cacheWrite: null } },
};

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'agentp-test-'));
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
}

export const agent = (role: string, extra = '') => `---\nprovider: openai\nmodel: m1\n${extra}---\nROLE: ${role}\n`;

export interface FakeReply {
  output: string;
  usage?: Partial<Usage>;
  /** Tool calls to make before answering. */
  tools?: { name: string; arguments: Record<string, unknown> }[];
  error?: string;
}

/** Scripted provider: picks the reply by the ROLE line in the agent instructions. */
export class FakeProvider implements ProviderAdapter {
  readonly id = 'openai' as const;
  calls: { role: string; req: AgentRequest }[] = [];
  constructor(private script: (role: string, n: number, req: AgentRequest) => FakeReply) {}

  capabilities() {
    return { structuredOutput: true, promptCache: 'auto' as const, reportsCacheWrites: false, reportsUsage: true, customTools: true };
  }

  async run(req: AgentRequest, onChunk: (c: { text: string }) => void) {
    const all = req.messages.map((m) => m.content).join('\n');
    const role = /ROLE: (\w+)/.exec(all)?.[1] ?? 'unknown';
    const n = this.calls.filter((c) => c.role === role).length + 1;
    this.calls.push({ role, req });
    const reply = this.script(role, n, req);
    const maxOut = await req.beforeCall({ turn: 1, estimatedInputTokens: Math.ceil(all.length / 3.5), maxOutputTokens: req.maxOutputTokens });
    for (const t of reply.tools ?? []) await req.executeTool({ id: 't', name: t.name, arguments: JSON.stringify(t.arguments) });
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: Math.min(200, maxOut),
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      providerCostUsd: null,
      ...reply.usage,
    };
    await req.afterCall({ turn: 1, usage });
    if (reply.error) throw new Error(reply.error);
    onChunk({ text: reply.output });
    return { output: reply.output, turns: 1 };
  }
}

export function setup(files: Record<string, string>, script: ConstructorParameters<typeof FakeProvider>[0], hooks?: EngineHooks) {
  const dir = tempDir();
  writeFiles(dir, files);
  const store = new Store(path.join(dir, '.agentp'));
  const fake = new FakeProvider(script);
  const providers = { openai: fake, cursor: fake } as unknown as ProviderRegistry;
  const engine = new Engine({ store, providers, prices: PRICES, notifier: silentNotifier, retryBaseMs: 0, pollMs: 20, hooks });
  const load = (file = 'pipeline.yaml') => loadPipeline(path.join(dir, file), dir);
  return { dir, store, fake, engine, load };
}

export const BUILD_FEATURE = `
name: build-feature
shared_context: [PROJECT.md]
steps:
  - id: plan
    agent: agents/planner.md
    inputs: [run.input]
    output: plan
  - id: code
    agent: agents/coder.md
    inputs: [plan]
    output: patch
  - loop:
      id: validate-fix
      max_iterations: 3
      until: validate.verdict == "pass"
      steps:
        - id: validate
          agent: agents/validator.md
          inputs: [plan, patch]
          output: findings
        - id: fix
          agent: agents/fixer.md
          inputs: [plan, patch, findings, loop.history]
          output: patch
  - gate:
      id: review
      show: [plan, patch, findings]
`;

export const BUILD_FEATURE_FILES = {
  'pipeline.yaml': BUILD_FEATURE,
  'PROJECT.md': 'Project: a todo app.',
  'agents/planner.md': agent('planner'),
  'agents/coder.md': agent('coder'),
  'agents/validator.md': agent('validator', 'output_schema: verdict\n'),
  'agents/fixer.md': agent('fixer'),
};

export const verdict = (v: 'pass' | 'fail', findings: string[] = []) => JSON.stringify({ verdict: v, findings });
