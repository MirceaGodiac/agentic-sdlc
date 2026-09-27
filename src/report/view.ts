import type { StoredEvent } from '../engine/events.js';
import type { RunState } from '../engine/state.js';
import { formatDuration, formatTokens, formatUsd } from '../util.js';

export interface ViewOptions {
  /** Last streamed text of the active step. */
  chunk?: string;
  color?: boolean;
  now?: number;
}

const ICON = { done: '✔', failed: '✘', running: '●', pending: '○', loop: '↻', waiting: '⏸' };

/** The live terminal view of a run (SAD §11). Pure: state + events in, lines out. */
export function renderRun(state: RunState, events: StoredEvent[], opts: ViewOptions = {}): string[] {
  const c = colors(opts.color ?? false);
  const now = opts.now ?? Date.now();
  const p = state.pipeline;
  const usage = events.filter((e): e is Extract<StoredEvent, { type: 'UsageRecorded' }> => e.type === 'UsageRecorded');
  const input = usage.reduce((a, e) => a + (e.usage.inputTokens ?? 0), 0);
  const cached = usage.reduce((a, e) => a + (e.usage.cacheReadTokens ?? 0), 0);
  const cap = state.budgetOverrideUsd ?? p.budget.maxCostUsd;
  const cost = `${formatUsd(state.spentUsd)}${cap != null ? ` / ${formatUsd(cap)}` : ''}`;
  const hit = input ? ` (cache hit ${Math.round((cached / input) * 100)}%)` : '';
  const lines = [`${c.bold(p.name)}  run ${state.runId}   ${cost}   ${formatTokens(state.tokens)} tokens${hit}   ${statusText(state, c)}`];

  const stepLine = (id: string, iteration: number | null, indent: string, model?: string, skipped = false) => {
    const recs = state.steps.filter((s) => s.stepId === id && (iteration == null || s.iteration === iteration));
    const last = recs[recs.length - 1];
    const cost = recs.reduce((a, r) => a + r.costUsd, 0);
    let icon = c.dim(ICON.pending);
    let detail = '';
    if (!last && skipped) {
      icon = c.dim('–');
      detail = c.dim('not needed this round');
    } else if (last?.status === 'succeeded') {
      icon = c.green(ICON.done);
      const done = events.find((e) => e.type === 'StepCompleted' && e.stepId === id && e.iteration === last.iteration && e.attempt === last.attempt);
      detail = done?.type === 'StepCompleted' ? formatDuration(done.durationMs) : '';
      if (done?.type === 'StepCompleted' && done.verdict) {
        const findings = countFindings(events, id, last.iteration);
        detail += `   ${done.verdict === 'pass' ? c.green('PASS') : c.red('FAIL')}${findings ? ` (${findings} findings)` : ''}`;
      }
    } else if (last?.status === 'running') {
      icon = c.yellow(ICON.running);
      detail = `running… ${formatDuration(now - Date.parse(last.startedAt))}`;
      if (opts.chunk) detail += c.dim(`  ${opts.chunk.replace(/\s+/g, ' ').slice(-60)}`);
    } else if (last?.status === 'failed') {
      icon = c.red(ICON.failed);
      detail = c.red(`failed (attempt ${last.attempt}): ${last.error?.slice(0, 60) ?? ''}`);
    }
    const attempts = recs.length > 1 ? c.dim(` ×${recs.length}`) : '';
    const iter = iteration == null && recs.length && recs[recs.length - 1].iteration > 1 ? ` #${recs[recs.length - 1].iteration}` : '';
    return `${indent}${icon} ${(id + iter).padEnd(14)}${(model ?? '').padEnd(12)}${recs.length ? formatUsd(cost).padStart(7) : ''.padStart(7)}   ${detail}${attempts}`;
  };

  for (const node of p.nodes) {
    if (node.kind === 'step') {
      lines.push(stepLine(node.id, null, '  ', shortModel(node.agent.model)));
    } else if (node.kind === 'loop') {
      const ls = state.loops[node.id];
      const exited = [...events].reverse().find((e) => e.type === 'LoopExited' && e.loopId === node.id);
      const active = state.cursor && p.nodes[state.cursor.node] === node;
      const round = ls ? ls.iteration - ls.roundStart + 1 : 0;
      let icon = c.dim(ICON.pending);
      let label = `max ${node.maxIterations}`;
      if (active) {
        icon = c.yellow(ICON.loop);
        label = `round ${round}/${node.maxIterations}`;
      } else if (exited?.type === 'LoopExited') {
        icon = exited.reason === 'condition' ? c.green(ICON.done) : c.red(ICON.failed);
        label = `${round} round${round === 1 ? '' : 's'}${exited.reason === 'max_iterations' ? ', limit reached' : ''}`;
      }
      lines.push(`  ${icon} ${node.id}  ${c.dim(label)}`);
      for (const s of node.steps) lines.push(stepLine(s.id, ls?.iteration ?? 0, '      ', shortModel(s.agent.model), !active && exited != null));
    } else {
      const decided = [...events].reverse().find((e) => e.type === 'GateDecided' && e.gateId === node.id);
      let icon = c.dim(ICON.pending);
      let detail = 'gate';
      if (state.openGate?.gateId === node.id) {
        icon = c.yellow(ICON.waiting);
        detail = c.yellow('waiting for a decision');
      } else if (decided?.type === 'GateDecided') {
        icon = decided.decision === 'reject' ? c.red(ICON.failed) : c.green(ICON.done);
        detail = `${decided.decision}${decided.by === 'timeout' ? ' (timeout)' : ''}${decided.to ? ` → ${decided.to}` : ''}`;
      }
      lines.push(`  ${icon} ${node.id.padEnd(14)}${detail}`);
    }
  }

  if (state.openGate) {
    const g = state.openGate;
    lines.push('', c.yellow(`⏸ ${g.message}`));
    if (g.deadline) lines.push(c.dim(`  times out ${g.deadline} → ${g.onTimeout}`));
    lines.push(c.dim(`  decide with: agentp approve|reject|edit|sendback ${state.runId}`));
  } else if (state.error) {
    lines.push('', c.red(state.error));
  }
  return lines;
}

function statusText(state: RunState, c: Colors): string {
  const s = state.status;
  if (s === 'succeeded') return c.green(s);
  if (s === 'running') return c.yellow(s);
  if (s === 'waiting' || s === 'paused') return c.yellow(s);
  return c.red(s);
}

export function countFindings(events: StoredEvent[], stepId: string, iteration: number): number {
  const e = events.find((x) => x.type === 'StepCompleted' && x.stepId === stepId && x.iteration === iteration);
  return e?.type === 'StepCompleted' ? (e.findingsCount ?? 0) : 0;
}

const shortModel = (m: string) => (m.length > 11 ? `${m.slice(0, 10)}…` : m);

type Colors = ReturnType<typeof colors>;
export function colors(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33'), cyan: wrap('36') };
}
