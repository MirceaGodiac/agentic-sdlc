import { afterEach, describe, expect, it } from 'vitest';
import { planCall } from '../src/engine/budget.js';
import { PREAMBLE } from '../src/engine/context.js';
import { BUILD_FEATURE, BUILD_FEATURE_FILES, PRICES, agent, setup, verdict } from './helpers.js';

const stores: { close(): void }[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

const script = (role: string) => (role === 'validator' ? { output: verdict('pass') } : { output: `${role} output` });

describe('budget guard', () => {
  const price = PRICES.models['openai/m1'];
  const spent = { runUsd: 0, runTokens: 0, pipelineDayUsd: 0, globalDayUsd: 0 };

  it('caps output tokens to what the remaining budget can pay for', () => {
    const plan = planCall({ runUsd: 0.01 }, spent, price, 1e6, 1000, 100_000);
    // $0.01 - 1200 input tokens * $1/M = $0.0088 left → 2200 output tokens at $4/M
    expect(plan).toEqual({ ok: true, maxOutputTokens: 2200 });
  });

  it('refuses a call it cannot afford and explains which cap', () => {
    const plan = planCall({ runUsd: 1, globalDayUsd: 2 }, { ...spent, globalDayUsd: 2 }, price, 1e6, 1000, 1000);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/global daily cap/);
  });

  it('refuses when the model has no price and a cost cap is set', () => {
    expect(planCall({ runUsd: 1 }, spent, null, 1e6, 10, 10).ok).toBe(false);
    expect(planCall({}, spent, null, 1e6, 10, 10).ok).toBe(true);
  });

  it('pauses the run at a budget gate before overspending, and continues with a raised cap', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'pipeline.yaml': `budget: { max_cost_usd: 0.004 }\n${BUILD_FEATURE}` };
    const t = setup(files, script);
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    let state = await t.engine.drive(runId);
    expect(state.openGate?.reason).toBe('budget');
    expect(state.spentUsd).toBeLessThanOrEqual(0.004);
    expect(() => t.engine.decideGate(runId, { decision: 'approve' })).toThrow(/--budget/);
    t.engine.decideGate(runId, { decision: 'approve', budgetUsd: 1 });
    state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
  });

  it('stops the run if a call pushes spend past the hard cap', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'pipeline.yaml': `budget: { max_cost_usd: 1 }\n${BUILD_FEATURE}` };
    const t = setup(files, (role) => (role === 'coder' ? { output: 'x', usage: { providerCostUsd: 5 } } : script(role)));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.status).toBe('budget_exceeded');
  });

  it('enforces a token cap', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'pipeline.yaml': `budget: { max_tokens: 2500 }\n${BUILD_FEATURE}` };
    const t = setup(files, script);
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.openGate?.reason).toBe('budget');
    expect(state.tokens).toBeLessThanOrEqual(2500);
  });
});

describe('context builder', () => {
  it('puts shared parts first, then agent instructions, then what changes', async () => {
    const t = setup(BUILD_FEATURE_FILES, (role, n) => (role === 'validator' ? { output: verdict(n === 1 ? 'fail' : 'pass', ['bad']) } : { output: `${role} out` }));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);

    const fixer = t.fake.calls.find((c) => c.role === 'fixer')!.req.messages;
    expect(fixer.map((m) => m.role)).toEqual(['system', 'user', 'system', 'user']);
    expect(fixer[0].content).toBe(PREAMBLE);
    expect(fixer[1].content).toMatch(/Shared context: PROJECT.md[\s\S]*Output "plan"/);
    expect(fixer[1].content).not.toContain('Output "patch"');
    expect(fixer[2].content).toContain('ROLE: fixer');
    // patch and findings are rewritten inside the loop, so they sit after the instructions.
    expect(fixer[3].content).toMatch(/Output "patch"[\s\S]*Output "findings"[\s\S]*## Task/);

    const built = t.store.events(runId).filter((e) => e.type === 'ContextBuilt');
    const byStep = Object.fromEntries(built.map((e) => [`${e.stepId}#${e.iteration}`, e.type === 'ContextBuilt' ? e.cacheSource : null]));
    expect(byStep['plan#1']).toBeNull();
    expect(byStep['code#1']).toEqual({ stepId: 'plan', iteration: 1, sharedParts: 1 });
    expect(byStep['validate#1']).toEqual({ stepId: 'code', iteration: 1, sharedParts: 2 });
    // Later rounds reuse the whole prefix, including the agent's instructions.
    expect(byStep['validate#2']).toEqual({ stepId: 'validate', iteration: 1, sharedParts: 3 });
  });

  it('gives isolated agents no shared prefix', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'agents/validator.md': agent('validator', 'output_schema: verdict\ncache: isolated\n') };
    const t = setup(files, script);
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    const v = t.fake.calls.find((c) => c.role === 'validator')!.req.messages;
    expect(v).toHaveLength(2);
    expect(v.map((m) => m.content).join()).not.toContain('Project: a todo app');
  });

  it('replaces oversized inputs with a head and a file reference, and logs it', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'pipeline.yaml': `max_input_chars: 5000\n${BUILD_FEATURE}` };
    const t = setup(files, (role) => (role === 'planner' ? { output: 'P'.repeat(20_000) } : script(role)));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    const coder = t.fake.calls.find((c) => c.role === 'coder')!.req.messages.map((m) => m.content).join('\n');
    expect(coder).toContain('[Truncated: showing the first 4000 of 20000 chars.');
    const ctx = t.store.events(runId).find((e) => e.type === 'ContextBuilt' && e.stepId === 'code');
    expect(ctx?.type === 'ContextBuilt' && ctx.parts.find((p) => p.source === 'plan')?.substituted).toMatch(/truncated 20000/);
  });
});
