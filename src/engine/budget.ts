import type { ModelPrice } from '../usage/prices.js';

/** Smallest output allowance worth making a call for; below it the run pauses at a budget gate instead. */
export const MIN_OUTPUT_TOKENS = 256;
/** Safety margin on the input-size estimate (the real count only arrives after the call). */
const INPUT_MARGIN = 1.2;

export interface Caps {
  runUsd?: number;
  runTokens?: number;
  pipelineDayUsd?: number;
  globalDayUsd?: number;
}

export interface Spent {
  runUsd: number;
  runTokens: number;
  pipelineDayUsd: number;
  globalDayUsd: number;
}

export type Plan = { ok: true; maxOutputTokens: number } | { ok: false; reason: string };

const hasCostCap = (c: Caps) => c.runUsd != null || c.pipelineDayUsd != null || c.globalDayUsd != null;

/**
 * Budget Guard, before a call: can we afford the input, and how much output fits in what is left?
 * Output is capped (max_output_tokens) so the call cannot push spend past a cap.
 */
export function planCall(caps: Caps, spent: Spent, price: ModelPrice | null, per: number, estInput: number, wantOut: number): Plan {
  let maxOut = wantOut;
  const input = Math.ceil(estInput * INPUT_MARGIN);

  if (caps.runTokens != null) {
    const left = caps.runTokens - spent.runTokens - input;
    if (left < MIN_OUTPUT_TOKENS) {
      return { ok: false, reason: `token cap: ${spent.runTokens} used of ${caps.runTokens}, next call needs ~${input} input tokens` };
    }
    maxOut = Math.min(maxOut, left);
  }

  if (hasCostCap(caps)) {
    if (!price) return { ok: false, reason: 'no price for this model in the price table, so the budget cannot be enforced' };
    const limits: [string, number | undefined, number][] = [
      ['run cap', caps.runUsd, spent.runUsd],
      ['pipeline daily cap', caps.pipelineDayUsd, spent.pipelineDayUsd],
      ['global daily cap', caps.globalDayUsd, spent.globalDayUsd],
    ];
    const inputCost = (input * price.input) / per;
    for (const [label, cap, used] of limits) {
      if (cap == null) continue;
      const left = cap - used - inputCost;
      const affordable = Math.floor((left * per) / price.output);
      if (affordable < MIN_OUTPUT_TOKENS) {
        return {
          ok: false,
          reason: `${label}: $${used.toFixed(2)} spent of $${cap.toFixed(2)}, next call needs ~$${inputCost.toFixed(3)} for input alone`,
        };
      }
      maxOut = Math.min(maxOut, affordable);
    }
  }
  return { ok: true, maxOutputTokens: maxOut };
}

/** Budget Guard, after a call: returns why the run must stop, if a hard cap was passed. */
export function checkAfter(caps: Caps, spent: Spent): string | null {
  if (caps.runUsd != null && spent.runUsd > caps.runUsd) return `run cost $${spent.runUsd.toFixed(2)} passed the cap $${caps.runUsd.toFixed(2)}`;
  if (caps.runTokens != null && spent.runTokens > caps.runTokens) return `run used ${spent.runTokens} tokens, cap ${caps.runTokens}`;
  return null;
}
