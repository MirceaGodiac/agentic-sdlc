import type { StoredEvent } from '../engine/events.js';
import type { RunState } from '../engine/state.js';
import type { Pipeline, TopNode } from '../pipeline/types.js';
import { formatTokens, formatUsd } from '../util.js';

const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const esc = (s: string) => s.replace(/"/g, '#quot;');

/** Pipeline mode: the designed flow, generated from the compiled graph. */
export function pipelineDiagram(p: Pipeline): string {
  const out = ['flowchart LR'];
  const entry = (n: TopNode) => (n.kind === 'loop' ? id(n.steps[0].id) : id(n.id));
  let prevExits: { from: string; label?: string }[] = [];
  const link = (to: string) => {
    for (const e of prevExits) out.push(`  ${e.from} -->${e.label ? `|${esc(e.label)}|` : ''} ${to}`);
  };

  for (const n of p.nodes) {
    if (n.kind === 'step') {
      out.push(`  ${id(n.id)}["${esc(n.id)}<br/><small>${esc(n.agent.model)}</small>"]`);
      link(entry(n));
      prevExits = [{ from: id(n.id) }];
    } else if (n.kind === 'gate') {
      out.push(`  ${id(n.id)}{{"⏸ ${esc(n.id)}"}}`);
      link(entry(n));
      prevExits = [{ from: id(n.id) }];
    } else {
      out.push(`  subgraph ${id(n.id)}_loop["↻ ${esc(n.id)} (max ${n.maxIterations})"]`);
      for (const s of n.steps) out.push(`    ${id(s.id)}["${esc(s.id)}<br/><small>${esc(s.agent.model)}</small>"]`);
      for (let i = 1; i < n.steps.length; i++) out.push(`    ${id(n.steps[i - 1].id)} --> ${id(n.steps[i].id)}`);
      const last = n.steps[n.steps.length - 1];
      if (n.steps.length > 1) out.push(`    ${id(last.id)} -->|next round| ${id(n.steps[0].id)}`);
      out.push('  end');
      link(entry(n));
      const cond = `${n.until.field.join('.')} ${n.until.op} ${String(n.until.value)}`;
      prevExits = [
        { from: id(n.until.stepId), label: cond },
        { from: `${id(n.id)}_loop`, label: n.onExhausted === 'gate' ? 'limit → gate' : 'limit → fail' },
      ];
    }
  }
  out.push('  done(["done"])');
  link('done');
  return out.join('\n');
}

/** Run mode: the path actually taken, rebuilt from the event stream. */
export function runDiagram(state: RunState, events: StoredEvent[], opts: { costs?: boolean } = {}): string {
  const out = ['flowchart LR'];
  const classes: Record<string, string[]> = { fail: [], active: [], waiting: [] };
  let prev: string | null = null;
  let edgeLabel: string | null = null;
  let n = 0;
  const add = (node: string, def: string, cls?: keyof typeof classes) => {
    out.push(`  ${def}`);
    if (prev) out.push(`  ${prev} -->${edgeLabel ? `|${esc(edgeLabel)}|` : ''} ${node}`);
    if (cls) classes[cls].push(node);
    prev = node;
    edgeLabel = null;
  };

  const stepCost = (stepId: string, iteration: number) => {
    const u = events.filter((e): e is Extract<StoredEvent, { type: 'UsageRecorded' }> => e.type === 'UsageRecorded' && e.stepId === stepId && e.iteration === iteration);
    const cost = u.reduce((a, e) => a + (e.costUsd ?? 0), 0);
    const tokens = u.reduce((a, e) => a + (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0), 0);
    const cached = u.reduce((a, e) => a + (e.usage.cacheReadTokens ?? 0), 0);
    const reported = u.some((e) => e.costUsd != null);
    return `<br/>${reported ? formatUsd(cost) : 'cost n/a'} · ${formatTokens(tokens)} tok${cached ? ` · ${formatTokens(cached)} cached` : ''}`;
  };
  const inLoop = new Set(state.pipeline.nodes.flatMap((x) => (x.kind === 'loop' ? x.steps.map((s) => s.id) : [])));

  const running = new Map<string, Extract<StoredEvent, { type: 'StepStarted' }>>();
  for (const e of events) {
    if (e.type === 'StepStarted') running.set(`${e.stepId}#${e.iteration}`, e);
    if (e.type === 'StepCompleted' || e.type === 'StepFailed') running.delete(`${e.stepId}#${e.iteration}`);
    if (e.type === 'StepCompleted') {
      const name = inLoop.has(e.stepId) || e.iteration > 1 ? `${e.stepId} #${e.iteration}` : e.stepId;
      let label = `${e.verdict === 'fail' ? '✘' : '✔'} ${name}`;
      if (e.verdict === 'fail') label += `<br/>${e.findingsCount ?? 0} findings`;
      else if (e.verdict) label += `<br/>${e.verdict}`;
      if (opts.costs) label += stepCost(e.stepId, e.iteration);
      add(`n${++n}`, `n${n}["${esc(label)}"]`, e.verdict === 'fail' ? 'fail' : undefined);
    } else if (e.type === 'StepFailed' && !e.willRetry) {
      add(`n${++n}`, `n${n}["✘ ${esc(e.stepId)}<br/>${esc(e.error.slice(0, 40))}"]`, 'fail');
    } else if (e.type === 'LoopExited' && e.reason === 'max_iterations') {
      edgeLabel = 'loop limit';
    } else if (e.type === 'GateDecided') {
      const g = `n${++n}`;
      const label = `${e.decision === 'reject' ? '✘' : '⏸'} ${e.gateId}<br/>${e.decision}${e.by === 'timeout' ? ' (timeout)' : ''}`;
      add(g, `${g}{{"${esc(label)}"}}`, e.decision === 'reject' ? 'fail' : undefined);
      if (e.decision === 'sendback') edgeLabel = `send back to ${e.to}`;
      if (e.decision === 'edit') edgeLabel = 'human edit';
    }
  }
  for (const e of running.values()) add(`n${++n}`, `n${n}["● ${esc(e.stepId)} #${e.iteration}<br/>running"]`, 'active');
  if (state.openGate) {
    add(`n${++n}`, `n${n}{{"⏸ ${esc(state.openGate.gateId)}<br/>waiting"}}`, 'waiting');
  }
  if (state.endedAt) {
    add('done', `done(["${state.status} · ${formatUsd(state.spentUsd)}"])`, state.status === 'succeeded' ? undefined : 'fail');
  }
  out.push('  classDef fail fill:#fdd,stroke:#c33');
  out.push('  classDef active fill:#ffd,stroke:#cc3');
  out.push('  classDef waiting fill:#def,stroke:#36c');
  for (const [cls, nodes] of Object.entries(classes)) if (nodes.length) out.push(`  class ${nodes.join(',')} ${cls}`);
  return out.join('\n');
}
