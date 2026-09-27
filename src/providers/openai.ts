import { estimateTokens } from '../util.js';
import type {
  AgentRequest,
  AgentResult,
  ChatMessage,
  Chunk,
  ProviderAdapter,
  ProviderCapabilities,
  ToolCall,
  Usage,
} from './types.js';

export interface OpenAIOptions {
  apiKey: () => Promise<string>;
  baseUrl?: string;
}

interface Completion {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string | null;
}

/**
 * OpenAI Chat Completions adapter. Prompt caching is automatic for repeated prefixes; the response reports
 * cached input tokens, which become `cacheReadTokens`. Tool calls are executed here in a loop, with a budget
 * check before every model call.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  constructor(private opts: OpenAIOptions) {}

  capabilities(): ProviderCapabilities {
    return { structuredOutput: true, promptCache: 'auto', reportsCacheWrites: false, reportsUsage: true, customTools: true };
  }

  async run(req: AgentRequest, onChunk: (c: Chunk) => void): Promise<AgentResult> {
    const messages = [...req.messages];
    for (let turn = 1; turn <= req.maxTurns; turn++) {
      const estimatedInputTokens = estimateTokens(messages.map((m) => m.content ?? JSON.stringify(m.toolCalls)).join('\n'));
      const maxOutputTokens = await req.beforeCall({ turn, estimatedInputTokens, maxOutputTokens: req.maxOutputTokens });
      const res = await this.complete(req, messages, maxOutputTokens, onChunk);
      await req.afterCall({ turn, usage: res.usage });
      if (res.toolCalls.length === 0) {
        if (res.finishReason === 'length') throw new Error(`output hit the ${maxOutputTokens}-token limit before finishing`);
        return { output: res.content, turns: turn };
      }
      messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        let result: string;
        try {
          result = await req.executeTool(call);
        } catch (err) {
          result = `error: ${(err as Error).message}`;
        }
        messages.push({ role: 'tool', content: result, toolCallId: call.id });
      }
    }
    throw new Error(`agent did not finish within ${req.maxTurns} turns`);
  }

  private async complete(
    req: AgentRequest,
    messages: ChatMessage[],
    maxOutputTokens: number,
    onChunk: (c: Chunk) => void,
  ): Promise<Completion> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messages.map(toWire),
      max_completion_tokens: maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    }
    if (req.outputSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.outputSchema.name, schema: req.outputSchema.schema, strict: true },
      };
    }

    const base = (this.opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.opts.apiKey()}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 500)}`);
    }

    let content = '';
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    const calls: { id: string; name: string; arguments: string }[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const evt = JSON.parse(data) as StreamEvent;
        if (evt.usage) usage = toUsage(evt.usage);
        for (const choice of evt.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const d = choice.delta ?? {};
          if (d.content) {
            content += d.content;
            onChunk({ text: d.content });
          }
          for (const tc of d.tool_calls ?? []) {
            const slot = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
          }
        }
      }
    }
    return {
      content,
      toolCalls: calls.filter(Boolean),
      finishReason,
      usage: usage ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null },
    };
  }
}

interface StreamEvent {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

function toUsage(u: NonNullable<StreamEvent['usage']>): Usage {
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: null,
    providerCostUsd: null,
  };
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId };
  if (m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}
