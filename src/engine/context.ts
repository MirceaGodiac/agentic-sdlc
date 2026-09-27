import type { Pipeline, StepNode } from '../pipeline/types.js';
import { loopOf } from '../pipeline/types.js';
import type { ChatMessage } from '../providers/types.js';
import type { Store } from '../store/store.js';
import { sha256, truncate } from '../util.js';
import type { ContextPartInfo } from './events.js';
import { latestOutput, type OutputVersion, type RunState } from './state.js';

/** Identical for every step of every pipeline, so it never breaks a shared cache prefix. */
export const PREAMBLE =
  'You are one step in an automated agent pipeline. Shared context comes first, then your own instructions, ' +
  'then the inputs that change for this step, and finally your task.';

const HEAD_CHARS = 4000;

interface Part {
  source: string;
  title: string;
  text: string;
  zone: 'prefix' | 'tail';
  substituted?: string;
}

export interface PriorContext {
  stepId: string;
  iteration: number;
  provider: string;
  model: string;
  prefixHashes: string[];
}

export interface BuiltContext {
  messages: ChatMessage[];
  parts: ContextPartInfo[];
  prefixHashes: string[];
  cacheSource: { stepId: string; iteration: number; sharedParts: number } | null;
  promptText: string;
}

export interface BuildArgs {
  state: RunState;
  step: StepNode;
  iteration: number;
  store: Store;
  readWorkspaceFile: (p: string) => string | null;
  prior: PriorContext[];
  /** Extra line appended to the task (e.g. a JSON format reminder for providers without structured output). */
  taskNote?: string;
}

/**
 * Context Builder. Assembles a step's declared inputs so that the parts that stay the same across steps
 * come first and the provider's prompt cache can serve them:
 *
 *   1. fixed preamble                    ┐
 *   2. pipeline shared_context files     │ shared prefix: identical for every step that
 *   3. run input, files, earlier outputs │ declares the same inputs, so one step's cache
 *      (oldest first)                    ┘ serves the next
 *   4. the agent's own instructions        stable for this agent (loop rounds reuse it)
 *   5. loop history, latest in-loop outputs, notebook   ┐ change every call
 *   6. the step's task                                  ┘
 *
 * `cache: isolated` agents skip the shared prefix entirely.
 */
export function buildContext(a: BuildArgs): BuiltContext {
  const { state, step, iteration, store } = a;
  const pipeline = state.pipeline;
  const isolated = step.agent.cache === 'isolated';
  const loop = loopOf(pipeline, step.id);
  const parts: Part[] = [];

  if (!isolated) {
    for (const f of pipeline.sharedContext) {
      parts.push({ source: `shared:${f.path}`, title: `Shared context: ${f.path}`, text: f.content, zone: 'prefix' });
    }
  }

  const outputs: { v: OutputVersion; zone: 'prefix' | 'tail' }[] = [];
  const tail: Part[] = [];
  for (const input of step.inputs) {
    if (input === 'run.input') {
      parts.push({ source: 'run.input', title: 'Run input', text: state.input, zone: 'prefix' });
    } else if (input.startsWith('file:')) {
      const p = input.slice(5);
      const text = a.readWorkspaceFile(p) ?? '[file not found in the run workspace]';
      parts.push({ source: input, title: `File: ${p}`, text, zone: 'prefix' });
    } else if (input === 'loop.history') {
      const text = loop ? loopHistory(state, pipeline, loop.id, iteration, store) : '';
      if (text) tail.push({ source: 'loop.history', title: 'Earlier rounds of this loop', text, zone: 'tail' });
    } else if (input === 'notebook') {
      const text = state.notebook.map((n) => `- ${n.key} (from ${n.stepId}): ${n.value}`).join('\n') || '(empty)';
      tail.push({ source: 'notebook', title: 'Run notebook', text, zone: 'tail' });
    } else {
      const v = latestOutput(state, input);
      if (!v) continue; // produced later in a loop that has not run yet
      // Anything the current loop rewrites goes in the tail even before the loop first rewrites it,
      // so every round sends the same prefix (shared context + agent instructions).
      const rewrittenByLoop = loop != null && loop.steps.some((s) => s.output === v.name);
      outputs.push({ v, zone: rewrittenByLoop ? 'tail' : 'prefix' });
    }
  }
  outputs.sort((x, y) => x.v.seq - y.v.seq);
  for (const { v, zone } of outputs) {
    const from = v.humanEdit ? 'edited by a human at a gate' : `from step ${v.stepId} #${v.iteration}`;
    const part: Part = { source: v.name, title: `Output "${v.name}" (${from})`, text: store.readArtifact(v.ref), zone };
    (zone === 'prefix' ? parts : tail).push(part);
  }

  const instructions: Part = {
    source: `agent:${step.agent.path}`,
    title: 'Your instructions',
    text: step.agent.instructions,
    zone: 'prefix',
  };
  const task = [step.task ?? `Produce the "${step.output}" output for this step, following your instructions.`, a.taskNote]
    .filter(Boolean)
    .join('\n\n');
  tail.push({ source: 'task', title: 'Task', text: task, zone: 'tail' });

  const canRead = step.agent.tools.includes('read_file');
  for (const part of [...parts, ...tail]) {
    if (part.text.length > pipeline.maxInputChars && part.source !== 'task') {
      const file = `${part.source.replace(/[^\w.-]+/g, '_')}.${step.id}.${iteration}.txt`;
      store.writeArtifact(state.runId, `context/${file}`, part.text);
      const how = canRead ? ` Full text: read_file("artifact:${file}").` : '';
      part.substituted = `truncated ${part.text.length} chars to ${HEAD_CHARS}; full text at runs/${state.runId}/context/${file}`;
      part.text = `${part.text.slice(0, HEAD_CHARS)}\n\n[Truncated: showing the first ${HEAD_CHARS} of ${part.text.length} chars.${how}]`;
    }
  }

  const section = (p: Part) => `## ${p.title}\n\n${p.text}`;
  const messages: ChatMessage[] = [];
  const prefixHashes: string[] = [];
  let running = PREAMBLE;
  if (isolated) {
    messages.push({ role: 'system', content: `${PREAMBLE}\n\n${section(instructions)}` });
  } else {
    messages.push({ role: 'system', content: PREAMBLE });
    if (parts.length) messages.push({ role: 'user', content: parts.map(section).join('\n\n') });
    for (const p of parts) {
      running += section(p);
      prefixHashes.push(sha256(running));
    }
    messages.push({ role: 'system', content: section(instructions) });
    running += section(instructions);
    prefixHashes.push(sha256(running));
  }
  messages.push({ role: 'user', content: tail.map(section).join('\n\n') });

  const info = (p: Part): ContextPartInfo => ({
    source: p.source,
    zone: p.zone,
    chars: p.text.length,
    ...(p.substituted ? { substituted: p.substituted } : {}),
  });

  return {
    messages,
    parts: [...parts, instructions, ...tail].map(info),
    prefixHashes,
    cacheSource: isolated ? null : findCacheSource(prefixHashes, a.prior, step),
    promptText: messages.map((m) => `=== ${m.role} ===\n${m.content}`).join('\n\n'),
  };
}

/** The earliest earlier step (same provider and model) that sent the longest shared prefix. */
function findCacheSource(hashes: string[], prior: PriorContext[], step: StepNode): BuiltContext['cacheSource'] {
  let best: BuiltContext['cacheSource'] = null;
  for (const c of prior) {
    if (c.provider !== step.agent.provider || c.model !== step.agent.model) continue;
    let n = 0;
    while (n < hashes.length && n < c.prefixHashes.length && hashes[n] === c.prefixHashes[n]) n++;
    if (n > 0 && (!best || n > best.sharedParts)) best = { stepId: c.stepId, iteration: c.iteration, sharedParts: n };
  }
  return best;
}

function loopHistory(state: RunState, pipeline: Pipeline, loopId: string, iteration: number, store: Store): string {
  const loopState = state.loops[loopId];
  const start = loopState?.roundStart ?? iteration;
  const rounds: string[] = [];
  for (let r = start; r < iteration; r++) {
    const lines = state.outputs
      .filter((o) => o.loopId === loopId && o.iteration === r && !o.humanEdit)
      .map((o) => `- ${o.stepId} → ${o.name}${o.verdict ? ` (${o.verdict})` : ''}:\n${indent(truncate(store.readArtifact(o.ref), 1500))}`);
    if (lines.length) rounds.push(`### Round ${r}\n${lines.join('\n')}`);
  }
  const kept = rounds.slice(-3);
  const omitted = rounds.length - kept.length;
  return [omitted > 0 ? `(${omitted} earlier rounds omitted)` : '', ...kept].filter(Boolean).join('\n\n');
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
