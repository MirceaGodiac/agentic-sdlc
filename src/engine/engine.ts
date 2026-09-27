import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { desktopNotifier, type Notifier } from '../gates/notify.js';
import { findStep, type LoopNode, type Pipeline, type StepNode, stepPositions } from '../pipeline/types.js';
import type { ProviderRegistry } from '../providers/types.js';
import type { Store } from '../store/store.js';
import { meter, priceFor, type PriceTable } from '../usage/prices.js';
import { extractJson, newRunId, sleep, truncate } from '../util.js';
import { type Caps, checkAfter, planCall, type Spent } from './budget.js';
import { buildContext, type PriorContext } from './context.js';
import type { GateReason, RunEvent, StoredEvent } from './events.js';
import { isTerminal, type OpenGate, replay, type RunState } from './state.js';
import { executeTool, toolDefs } from './tools.js';
import { behindBase, commitStep, createWorkspace } from './workspace.js';

export type GateAnswer =
  | { decision: 'approve'; budgetUsd?: number; note?: string }
  | { decision: 'reject'; note?: string }
  | { decision: 'edit'; text: string; output?: string; note?: string }
  | { decision: 'sendback'; to: string; note?: string };

export interface EngineHooks {
  onEvent?(e: StoredEvent): void;
  onChunk?(stepId: string, text: string): void;
  /**
   * Asks a human to decide an open gate in the terminal. Resolve null to leave the gate open and detach.
   * The signal aborts when the gate is decided elsewhere (another CLI process) or times out.
   */
  askGate?(state: RunState, gate: OpenGate, signal: AbortSignal): Promise<GateAnswer | null>;
}

export interface EngineOptions {
  store: Store;
  providers: ProviderRegistry;
  prices: PriceTable;
  notifier?: Notifier;
  globalDailyCapUsd?: number;
  /** Base delay between retries of a failed step; doubles each time. */
  retryBaseMs?: number;
  /** How often a waiting or running driver checks the store for decisions made by other processes. */
  pollMs?: number;
  hooks?: EngineHooks;
}

class BudgetPause extends Error {}
class BudgetExceeded extends Error {}
class Aborted extends Error {}

export class Engine {
  private store: Store;
  private hooks: EngineHooks;
  private notifier: Notifier;
  private pollMs: number;

  constructor(private opts: EngineOptions) {
    this.store = opts.store;
    this.hooks = opts.hooks ?? {};
    this.notifier = opts.notifier ?? desktopNotifier;
    this.pollMs = opts.pollMs ?? 1000;
  }

  setHooks(hooks: EngineHooks) {
    this.hooks = hooks;
  }

  /** Providers in this pipeline that cannot report usage, so a cost or token cap cannot be enforced for them. */
  unmeteredProviders(p: Pipeline): string[] {
    const ids = new Set(
      p.nodes.flatMap((n) => (n.kind === 'step' ? [n] : n.kind === 'loop' ? n.steps : [])).map((s) => s.agent.provider),
    );
    return [...ids].filter((id) => !this.opts.providers[id].capabilities().reportsUsage);
  }

  start(pipeline: Pipeline, input: string, opts: { repo?: string | null } = {}): string {
    const runId = newRunId();
    const workspace = createWorkspace(this.store.home, runId, opts.repo ?? null);
    this.emit(runId, [{ type: 'RunStarted', pipeline, input, workspace }]);
    return runId;
  }

  load(runId: string): { state: RunState; events: StoredEvent[] } {
    const events = this.store.events(runId);
    return { state: replay(runId, events), events };
  }

  private emit(runId: string, events: RunEvent[]): StoredEvent[] {
    const stored = this.store.append(runId, events);
    for (const e of stored) this.hooks.onEvent?.(e);
    return stored;
  }

  /** Runs a run forward until it finishes, pauses, or waits at a gate nobody is answering here. */
  async drive(runId: string): Promise<RunState> {
    if (!this.store.acquireLock(runId)) {
      throw new Error(`run ${runId} is already being driven by process ${this.store.lockHolder(runId)}`);
    }
    try {
      this.recoverInterrupted(runId);
      for (;;) {
        const { state, events } = this.load(runId);
        if (isTerminal(state.status) || state.status === 'paused') return state;
        if (state.openGate) {
          if (this.applyTimeout(state)) continue;
          if (!this.hooks.askGate) return state;
          const detached = await this.waitAtGate(state);
          if (detached) return this.load(runId).state;
          continue;
        }
        await this.advance(state, events);
      }
    } finally {
      this.store.releaseLock(runId);
    }
  }

  /** A step left "running" by a process that died is marked failed so the retry is visible in the log. */
  private recoverInterrupted(runId: string) {
    const { state } = this.load(runId);
    const dangling = state.steps.filter((s) => s.status === 'running');
    if (dangling.length) {
      this.emit(
        runId,
        dangling.map((s) => ({
          type: 'StepFailed' as const,
          stepId: s.stepId,
          iteration: s.iteration,
          attempt: s.attempt,
          error: 'interrupted: the process driving this run exited mid-step',
          willRetry: true,
          cause: 'interrupted' as const,
        })),
      );
    }
  }

  private async advance(state: RunState, events: StoredEvent[]) {
    const { runId, pipeline } = state;
    const c = state.cursor!;
    const node = pipeline.nodes[c.node];
    if (!node) {
      this.emit(runId, [{ type: 'RunFinished', status: 'succeeded' }]);
      return;
    }
    if (node.kind === 'gate') {
      const deadline = node.timeoutMs != null ? new Date(Date.now() + node.timeoutMs).toISOString() : null;
      this.openGate(state, node.id, 'gate', node.show, `Review "${node.id}"`, deadline, node.onTimeout);
      return;
    }
    if (node.kind === 'step') {
      const iteration = state.steps.filter((s) => s.stepId === node.id && s.status === 'succeeded').length + 1;
      await this.runStep(state, events, node, iteration);
      return;
    }
    // Loop
    const loopState = state.loops[node.id];
    if (c.inner === undefined) {
      this.emit(runId, [{ type: 'LoopIteration', loopId: node.id, iteration: (loopState?.iteration ?? 0) + 1 }]);
      return;
    }
    const iteration = c.iteration!;
    const prev = node.steps[c.inner - 1];
    if (prev && prev.id === node.until.stepId && this.conditionMet(state, node, iteration)) {
      this.emit(runId, [{ type: 'LoopExited', loopId: node.id, iteration, reason: 'condition' }]);
      return;
    }
    if (c.inner < node.steps.length) {
      await this.runStep(state, events, node.steps[c.inner], iteration);
      return;
    }
    const rounds = iteration - (loopState?.roundStart ?? 1) + 1;
    if (rounds < node.maxIterations) {
      this.emit(runId, [{ type: 'LoopIteration', loopId: node.id, iteration: iteration + 1 }]);
      return;
    }
    this.emit(runId, [{ type: 'LoopExited', loopId: node.id, iteration, reason: 'max_iterations' }]);
    const msg = `Loop "${node.id}" hit max_iterations (${node.maxIterations}) without meeting: ${node.until.source}`;
    if (node.onExhausted === 'fail') {
      this.emit(runId, [{ type: 'RunFinished', status: 'failed', error: msg }]);
    } else {
      const show = [...new Set(node.steps.map((s) => s.output))];
      this.openGate(this.load(runId).state, `${node.id}:exhausted`, 'loop_exhausted', show, msg, null, 'wait');
    }
  }

  conditionMet(state: RunState, loop: LoopNode, iteration: number): boolean {
    const out = state.outputs.find((o) => o.stepId === loop.until.stepId && o.iteration === iteration && !o.humanEdit);
    if (!out) return false;
    let value: unknown;
    try {
      value = extractJson(this.store.readArtifact(out.ref));
    } catch {
      return false;
    }
    for (const f of loop.until.field) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[f] : undefined;
    const equal = value === loop.until.value;
    return loop.until.op === '==' ? equal : !equal;
  }

  private openGate(
    state: RunState,
    gateId: string,
    reason: GateReason,
    show: string[],
    message: string,
    deadline: string | null,
    onTimeout: 'approve' | 'reject' | 'wait',
  ) {
    const instance = (state.gateCounts[gateId] ?? 0) + 1;
    this.emit(state.runId, [
      { type: 'GateOpened', gateId, instance, reason, show, deadline, onTimeout, message, behindBase: behindBase(state.workspace) },
    ]);
    if (!this.hooks.askGate) {
      this.notifier.notify(`agentp: ${state.pipeline.name} is waiting`, `run ${state.runId} · ${message} · agentp gates`);
    }
  }

  // ---------------------------------------------------------------- steps

  private async runStep(state: RunState, events: StoredEvent[], step: StepNode, iteration: number) {
    const { runId, pipeline, workspace } = state;
    const attempts = state.steps.filter((s) => s.stepId === step.id && s.iteration === iteration);
    const attempt = attempts.length + 1;
    const adapter = this.opts.providers[step.agent.provider];
    const caps = adapter.capabilities();
    const schema = step.agent.outputSchema;

    const prior: PriorContext[] = events
      .filter((e): e is Extract<StoredEvent, { type: 'ContextBuilt' }> => e.type === 'ContextBuilt')
      .map((e) => {
        const s = findStep(pipeline, e.stepId);
        return { stepId: e.stepId, iteration: e.iteration, provider: s?.agent.provider ?? '', model: s?.agent.model ?? '', prefixHashes: e.prefixHashes };
      });
    const built = buildContext({
      state,
      step,
      iteration,
      store: this.store,
      prior,
      readWorkspaceFile: (p) => {
        const full = path.resolve(workspace.path, p);
        return full.startsWith(workspace.path + path.sep) && existsSync(full) ? readFileSync(full, 'utf8') : null;
      },
      taskNote:
        schema && !caps.structuredOutput
          ? `Reply with only a JSON object that matches this JSON schema:\n${JSON.stringify(schema.schema)}`
          : undefined,
    });
    const promptRef = this.store.writeArtifact(runId, `prompts/${step.id}.${iteration}.${attempt}.txt`, built.promptText);
    this.emit(runId, [
      {
        type: 'ContextBuilt',
        stepId: step.id,
        iteration,
        attempt,
        parts: built.parts,
        promptRef,
        prefixHashes: built.prefixHashes,
        cacheSource: built.cacheSource,
      },
      { type: 'StepStarted', stepId: step.id, iteration, attempt, provider: step.agent.provider, model: step.agent.model },
    ]);

    const started = Date.now();
    const ac = new AbortController();
    const watcher = setInterval(() => {
      const row = this.store.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
      if (row.status === 'cancelled') ac.abort(new Aborted('run cancelled'));
    }, this.pollMs);

    const price = priceFor(this.opts.prices, step.agent.provider, step.agent.model);
    const today = startOfDay();
    const spent: Spent = {
      runUsd: state.spentUsd,
      runTokens: state.tokens,
      pipelineDayUsd: this.store.spentSince(today, pipeline.name),
      globalDayUsd: this.store.spentSince(today),
    };
    const budgetCaps: Caps = {
      runUsd: state.budgetOverrideUsd ?? pipeline.budget.maxCostUsd,
      runTokens: pipeline.budget.maxTokens,
      pipelineDayUsd: pipeline.budget.maxCostUsdPerDay,
      globalDayUsd: this.opts.globalDailyCapUsd,
    };
    const notebook = state.notebook.map((n) => ({ ...n }));
    const base = { stepId: step.id, iteration, attempt };

    try {
      const result = await adapter.run(
        {
          model: step.agent.model,
          temperature: step.agent.temperature,
          messages: built.messages,
          outputSchema: caps.structuredOutput ? schema : undefined,
          tools: caps.customTools ? toolDefs(step.agent.tools) : [],
          maxTurns: step.agent.maxTurns,
          maxOutputTokens: step.agent.maxOutputTokens,
          workspace: workspace.path,
          signal: ac.signal,
          beforeCall: async ({ turn, estimatedInputTokens, maxOutputTokens }) => {
            if (ac.signal.aborted) throw new Aborted('run cancelled');
            let allowed = maxOutputTokens;
            if (caps.reportsUsage) {
              const plan = planCall(budgetCaps, spent, price, this.opts.prices.per, estimatedInputTokens, maxOutputTokens);
              if (!plan.ok) throw new BudgetPause(plan.reason);
              allowed = plan.maxOutputTokens;
            }
            this.emit(runId, [{ type: 'ModelCalled', ...base, turn, estimatedInputTokens, maxOutputTokens: allowed }]);
            return allowed;
          },
          afterCall: async ({ turn, usage }) => {
            const m = meter(usage, price, this.opts.prices);
            this.emit(runId, [
              { type: 'UsageRecorded', ...base, turn, provider: step.agent.provider, model: step.agent.model, usage, ...m },
            ]);
            const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
            spent.runUsd += m.costUsd ?? 0;
            spent.runTokens += tokens;
            spent.pipelineDayUsd += m.costUsd ?? 0;
            spent.globalDayUsd += m.costUsd ?? 0;
            const over = checkAfter(budgetCaps, spent);
            if (over) throw new BudgetExceeded(over);
          },
          executeTool: async (call) => {
            let ok = true;
            let out: string;
            try {
              out = await executeTool(call, step.agent.tools, {
                workspace: workspace.path,
                artifactDir: path.join(this.store.runDir(runId), 'context'),
                signal: ac.signal,
                notebookRead: () => notebook.map((n) => `- ${n.key} (from ${n.stepId}): ${n.value}`).join('\n'),
                notebookAppend: (key, value) => {
                  notebook.push({ key, value, stepId: step.id });
                  this.emit(runId, [{ type: 'NotebookAppended', stepId: step.id, iteration, key, value }]);
                },
              });
            } catch (err) {
              ok = false;
              out = `error: ${(err as Error).message}`;
            }
            this.emit(runId, [
              { type: 'ToolCalled', stepId: step.id, iteration, name: call.name, args: truncate(call.arguments, 2000), ok, result: truncate(out, 2000) },
            ]);
            return out;
          },
        },
        (chunk) => this.hooks.onChunk?.(step.id, chunk.text),
      );

      let text = result.output;
      let verdict: string | null = null;
      let findingsCount: number | null = null;
      if (schema) {
        const json = extractJson(text) as Record<string, unknown>;
        if (schema.name === 'verdict' && json.verdict !== 'pass' && json.verdict !== 'fail') {
          throw new Error(`structured output must have verdict "pass" or "fail", got ${JSON.stringify(json.verdict)}`);
        }
        verdict = typeof json.verdict === 'string' ? json.verdict : null;
        findingsCount = Array.isArray(json.findings) ? json.findings.length : null;
        text = JSON.stringify(json, null, 2);
      }
      const outputRef = this.store.writeArtifact(runId, `outputs/${step.id}.${iteration}.${attempt}.${schema ? 'json' : 'md'}`, text);
      const sha = commitStep(workspace, `agentp ${runId}: ${step.id} #${iteration}`);
      this.emit(runId, [{ type: 'StepCompleted', ...base, output: step.output, outputRef, verdict, findingsCount, sha, durationMs: Date.now() - started }]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof BudgetPause) {
        this.emit(runId, [{ type: 'StepFailed', ...base, error: `budget: ${error.message}`, willRetry: true, cause: 'budget' }]);
        this.openGate(
          this.load(runId).state,
          'budget',
          'budget',
          [],
          `Budget reached before "${step.id}": ${error.message}. Approve with a higher run cap, or reject.`,
          null,
          'wait',
        );
      } else if (error instanceof BudgetExceeded) {
        this.emit(runId, [
          { type: 'StepFailed', ...base, error: `budget: ${error.message}`, willRetry: false, cause: 'budget' },
          { type: 'RunFinished', status: 'budget_exceeded', error: error.message },
        ]);
      } else if (ac.signal.aborted) {
        this.emit(runId, [{ type: 'StepFailed', ...base, error: 'aborted: run cancelled', willRetry: false, cause: 'aborted' }]);
      } else {
        const failures = this.store
          .events(runId)
          .filter((e) => e.type === 'StepFailed' && e.stepId === step.id && e.iteration === iteration && (e.cause ?? 'error') === 'error').length;
        const willRetry = failures < step.retries;
        this.emit(runId, [{ type: 'StepFailed', ...base, error: error.message, willRetry, cause: 'error' }]);
        if (!willRetry) {
          this.emit(runId, [
            { type: 'RunFinished', status: 'failed', error: `step "${step.id}" failed after ${failures + 1} attempt(s): ${error.message}` },
          ]);
        } else {
          await sleep((this.opts.retryBaseMs ?? 2000) * 2 ** failures);
        }
      }
    } finally {
      clearInterval(watcher);
    }
  }

  // ---------------------------------------------------------------- gates & control

  /** Records a gate decision. Throws if the run has no open gate or the answer is invalid. */
  decideGate(runId: string, answer: GateAnswer, by: 'human' | 'timeout' = 'human'): StoredEvent {
    const { state } = this.load(runId);
    const gate = state.openGate;
    if (!gate) throw new Error(`run ${runId} has no open gate`);
    const base = { type: 'GateDecided' as const, gateId: gate.gateId, instance: gate.instance, by, note: answer.note };
    let event: RunEvent;
    switch (answer.decision) {
      case 'approve':
        if (gate.reason === 'budget' && answer.budgetUsd == null) {
          throw new Error('this is a budget gate: approve it with a new run cap (--budget <usd>), or reject');
        }
        event = { ...base, decision: 'approve', budgetUsd: answer.budgetUsd };
        break;
      case 'reject':
        event = { ...base, decision: 'reject' };
        break;
      case 'edit': {
        const output = answer.output ?? [...gate.show].reverse().find((n) => state.outputs.some((o) => o.name === n));
        if (!output) throw new Error('nothing to edit at this gate: name the output to replace');
        if (!gate.show.includes(output) && !state.outputs.some((o) => o.name === output)) throw new Error(`unknown output "${output}"`);
        const ref = this.store.writeArtifact(runId, `outputs/edit.${gate.gateId.replace(/\W/g, '_')}.${gate.instance}.${output}.md`, answer.text);
        event = { ...base, decision: 'edit', edit: { output, ref } };
        break;
      }
      case 'sendback':
        if (!stepPositions(state.pipeline).has(answer.to)) throw new Error(`unknown step "${answer.to}"`);
        event = { ...base, decision: 'sendback', to: answer.to };
        break;
    }
    return this.emit(runId, [event])[0];
  }

  /** Applies a gate's timeout action if its deadline has passed. Returns true if it decided the gate. */
  applyTimeout(state: RunState, now = new Date()): boolean {
    const g = state.openGate;
    if (!g?.deadline || g.onTimeout === 'wait' || new Date(g.deadline) > now) return false;
    this.decideGate(state.runId, g.onTimeout === 'approve' ? { decision: 'approve' } : { decision: 'reject', note: 'timed out' }, 'timeout');
    return true;
  }

  /** Checks every open gate's deadline. Called by any CLI command, so timeouts survive restarts. */
  sweepTimeouts(): string[] {
    const decided: string[] = [];
    for (const g of this.store.openGates()) {
      if (this.applyTimeout(this.load(g.run_id).state)) decided.push(g.run_id);
    }
    return decided;
  }

  private async waitAtGate(state: RunState): Promise<boolean> {
    const gate = state.openGate!;
    const ac = new AbortController();
    const poll = setInterval(() => {
      const latest = this.load(state.runId).state;
      if (latest.openGate?.gateId !== gate.gateId || latest.openGate.instance !== gate.instance || isTerminal(latest.status)) {
        ac.abort();
      } else if (this.applyTimeout(latest)) ac.abort();
    }, this.pollMs);
    try {
      const answer = await this.hooks.askGate!(state, gate, ac.signal);
      if (ac.signal.aborted) return false;
      if (!answer) return true;
      this.decideGate(state.runId, answer);
      return false;
    } catch (err) {
      if (ac.signal.aborted) return false;
      throw err;
    } finally {
      clearInterval(poll);
    }
  }

  pause(runId: string) {
    const { state } = this.load(runId);
    if (state.status !== 'running' && state.status !== 'waiting') throw new Error(`run is ${state.status}; only running runs can be paused`);
    this.emit(runId, [{ type: 'RunPaused' }]);
  }

  resume(runId: string) {
    const { state } = this.load(runId);
    if (state.status === 'paused') this.emit(runId, [{ type: 'RunResumed' }]);
    else if (isTerminal(state.status)) throw new Error(`run already ${state.status}`);
  }

  cancel(runId: string, reason?: string) {
    const { state } = this.load(runId);
    if (isTerminal(state.status)) throw new Error(`run already ${state.status}`);
    this.emit(runId, [{ type: 'RunCancelled', reason }]);
  }
}

function startOfDay(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
