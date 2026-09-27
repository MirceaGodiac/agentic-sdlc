import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTurn {
  content?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  usage?: { prompt: number; completion: number; cached: number };
}

export interface RecordedRequest {
  body: {
    model: string;
    messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
    max_completion_tokens: number;
    tools?: unknown[];
    response_format?: { type: string };
  };
  role: string;
}

/**
 * A stand-in for the OpenAI Chat Completions streaming API. `respond` picks the reply from the agent's
 * ROLE line and how many times that role has been called.
 */
export async function startFakeOpenAI(respond: (role: string, n: number, req: RecordedRequest) => FakeTurn) {
  const requests: RecordedRequest[] = [];
  const counts: Record<string, number> = {};
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401).end('{"error":"bad request"}');
        return;
      }
      const body = JSON.parse(raw) as RecordedRequest['body'];
      const role = /ROLE: (\w+)/.exec(body.messages.map((m) => m.content ?? '').join('\n'))?.[1] ?? 'unknown';
      const rec = { body, role };
      requests.push(rec);
      counts[role] = (counts[role] ?? 0) + 1;
      const turn = respond(role, counts[role], rec);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (turn.content) {
        // Split into a few chunks to exercise streaming.
        for (const piece of turn.content.match(/.{1,7}/gs) ?? []) send({ choices: [{ index: 0, delta: { content: piece } }] });
      }
      (turn.toolCalls ?? []).forEach((tc, i) => {
        const args = JSON.stringify(tc.arguments);
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: tc.name, arguments: '' } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, 5) } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(5) } }] } }] });
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }] });
      const u = turn.usage ?? { prompt: 1000, completion: 100, cached: 0 };
      send({ choices: [], usage: { prompt_tokens: u.prompt, completion_tokens: u.completion, prompt_tokens_details: { cached_tokens: u.cached } } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const reset = () => {
    requests.length = 0;
    for (const k of Object.keys(counts)) delete counts[k];
  };
  return { url: `http://127.0.0.1:${port}/v1`, requests, reset, close: () => new Promise<void>((r) => server.close(() => r())) };
}
