export type ProviderId = 'openai' | 'cursor';
export const PROVIDERS: ProviderId[] = ['openai', 'cursor'];

export type ToolName = 'read_file' | 'write_file' | 'list_files' | 'run_command' | 'notebook';
export const TOOL_NAMES: ToolName[] = ['read_file', 'write_file', 'list_files', 'run_command', 'notebook'];

export interface OutputSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface AgentDef {
  /** Path as written in the pipeline file. */
  path: string;
  provider: ProviderId;
  model: string;
  temperature?: number;
  outputSchema?: OutputSchema;
  cache: 'shared' | 'isolated';
  tools: ToolName[];
  maxOutputTokens: number;
  maxTurns: number;
  instructions: string;
}

export interface StepNode {
  kind: 'step';
  id: string;
  agent: AgentDef;
  inputs: string[];
  output: string;
  task?: string;
  retries: number;
}

export interface Condition {
  source: string;
  stepId: string;
  field: string[];
  op: '==' | '!=';
  value: unknown;
}

export interface LoopNode {
  kind: 'loop';
  id: string;
  maxIterations: number;
  until: Condition;
  onExhausted: 'gate' | 'fail';
  steps: StepNode[];
}

export interface GateNode {
  kind: 'gate';
  id: string;
  show: string[];
  timeoutMs: number | null;
  onTimeout: 'approve' | 'reject' | 'wait';
}

export type TopNode = StepNode | LoopNode | GateNode;

export interface Budget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxCostUsdPerDay?: number;
}

export interface SharedFile {
  path: string;
  content: string;
}

/**
 * A compiled pipeline. It is self-contained (agent instructions and shared files are inlined) so a
 * snapshot stored with a run keeps its meaning even after the files on disk change.
 */
export interface Pipeline {
  name: string;
  file: string;
  hash: string;
  budget: Budget;
  sharedContext: SharedFile[];
  maxInputChars: number;
  nodes: TopNode[];
}

export interface Position {
  node: number;
  inner?: number;
}

export function stepPositions(p: Pipeline): Map<string, Position> {
  const map = new Map<string, Position>();
  p.nodes.forEach((n, node) => {
    if (n.kind === 'step') map.set(n.id, { node });
    else if (n.kind === 'loop') n.steps.forEach((s, inner) => map.set(s.id, { node, inner }));
  });
  return map;
}

export function allSteps(p: Pipeline): StepNode[] {
  return p.nodes.flatMap((n) => (n.kind === 'step' ? [n] : n.kind === 'loop' ? n.steps : []));
}

export function findStep(p: Pipeline, id: string): StepNode | undefined {
  return allSteps(p).find((s) => s.id === id);
}

export function loopOf(p: Pipeline, stepId: string): LoopNode | undefined {
  return p.nodes.find((n): n is LoopNode => n.kind === 'loop' && n.steps.some((s) => s.id === stepId));
}
