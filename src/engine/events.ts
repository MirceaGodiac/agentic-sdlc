import type { Pipeline } from '../pipeline/types.js';
import type { Usage } from '../providers/types.js';

export interface Workspace {
  path: string;
  /** Git worktree details, when the run works on a git repository. */
  git: { repo: string; branch: string; baseRef: string; baseSha: string } | null;
}

export interface ContextPartInfo {
  source: string;
  zone: 'prefix' | 'tail';
  chars: number;
  substituted?: string;
}

export type GateReason = 'gate' | 'loop_exhausted' | 'budget';
export type GateDecision = 'approve' | 'reject' | 'edit' | 'sendback';
export type FinalStatus = 'succeeded' | 'failed' | 'rejected' | 'budget_exceeded';

export type RunEvent =
  | { type: 'RunStarted'; pipeline: Pipeline; input: string; workspace: Workspace }
  | {
      type: 'ContextBuilt';
      stepId: string;
      iteration: number;
      attempt: number;
      parts: ContextPartInfo[];
      promptRef: string;
      prefixHashes: string[];
      cacheSource: { stepId: string; iteration: number; sharedParts: number } | null;
    }
  | { type: 'StepStarted'; stepId: string; iteration: number; attempt: number; provider: string; model: string }
  | {
      type: 'ModelCalled';
      stepId: string;
      iteration: number;
      attempt: number;
      turn: number;
      estimatedInputTokens: number;
      maxOutputTokens: number;
    }
  | {
      type: 'UsageRecorded';
      stepId: string;
      iteration: number;
      attempt: number;
      turn: number;
      provider: string;
      model: string;
      usage: Usage;
      costUsd: number | null;
      savingsUsd: number | null;
      priceVersion: string | null;
    }
  | { type: 'ToolCalled'; stepId: string; iteration: number; name: string; args: string; ok: boolean; result: string }
  | { type: 'NotebookAppended'; stepId: string; iteration: number; key: string; value: string }
  | {
      type: 'StepCompleted';
      stepId: string;
      iteration: number;
      attempt: number;
      output: string;
      outputRef: string;
      verdict: string | null;
      /** Length of a structured output's `findings` array, if it has one. */
      findingsCount: number | null;
      sha: string | null;
      durationMs: number;
    }
  | {
      type: 'StepFailed';
      stepId: string;
      iteration: number;
      attempt: number;
      error: string;
      willRetry: boolean;
      /** Only `error` failures use up a step's retries. */
      cause?: 'error' | 'budget' | 'aborted' | 'interrupted';
    }
  | { type: 'LoopIteration'; loopId: string; iteration: number }
  | { type: 'LoopExited'; loopId: string; iteration: number; reason: 'condition' | 'max_iterations' }
  | {
      type: 'GateOpened';
      gateId: string;
      instance: number;
      reason: GateReason;
      show: string[];
      deadline: string | null;
      onTimeout: 'approve' | 'reject' | 'wait';
      message: string;
      behindBase: number | null;
    }
  | {
      type: 'GateDecided';
      gateId: string;
      instance: number;
      decision: GateDecision;
      by: 'human' | 'timeout';
      to?: string;
      edit?: { output: string; ref: string };
      budgetUsd?: number;
      note?: string;
    }
  | { type: 'RunPaused' }
  | { type: 'RunResumed' }
  | { type: 'RunCancelled'; reason?: string }
  | { type: 'RunFinished'; status: FinalStatus; error?: string };

export type StoredEvent = RunEvent & { seq: number; at: string };

export type EventOf<T extends RunEvent['type']> = Extract<StoredEvent, { type: T }>;
