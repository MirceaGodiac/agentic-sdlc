import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { silentNotifier } from '../src/gates/notify.js';
import { loadPipeline } from '../src/pipeline/loader.js';
import { parseCursorJson } from '../src/providers/cursor.js';
import { OpenAIAdapter } from '../src/providers/openai.js';
import type { ProviderRegistry } from '../src/providers/types.js';
import { Store } from '../src/store/store.js';
import { type FakeTurn, startFakeOpenAI } from './fake-openai.js';
import { BUILD_FEATURE_FILES, PRICES, tempDir, verdict, writeFiles } from './helpers.js';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const TSX = pathToFileURL(path.join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;

function reply(role: string, n: number): FakeTurn {
  switch (role) {
    case 'planner':
      return { content: 'PLAN: create hello.txt', usage: { prompt: 1200, completion: 50, cached: 0 } };
    case 'coder':
      // First call asks for a tool, second call answers.
      return n === 1
        ? { toolCalls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'hello\n' } }], usage: { prompt: 1300, completion: 30, cached: 1024 } }
        : { content: 'Created hello.txt', usage: { prompt: 1400, completion: 20, cached: 1280 } };
    case 'validator':
      return { content: n === 1 ? verdict('fail', ['missing newline']) : verdict('pass'), usage: { prompt: 1500, completion: 40, cached: 1024 } };
    case 'fixer':
      return { content: 'Fixed', usage: { prompt: 1600, completion: 20, cached: 1024 } };
    default:
      return { content: '?' };
  }
}

const withTools = {
  ...BUILD_FEATURE_FILES,
  'agents/coder.md': '---\nprovider: openai\nmodel: m1\ntools: [write_file, read_file]\n---\nROLE: coder\n',
};

let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
beforeAll(async () => {
  fake = await startFakeOpenAI(reply);
});
afterAll(() => fake.close());

describe('OpenAI adapter against a fake streaming API', () => {
  it('streams, runs tool calls, uses structured output and records cached tokens', async () => {
    const dir = tempDir();
    writeFiles(dir, withTools);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const store = new Store(path.join(dir, '.agentp'));
    const openai = new OpenAIAdapter({ apiKey: async () => 'test-key', baseUrl: fake.url });
    const engine = new Engine({ store, providers: { openai, cursor: openai } as unknown as ProviderRegistry, prices: PRICES, notifier: silentNotifier, retryBaseMs: 0 });
    fake.reset();

    const runId = engine.start(loadPipeline(path.join(dir, 'pipeline.yaml'), dir).pipeline, 'say hello', { repo: dir });
    const state = await engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');

    // Tool call ran inside the worktree and was committed on the run's branch.
    expect(readFileSync(path.join(state.workspace.path, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(execFileSync('git', ['log', '--oneline', `agentp/${runId}`], { cwd: dir, encoding: 'utf8' })).toContain(`agentp ${runId}: code #1`);

    const validatorReq = fake.requests.find((r) => r.role === 'validator')!;
    expect(validatorReq.body.response_format?.type).toBe('json_schema');
    const coderReqs = fake.requests.filter((r) => r.role === 'coder');
    expect(coderReqs).toHaveLength(2);
    expect(coderReqs[1].body.messages.some((m) => m.role === 'tool')).toBe(true);

    const usage = store.usage({ runId });
    expect(usage.find((u) => u.step_id === 'code')?.cache_read).toBe(1024);
    const codeCost = usage.filter((u) => u.step_id === 'code').reduce((a, u) => a + (u.cost_usd ?? 0), 0);
    // (1300-1024)*1 + 1024*0.25 + 30*4  +  (1400-1280)*1 + 1280*0.25 + 20*4   per 1M
    expect(codeCost).toBeCloseTo((276 + 256 + 120 + 120 + 320 + 80) / 1e6, 10);
    store.close();
  });
});

describe('agentp CLI', () => {
  const cli = (home: string, args: string[], cwd: string) =>
    run(process.execPath, ['--import', TSX, '--no-warnings=ExperimentalWarning', path.join(ROOT, 'src/cli/main.ts'), '--home', home, ...args], {
      cwd,
      env: { ...process.env, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url, AGENTP_NOTIFY: 'off', AGENTP_PRICES: '' },
    });

  it('runs a pipeline to a gate, approves it, and reports cost, logs and a diagram', async () => {
    fake.reset();
    const dir = tempDir();
    writeFiles(dir, {
      ...withTools,
      'prices.yaml': 'version: t1\nmodels:\n  openai/m1: { input: 1, cache_read: 0.25, output: 4 }\n',
    });
    const home = path.join(dir, '.agentp');
    const started = await cli(home, ['--prices', 'prices.yaml', 'run', 'pipeline.yaml', '--input', 'say hello', '--no-repo'], dir);
    const runId = /run (\w+) started/.exec(started.stderr)![1];
    expect(started.stdout).toContain('gate review opened');
    expect(started.stdout).toContain('loop validate-fix: round 2');

    const gates = await cli(home, ['gates', '--json'], dir);
    expect(JSON.parse(gates.stdout)[0]).toMatchObject({ run_id: runId, gate_id: 'review' });

    const approved = await cli(home, ['--prices', 'prices.yaml', 'approve', runId], dir);
    expect(approved.stdout).toContain('finished');

    const ls = JSON.parse((await cli(home, ['ls', '--json'], dir)).stdout);
    expect(ls[0]).toMatchObject({ id: runId, status: 'succeeded' });

    const cost = await cli(home, ['cost', runId], dir);
    expect(cost.stdout).toMatch(/validate #2/);
    expect(cost.stdout).toMatch(/read 1k cached tokens \(prefix first sent by/);

    const logs = await cli(home, ['logs', runId, '--step', 'validate'], dir);
    expect(logs.stdout).toMatch(/context \(attempt 1\): shared:PROJECT.md/);
    expect(logs.stdout).toMatch(/\[fail, 1 findings\]/);

    const diagram = await cli(home, ['diagram', runId, '--costs'], dir);
    expect(diagram.stdout).toContain('✘ validate #1<br/>1 findings');
    expect(diagram.stdout).toContain('⏸ review<br/>approve');
    expect(diagram.stdout).toMatch(/done\(\["succeeded · \$/);
  }, 60_000);

  it('refuses a budget it cannot enforce', async () => {
    const dir = tempDir();
    writeFiles(dir, { ...BUILD_FEATURE_FILES, 'pipeline.yaml': `budget: { max_cost_usd: 1 }\n${BUILD_FEATURE_FILES['pipeline.yaml']}` });
    const res = await cli(path.join(dir, '.agentp'), ['run', 'pipeline.yaml', '--no-repo', '-i', 'x'], dir).catch((e) => e);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/no price for openai\/m1/);
    expect(existsSync(path.join(dir, '.agentp', 'worktrees'))).toBe(false);
  }, 30_000);
});

describe('cursor adapter', () => {
  it('parses the CLI JSON result and leaves unreported usage as null', () => {
    const out = parseCursorJson('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s"}\n');
    expect(out).toEqual({
      result: 'done',
      isError: false,
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null },
    });
    expect(parseCursorJson('{"result":"x","usage":{"input_tokens":10,"output_tokens":2}}').usage.inputTokens).toBe(10);
  });
});
