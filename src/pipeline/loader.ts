import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseDuration, sha256 } from '../util.js';
import {
  type AgentDef,
  type Budget,
  type Condition,
  type GateNode,
  type LoopNode,
  type OutputSchema,
  type Pipeline,
  PROVIDERS,
  type ProviderId,
  type StepNode,
  TOOL_NAMES,
  type ToolName,
  type TopNode,
} from './types.js';

export class PipelineError extends Error {
  constructor(public problems: string[]) {
    super(`invalid pipeline:\n  - ${problems.join('\n  - ')}`);
  }
}

export interface LoadResult {
  pipeline: Pipeline;
  warnings: string[];
}

export const VERDICT_SCHEMA: OutputSchema = {
  name: 'verdict',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      findings: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'findings'],
    additionalProperties: false,
  },
};

const ID = /^[A-Za-z][\w-]*$/;
const RESERVED_INPUTS = new Set(['run.input', 'loop.history', 'notebook']);

type Raw = Record<string, unknown>;

/** Loads a pipeline YAML file with its agent `.md` files, validates it and compiles it. */
export function loadPipeline(file: string, cwd = process.cwd()): LoadResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const pipelineFile = path.resolve(cwd, file);
  if (!existsSync(pipelineFile)) throw new PipelineError([`pipeline file not found: ${file}`]);

  let raw: Raw;
  try {
    raw = (YAML.parse(readFileSync(pipelineFile, 'utf8')) ?? {}) as Raw;
  } catch (err) {
    throw new PipelineError([`cannot parse YAML: ${(err as Error).message}`]);
  }

  // Paths resolve relative to the pipeline file first, then the current directory.
  const resolvePath = (p: string): string | null => {
    for (const base of [path.dirname(pipelineFile), cwd]) {
      const full = path.resolve(base, p);
      if (existsSync(full)) return full;
    }
    return null;
  };

  const name = typeof raw.name === 'string' ? raw.name : path.basename(pipelineFile).replace(/\.ya?ml$/, '');
  const budget = parseBudget(raw.budget, problems);
  const maxInputChars = typeof raw.max_input_chars === 'number' ? raw.max_input_chars : 60_000;
  const defaultRetries = typeof raw.retries === 'number' ? raw.retries : 2;

  const sharedContext = asArray(raw.shared_context).flatMap((p) => {
    if (typeof p !== 'string') {
      problems.push('shared_context entries must be file paths');
      return [];
    }
    const full = resolvePath(p);
    if (!full) {
      problems.push(`shared_context file not found: ${p}`);
      return [];
    }
    return [{ path: p, content: readFileSync(full, 'utf8') }];
  });

  const agentCache = new Map<string, AgentDef | null>();
  const loadAgentOnce = (p: string, where: string): AgentDef | null => {
    if (!agentCache.has(p)) agentCache.set(p, loadAgent(p, resolvePath, problems, where));
    return agentCache.get(p)!;
  };

  const parseStep = (s: Raw, where: string): StepNode | null => {
    const id = String(s.id ?? '');
    if (!ID.test(id)) problems.push(`${where}: step needs an "id" (letters, digits, - or _)`);
    if (typeof s.agent !== 'string') {
      problems.push(`step "${id}": "agent" must be a path to a .md file`);
      return null;
    }
    const agent = loadAgentOnce(s.agent, `step "${id}"`);
    const output = typeof s.output === 'string' ? s.output : id;
    if (!ID.test(output)) problems.push(`step "${id}": invalid output name "${output}"`);
    const inputs = asArray(s.inputs).map(String);
    if (!agent) return null;
    return {
      kind: 'step',
      id,
      agent,
      inputs,
      output,
      task: typeof s.task === 'string' ? s.task : undefined,
      retries: typeof s.retries === 'number' ? s.retries : defaultRetries,
    };
  };

  const nodes: TopNode[] = [];
  asArray(raw.steps).forEach((entry, i) => {
    const where = `steps[${i}]`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where}: must be a step, loop or gate`);
      return;
    }
    const e = entry as Raw;
    if (e.loop) {
      const l = e.loop as Raw;
      const id = String(l.id ?? '');
      if (!ID.test(id)) problems.push(`${where}: loop needs an "id"`);
      const maxIterations = l.max_iterations;
      if (typeof maxIterations !== 'number' || maxIterations < 1 || !Number.isInteger(maxIterations)) {
        problems.push(`loop "${id}": "max_iterations" is required and must be a positive integer`);
      }
      const steps = asArray(l.steps).flatMap((s, j) => {
        const st = s && typeof s === 'object' ? parseStep(s as Raw, `loop "${id}" steps[${j}]`) : null;
        return st ? [st] : [];
      });
      if (steps.length === 0) problems.push(`loop "${id}": needs at least one step`);
      const until = typeof l.until === 'string' ? parseCondition(l.until) : null;
      if (!until) problems.push(`loop "${id}": "until" must look like: <step>.<field> == "value"`);
      else {
        const target = steps.find((s) => s.id === until.stepId);
        if (!target) problems.push(`loop "${id}": until refers to "${until.stepId}", which is not a step in this loop`);
        else if (!target.agent.outputSchema) {
          problems.push(
            `loop "${id}": step "${target.id}" must declare output_schema so the exit condition tests a field, not free text`,
          );
        }
      }
      const onExhausted = l.on_exhausted === 'fail' ? 'fail' : 'gate';
      const loop: LoopNode = {
        kind: 'loop',
        id,
        maxIterations: typeof maxIterations === 'number' ? maxIterations : 1,
        until: until ?? { source: '', stepId: '', field: [], op: '==', value: null },
        onExhausted,
        steps,
      };
      nodes.push(loop);
    } else if (e.gate) {
      const g = e.gate as Raw;
      const id = String(g.id ?? '');
      if (!ID.test(id)) problems.push(`${where}: gate needs an "id"`);
      let timeoutMs: number | null = null;
      if (g.timeout != null) {
        try {
          timeoutMs = parseDuration(g.timeout as string);
        } catch (err) {
          problems.push(`gate "${id}": ${(err as Error).message}`);
        }
      }
      const onTimeout = (g.on_timeout ?? 'wait') as GateNode['onTimeout'];
      if (!['approve', 'reject', 'wait'].includes(onTimeout)) {
        problems.push(`gate "${id}": on_timeout must be approve, reject or wait`);
      }
      nodes.push({ kind: 'gate', id, show: asArray(g.show).map(String), timeoutMs, onTimeout });
    } else {
      const st = parseStep(e, where);
      if (st) nodes.push(st);
    }
  });
  if (nodes.length === 0 && problems.length === 0) problems.push('pipeline has no steps');

  checkReferences(nodes, problems);
  if (problems.length) throw new PipelineError(problems);

  cachePlanner(nodes, warnings);

  const body = { name, budget, sharedContext, maxInputChars, nodes };
  const pipeline: Pipeline = { ...body, file: path.relative(cwd, pipelineFile) || pipelineFile, hash: sha256(JSON.stringify(body)) };
  return { pipeline, warnings };
}

function loadAgent(
  p: string,
  resolvePath: (p: string) => string | null,
  problems: string[],
  where: string,
): AgentDef | null {
  const full = resolvePath(p);
  if (!full) {
    problems.push(`${where}: agent file not found: ${p}`);
    return null;
  }
  const text = readFileSync(full, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = (fm ? YAML.parse(fm[1]) ?? {} : {}) as Raw;
  const instructions = (fm ? fm[2] : text).trim();
  const before = problems.length;

  const provider = meta.provider as ProviderId;
  if (!PROVIDERS.includes(provider)) problems.push(`${p}: "provider" must be one of ${PROVIDERS.join(', ')}`);
  if (typeof meta.model !== 'string' || !meta.model) problems.push(`${p}: "model" is required`);
  if (!instructions) problems.push(`${p}: agent has no instructions`);

  let outputSchema: OutputSchema | undefined;
  if (meta.output_schema === 'verdict') outputSchema = VERDICT_SCHEMA;
  else if (typeof meta.output_schema === 'string') {
    const schemaFile = resolvePath(meta.output_schema) ?? path.resolve(path.dirname(full), meta.output_schema);
    if (!existsSync(schemaFile)) problems.push(`${p}: output_schema file not found: ${meta.output_schema}`);
    else {
      try {
        outputSchema = {
          name: path.basename(schemaFile).replace(/\.json$/, '').replace(/\W/g, '_'),
          schema: JSON.parse(readFileSync(schemaFile, 'utf8')),
        };
      } catch (err) {
        problems.push(`${p}: output_schema is not valid JSON: ${(err as Error).message}`);
      }
    }
  }

  const tools = asArray(meta.tools).map(String) as ToolName[];
  for (const t of tools) if (!TOOL_NAMES.includes(t)) problems.push(`${p}: unknown tool "${t}" (known: ${TOOL_NAMES.join(', ')})`);
  const cache = meta.cache ?? 'shared';
  if (cache !== 'shared' && cache !== 'isolated') problems.push(`${p}: "cache" must be shared or isolated`);

  if (problems.length > before) return null;
  return {
    path: p,
    provider,
    model: meta.model as string,
    temperature: typeof meta.temperature === 'number' ? meta.temperature : undefined,
    outputSchema,
    cache: cache as AgentDef['cache'],
    tools,
    maxOutputTokens: typeof meta.max_output_tokens === 'number' ? meta.max_output_tokens : 8192,
    maxTurns: typeof meta.max_turns === 'number' ? meta.max_turns : 25,
    instructions,
  };
}

export function parseCondition(expr: string): Condition | null {
  const m = /^\s*([A-Za-z][\w-]*)\.([\w.]+)\s*(==|!=)\s*(.+?)\s*$/.exec(expr);
  if (!m) return null;
  let value: unknown = m[4];
  try {
    value = JSON.parse(m[4]);
  } catch {
    value = m[4].replace(/^'(.*)'$/, '$1');
  }
  return { source: expr, stepId: m[1], field: m[2].split('.'), op: m[3] as Condition['op'], value };
}

function parseBudget(raw: unknown, problems: string[]): Budget {
  if (raw == null) return {};
  if (typeof raw !== 'object') {
    problems.push('budget must be a mapping');
    return {};
  }
  const b = raw as Raw;
  const num = (k: string) => {
    if (b[k] == null) return undefined;
    const v = typeof b[k] === 'string' ? Number((b[k] as string).replace(/_/g, '')) : Number(b[k]); // allow 2_000_000
    if (!Number.isFinite(v) || v <= 0) problems.push(`budget.${k} must be a positive number`);
    return v;
  };
  return { maxCostUsd: num('max_cost_usd'), maxTokens: num('max_tokens'), maxCostUsdPerDay: num('max_cost_usd_per_day') };
}

/** Inputs must come from steps that run earlier; ids and output names must be unique where it matters. */
function checkReferences(nodes: TopNode[], problems: string[]) {
  const ids = new Set<string>();
  const produced = new Set<string>();
  const checkId = (id: string) => {
    if (ids.has(id)) problems.push(`duplicate id "${id}"`);
    ids.add(id);
  };
  const checkInputs = (s: StepNode, inLoop: boolean) => {
    for (const input of s.inputs) {
      if (input === 'loop.history' && !inLoop) problems.push(`step "${s.id}": loop.history is only available inside a loop`);
      else if (RESERVED_INPUTS.has(input) || input.startsWith('file:')) continue;
      else if (!produced.has(input)) {
        problems.push(`step "${s.id}": input "${input}" is not produced by any earlier step`);
      }
    }
  };
  for (const n of nodes) {
    checkId(n.id);
    if (n.kind === 'step') {
      checkInputs(n, false);
      produced.add(n.output);
    } else if (n.kind === 'loop') {
      for (const s of n.steps) {
        checkId(s.id);
        checkInputs(s, true);
        produced.add(s.output);
      }
    } else {
      for (const name of n.show) if (!produced.has(name)) problems.push(`gate "${n.id}": shows "${name}", which no earlier step produces`);
    }
  }
}

/**
 * Warns about pipelines that will not get the cache reuse they appear to be designed for:
 * prompt caches do not carry across providers or models.
 */
function cachePlanner(nodes: TopNode[], warnings: string[]) {
  const shared = nodes
    .flatMap((n) => (n.kind === 'step' ? [n] : n.kind === 'loop' ? n.steps : []))
    .filter((s) => s.agent.cache === 'shared');
  for (let i = 1; i < shared.length; i++) {
    const a = shared[i - 1];
    const b = shared[i];
    const ka = `${a.agent.provider}/${a.agent.model}`;
    const kb = `${b.agent.provider}/${b.agent.model}`;
    if (ka !== kb) {
      warnings.push(
        `cache: "${a.id}" (${ka}) and "${b.id}" (${kb}) run on different models, so "${b.id}" cannot reuse the cached prefix from "${a.id}"`,
      );
    }
  }
  const cursorSteps = nodes
    .flatMap((n) => (n.kind === 'step' ? [n] : n.kind === 'loop' ? n.steps : []))
    .filter((s) => s.agent.provider === 'cursor');
  for (const s of cursorSteps) {
    if (s.agent.tools.length) warnings.push(`step "${s.id}": cursor agents use Cursor's own tools; "tools" is ignored`);
  }
  if (cursorSteps.length) {
    warnings.push(
      `cursor: steps ${cursorSteps.map((s) => `"${s.id}"`).join(', ')} may not report token usage or cache data; their cost shows as "not reported"`,
    );
  }
}

function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
