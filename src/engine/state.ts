import { type Pipeline, stepPositions } from '../pipeline/types.js';
import type { FinalStatus, GateReason, StoredEvent, Workspace } from './events.js';

export type RunStatus = 'running' | 'waiting' | 'paused' | 'cancelled' | FinalStatus;
export const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'rejected', 'budget_exceeded', 'cancelled'];

export interface Cursor {
  node: number;
  /** Loop round the cursor is in (loops only). */
  iteration?: number;
  /** Index of the next step inside the loop; undefined when the loop has not started a round yet. */
  inner?: number;
}

export interface OutputVersion {
  name: string;
  stepId: string;
  iteration: number;
  ref: string;
  verdict: string | null;
  seq: number;
  /** Loop the producing step belongs to, if any. */
  loopId: string | null;
  humanEdit: boolean;
}

export interface OpenGate {
  gateId: string;
  instance: number;
  reason: GateReason;
  show: string[];
  deadline: string | null;
  onTimeout: 'approve' | 'reject' | 'wait';
  message: string;
  openedAt: string;
}

export interface StepRecord {
  stepId: string;
  iteration: number;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  endedAt?: string;
  costUsd: number;
  error?: string;
}

export interface LoopState {
  iteration: number;
  /** First iteration of the current set of rounds (a send-back into the loop starts a new set). */
  roundStart: number;
}

export interface RunState {
  runId: string;
  pipeline: Pipeline;
  input: string;
  workspace: Workspace;
  status: RunStatus;
  cursor: Cursor | null;
  outputs: OutputVersion[];
  steps: StepRecord[];
  loops: Record<string, LoopState>;
  openGate: OpenGate | null;
  gateCounts: Record<string, number>;
  notebook: { key: string; value: string; stepId: string }[];
  spentUsd: number;
  tokens: number;
  budgetOverrideUsd: number | null;
  lastSha: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  lastSeq: number;
}

/** Rebuilds a run's state by replaying its events. The event log is the only source of truth. */
export function replay(runId: string, events: StoredEvent[]): RunState {
  const first = events[0];
  if (!first || first.type !== 'RunStarted') throw new Error(`run ${runId} has no RunStarted event`);
  const state: RunState = {
    runId,
    pipeline: first.pipeline,
    input: first.input,
    workspace: first.workspace,
    status: 'running',
    cursor: { node: 0 },
    outputs: [],
    steps: [],
    loops: {},
    openGate: null,
    gateCounts: {},
    notebook: [],
    spentUsd: 0,
    tokens: 0,
    budgetOverrideUsd: null,
    lastSha: first.workspace.git?.baseSha ?? null,
    startedAt: first.at,
    endedAt: null,
    error: null,
    lastSeq: first.seq,
  };
  for (const e of events.slice(1)) apply(state, e);
  return state;
}

export function apply(state: RunState, e: StoredEvent): void {
  const p = state.pipeline;
  state.lastSeq = e.seq;
  switch (e.type) {
    case 'RunStarted':
      break;
    case 'StepStarted':
      state.steps.push({
        stepId: e.stepId,
        iteration: e.iteration,
        attempt: e.attempt,
        status: 'running',
        startedAt: e.at,
        costUsd: 0,
      });
      break;
    case 'UsageRecorded': {
      state.spentUsd += e.costUsd ?? 0;
      state.tokens += (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
      const rec = findRecord(state, e.stepId, e.iteration, e.attempt);
      if (rec) rec.costUsd += e.costUsd ?? 0;
      break;
    }
    case 'StepCompleted': {
      const rec = findRecord(state, e.stepId, e.iteration, e.attempt);
      if (rec) Object.assign(rec, { status: 'succeeded', endedAt: e.at });
      const loop = p.nodes.find((n) => n.kind === 'loop' && n.steps.some((s) => s.id === e.stepId));
      state.outputs.push({
        name: e.output,
        stepId: e.stepId,
        iteration: e.iteration,
        ref: e.outputRef,
        verdict: e.verdict,
        seq: e.seq,
        loopId: loop?.id ?? null,
        humanEdit: false,
      });
      if (e.sha) state.lastSha = e.sha;
      const pos = stepPositions(p).get(e.stepId);
      if (pos && state.cursor) {
        if (pos.inner === undefined) state.cursor = { node: pos.node + 1 };
        else state.cursor = { node: pos.node, iteration: e.iteration, inner: pos.inner + 1 };
      }
      break;
    }
    case 'StepFailed': {
      const rec = findRecord(state, e.stepId, e.iteration, e.attempt);
      if (rec) Object.assign(rec, { status: 'failed', endedAt: e.at, error: e.error });
      break;
    }
    case 'LoopIteration': {
      const node = p.nodes.findIndex((n) => n.id === e.loopId);
      const prev = state.loops[e.loopId];
      const fresh = !prev || state.cursor?.node !== node || state.cursor.inner === undefined;
      state.loops[e.loopId] = { iteration: e.iteration, roundStart: fresh ? e.iteration : prev.roundStart };
      state.cursor = { node, iteration: e.iteration, inner: 0 };
      break;
    }
    case 'LoopExited': {
      const node = p.nodes.findIndex((n) => n.id === e.loopId);
      state.cursor = { node: node + 1 };
      break;
    }
    case 'GateOpened':
      state.status = 'waiting';
      state.gateCounts[e.gateId] = e.instance;
      state.openGate = {
        gateId: e.gateId,
        instance: e.instance,
        reason: e.reason,
        show: e.show,
        deadline: e.deadline,
        onTimeout: e.onTimeout,
        message: e.message,
        openedAt: e.at,
      };
      break;
    case 'GateDecided': {
      const gate = state.openGate;
      state.openGate = null;
      if (e.decision === 'reject') {
        state.status = 'rejected';
        state.cursor = null;
        state.endedAt = e.at;
        break;
      }
      state.status = 'running';
      if (e.decision === 'edit' && e.edit) {
        const prev = [...state.outputs].reverse().find((o) => o.name === e.edit!.output);
        state.outputs.push({
          name: e.edit.output,
          stepId: prev?.stepId ?? 'human',
          iteration: prev?.iteration ?? 0,
          ref: e.edit.ref,
          verdict: prev?.verdict ?? null,
          seq: e.seq,
          loopId: null,
          humanEdit: true,
        });
      }
      if (e.decision === 'sendback' && e.to) {
        const pos = stepPositions(p).get(e.to);
        if (pos && pos.inner === undefined) state.cursor = { node: pos.node };
        else if (pos) {
          const loopId = p.nodes[pos.node].id;
          const iteration = (state.loops[loopId]?.iteration ?? 0) + 1;
          state.loops[loopId] = { iteration, roundStart: iteration };
          state.cursor = { node: pos.node, iteration, inner: pos.inner };
        }
      } else if (gate?.reason === 'gate' && state.cursor) {
        // Approving (or editing at) a pipeline gate moves past it. Automatic gates leave the cursor where it is.
        state.cursor = { node: state.cursor.node + 1 };
      }
      if (gate?.reason === 'budget' && e.budgetUsd != null) state.budgetOverrideUsd = e.budgetUsd;
      break;
    }
    case 'NotebookAppended':
      state.notebook.push({ key: e.key, value: e.value, stepId: e.stepId });
      break;
    case 'RunPaused':
      state.status = 'paused';
      break;
    case 'RunResumed':
      state.status = state.openGate ? 'waiting' : 'running';
      break;
    case 'RunCancelled':
      state.status = 'cancelled';
      state.cursor = null;
      state.endedAt = e.at;
      state.error = e.reason ?? null;
      break;
    case 'RunFinished':
      state.status = e.status;
      state.cursor = null;
      state.endedAt = e.at;
      state.error = e.error ?? null;
      break;
    case 'ContextBuilt':
    case 'ModelCalled':
    case 'ToolCalled':
      break;
  }
}

function findRecord(state: RunState, stepId: string, iteration: number, attempt: number) {
  return state.steps.find((r) => r.stepId === stepId && r.iteration === iteration && r.attempt === attempt);
}

export function latestOutput(state: RunState, name: string): OutputVersion | undefined {
  for (let i = state.outputs.length - 1; i >= 0; i--) if (state.outputs[i].name === name) return state.outputs[i];
  return undefined;
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Human description of where the run is. */
export function currentLabel(state: RunState): string {
  if (state.openGate) return `gate ${state.openGate.gateId}`;
  if (!state.cursor) return '-';
  const node = state.pipeline.nodes[state.cursor.node];
  if (!node) return 'finishing';
  if (node.kind === 'loop') {
    const inner = node.steps[state.cursor.inner ?? 0];
    return `${node.id}/${inner?.id ?? 'check'} #${state.cursor.iteration ?? 1}`;
  }
  return node.id;
}
