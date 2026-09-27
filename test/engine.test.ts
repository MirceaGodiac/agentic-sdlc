import { afterEach, describe, expect, it } from 'vitest';
import type { GateAnswer } from '../src/engine/engine.js';
import { BUILD_FEATURE, BUILD_FEATURE_FILES, agent, setup, verdict } from './helpers.js';

const stores: { close(): void }[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

function happyScript(failRounds = 1) {
  return (role: string, n: number) => {
    switch (role) {
      case 'planner':
        return { output: 'PLAN: add a button' };
      case 'coder':
        return { output: 'PATCH v1' };
      case 'validator':
        return { output: n <= failRounds ? verdict('fail', [`problem ${n}`]) : verdict('pass') };
      case 'fixer':
        return { output: `PATCH v${n + 1}` };
      default:
        return { output: '?' };
    }
  };
}

describe('run engine', () => {
  it('runs steps, loops until the validator passes, and parks at the gate', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(1));
    stores.push(t.store);
    const { pipeline } = t.load();
    const runId = t.engine.start(pipeline, 'add a button');
    const state = await t.engine.drive(runId);

    expect(state.status).toBe('waiting');
    expect(state.openGate?.gateId).toBe('review');
    expect(t.fake.calls.map((c) => c.role)).toEqual(['planner', 'coder', 'validator', 'fixer', 'validator']);
    const types = t.store.events(runId).map((e) => e.type);
    expect(types.filter((x) => x === 'LoopIteration')).toHaveLength(2);
    expect(types).toContain('LoopExited');

    t.engine.decideGate(runId, { decision: 'approve' });
    const done = await t.engine.drive(runId);
    expect(done.status).toBe('succeeded');
    expect(done.spentUsd).toBeGreaterThan(0);
  });

  it('exits the loop right after the validator passes, without running the fixer', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    expect(t.fake.calls.map((c) => c.role)).toEqual(['planner', 'coder', 'validator']);
  });

  it('opens a gate when the loop hits max_iterations, and continues on approve', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(99));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    let state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('validate-fix:exhausted');
    expect(state.openGate?.reason).toBe('loop_exhausted');
    expect(t.fake.calls.filter((c) => c.role === 'validator')).toHaveLength(3);

    t.engine.decideGate(runId, { decision: 'approve' });
    state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
  });

  it('gives the fixer the latest findings and the history of earlier rounds', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(2));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    const secondFix = t.fake.calls.filter((c) => c.role === 'fixer')[1].req.messages;
    const tail = secondFix[secondFix.length - 1].content!;
    expect(tail).toContain('problem 2');
    expect(tail).toContain('Earlier rounds of this loop');
    expect(tail).toContain('problem 1');
  });

  it('sends a run back to an earlier step from a gate', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    t.engine.decideGate(runId, { decision: 'sendback', to: 'code' });
    const state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
    expect(state.openGate?.instance).toBe(2);
    expect(t.fake.calls.map((c) => c.role)).toEqual(['planner', 'coder', 'validator', 'coder', 'validator']);
    expect(state.steps.filter((s) => s.stepId === 'code').map((s) => s.iteration)).toEqual([1, 2]);
  });

  it('uses a human edit as the output for later steps', async () => {
    const files = {
      ...BUILD_FEATURE_FILES,
      'pipeline.yaml': `
steps:
  - id: plan
    agent: agents/planner.md
    inputs: [run.input]
    output: plan
  - gate: { id: check-plan, show: [plan] }
  - id: code
    agent: agents/coder.md
    inputs: [plan]
    output: patch
`,
    };
    const t = setup(files, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    await t.engine.drive(runId);
    t.engine.decideGate(runId, { decision: 'edit', text: 'PLAN: edited by human' });
    const state = await t.engine.drive(runId);
    expect(state.status).toBe('succeeded');
    const coderPrompt = t.fake.calls.find((c) => c.role === 'coder')!.req.messages.map((m) => m.content).join('\n');
    expect(coderPrompt).toContain('PLAN: edited by human');
    expect(coderPrompt).toContain('edited by a human');
  });

  it('asks in the terminal when attached, and a reject ends the run', async () => {
    const asked: string[] = [];
    const t = setup(BUILD_FEATURE_FILES, happyScript(0), {
      askGate: async (_s, gate): Promise<GateAnswer> => {
        asked.push(gate.gateId);
        return { decision: 'reject', note: 'no' };
      },
    });
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(asked).toEqual(['review']);
    expect(state.status).toBe('rejected');
  });

  it('retries a failing step, then fails the run when retries run out', async () => {
    const t = setup(BUILD_FEATURE_FILES, (role) => (role === 'planner' ? { output: '', error: 'boom' } : { output: 'x' }));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.status).toBe('failed');
    expect(t.fake.calls).toHaveLength(3); // default retries: 2
    expect(state.error).toContain('boom');
  });

  it('retries when a validator returns an invalid verdict', async () => {
    const t = setup(BUILD_FEATURE_FILES, (role, n) =>
      role === 'validator' ? { output: n === 1 ? '{"verdict":"maybe","findings":[]}' : verdict('pass') } : { output: 'x' },
    );
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
    const failed = t.store.events(runId).filter((e) => e.type === 'StepFailed');
    expect(failed).toHaveLength(1);
  });

  it('resumes after a crash mid-step by re-running only that step', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    // Simulate a process that died right after starting "plan".
    t.store.append(runId, [{ type: 'StepStarted', stepId: 'plan', iteration: 1, attempt: 1, provider: 'openai', model: 'm1' }]);
    const state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
    const planRuns = state.steps.filter((s) => s.stepId === 'plan');
    expect(planRuns.map((s) => [s.attempt, s.status])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    expect(t.fake.calls.filter((c) => c.role === 'planner')).toHaveLength(1);
  });

  it('pauses between steps and resumes', async () => {
    const t = setup(BUILD_FEATURE_FILES, (role) => {
      if (role === 'planner') t.engine.pause(runId);
      return happyScript(0)(role, 1);
    });
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    let state = await t.engine.drive(runId);
    expect(state.status).toBe('paused');
    expect(t.fake.calls).toHaveLength(1);
    t.engine.resume(runId);
    state = await t.engine.drive(runId);
    expect(state.openGate?.gateId).toBe('review');
  });

  it('applies a gate timeout with its default action', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'pipeline.yaml': BUILD_FEATURE.replace('show: [plan, patch, findings]', 'show: [plan]\n      timeout: 1s\n      on_timeout: approve') };
    const t = setup(files, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.openGate?.deadline).toBeTruthy();
    expect(t.engine.sweepTimeouts()).toEqual([]);
    expect(t.engine.applyTimeout(state, new Date(Date.now() + 2000))).toBe(true);
    expect((await t.engine.drive(runId)).status).toBe('succeeded');
  });

  it('lets only one process drive a run', async () => {
    const t = setup(BUILD_FEATURE_FILES, happyScript(0));
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    t.store.db.prepare('INSERT INTO run_locks (run_id, pid, host, acquired_at) VALUES (?, ?, ?, ?)').run(runId, process.ppid, (await import('node:os')).hostname(), '');
    await expect(t.engine.drive(runId)).rejects.toThrow(/already being driven/);
  });

  it('records notebook entries and tool calls', async () => {
    const files = { ...BUILD_FEATURE_FILES, 'agents/planner.md': agent('planner', 'tools: [notebook, write_file]\n') };
    const t = setup(files, (role, n) =>
      role === 'planner'
        ? {
            output: 'plan',
            tools: [
              { name: 'notebook_append', arguments: { key: 'db', value: 'use sqlite' } },
              { name: 'write_file', arguments: { path: 'src/a.txt', content: 'hi' } },
              { name: 'write_file', arguments: { path: '../escape.txt', content: 'no' } },
            ],
          }
        : happyScript(0)(role, n),
    );
    stores.push(t.store);
    const runId = t.engine.start(t.load().pipeline, 'x');
    const state = await t.engine.drive(runId);
    expect(state.notebook).toEqual([{ key: 'db', value: 'use sqlite', stepId: 'plan' }]);
    const tools = t.store.events(runId).filter((e) => e.type === 'ToolCalled');
    expect(tools.map((e) => e.type === 'ToolCalled' && e.ok)).toEqual([true, true, false]);
  });
});
