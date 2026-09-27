import type { OutputSchema, ProviderId } from '../pipeline/types.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Normalised usage for one model call.
 * `inputTokens` is the total prompt size as the provider reports it, including cache reads.
 * `null` means the provider does not report that figure; it is never guessed.
 */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  providerCostUsd: number | null;
}

export interface CallInfo {
  turn: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface AgentRequest {
  model: string;
  temperature?: number;
  messages: ChatMessage[];
  outputSchema?: OutputSchema;
  tools: ToolDef[];
  executeTool(call: ToolCall): Promise<string>;
  maxTurns: number;
  maxOutputTokens: number;
  /** Working directory for code-editing agents (the run's worktree), if any. */
  workspace: string | null;
  signal: AbortSignal;
  /** Called before every model call. Returns the max output tokens allowed (budget may lower it) or throws to stop. */
  beforeCall(info: CallInfo): Promise<number>;
  /** Called after every model call with what the provider reported. May throw to stop (e.g. hard budget cap). */
  afterCall(info: { turn: number; usage: Usage }): Promise<void>;
}

export interface AgentResult {
  output: string;
  turns: number;
}

export interface Chunk {
  text: string;
}

export interface ProviderCapabilities {
  structuredOutput: boolean;
  promptCache: 'auto' | 'explicit' | 'none' | 'unknown';
  reportsCacheWrites: boolean;
  /** False when the provider cannot report token usage, which means budgets cannot be enforced. */
  reportsUsage: boolean;
  /** True when the adapter runs agentp's tools (read_file, run_command, ...); false when the provider brings its own. */
  customTools: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities(): ProviderCapabilities;
  run(req: AgentRequest, onChunk: (c: Chunk) => void): Promise<AgentResult>;
}

export type ProviderRegistry = Record<ProviderId, ProviderAdapter>;
