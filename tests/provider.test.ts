import { it, expect, vi, afterEach } from 'vitest';
import { AirforceProvider, parseModels } from '../src/providers/airforce.js';
import { configSchema } from '../src/config/config.js';
import { sse, endpoint } from '../src/providers/http.js';
import type { ProviderEvent } from '../src/agent/types.js';
afterEach(() => vi.unstubAllGlobals());
const cfg = (protocol: 'openai' | 'anthropic' = 'openai') =>
  configSchema.parse({ baseUrl: 'https://api.test', model: 'discovered', protocol });
const stream = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
async function collect(provider: AirforceProvider) {
  const events: ProviderEvent[] = [];
  for await (const e of provider.complete(
    [{ role: 'user', content: 'hello' }],
    [],
    new AbortController().signal,
  ))
    events.push(e);
  return events;
}
it('normalizes model metadata without inventing capabilities', () => {
  expect(
    parseModels({
      data: [
        { id: 'unknown' },
        { id: 'known', context_window: 128000, capabilities: { tools: false } },
        {
          id: 'priced',
          context_length: 200000,
          supports_tools: true,
          supports_streaming: true,
          pricepermilliontokens: 300,
          output_pricepermilliontokens: 1500,
        },
      ],
    }),
  ).toMatchObject([
    { id: 'unknown', capabilities: {} },
    { id: 'known', contextWindow: 128000, capabilities: { tools: false } },
    {
      id: 'priced',
      contextWindow: 200000,
      capabilities: { tools: true, streaming: true },
      pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
    },
  ]);
  expect(endpoint('https://api.test/v1/', 'models')).toBe('https://api.test/v1/models');
});
it('parses fragmented SSE lines, UTF-8 and multiline data', async () => {
  const encoder = new TextEncoder();
  const raw = ':keepalive\r\ndata: {"a":\r\ndata: "é"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = encoder.encode(raw);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
      c.close();
    },
  });
  const result = [];
  for await (const e of sse(new Response(body))) result.push(e);
  expect(result).toEqual([{ a: 'é' }]);
});
it('assembles streamed tool arguments and usage before executing anything', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        { choices: [{ delta: { content: 'Reading\n' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
      ]),
    ),
  );
  expect(
    await collect(
      new AirforceProvider(cfg(), 'key', {
        id: 'discovered',
        capabilities: {},
        pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
      }),
    ),
  ).toEqual([
    { type: 'text', text: 'Reading\n' },
    { type: 'usage', input: 12, output: 8, costUsd: 0.000156 },
    { type: 'tool', call: { id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' } },
  ]);
});
it('rejects truncated streams and malformed response JSON', async () => {
  vi.stubGlobal('fetch', async () =>
    stream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'x', function: { name: 'delete_file', arguments: '{}' } },
              ],
            },
          },
        ],
      },
    ]),
  );
  await expect(collect(new AirforceProvider(cfg(), 'key'))).rejects.toThrow('finish marker');
  vi.stubGlobal('fetch', async () => new Response('data: {bad}\n\n'));
  await expect(collect(new AirforceProvider(cfg(), 'key'))).rejects.toThrow('Malformed SSE');
});
it('handles non-streaming models and standard non-stream tool indices', async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const p = new AirforceProvider(cfg(), 'key', {
    id: 'discovered',
    capabilities: { streaming: false },
  });
  expect((await collect(p))[0]).toMatchObject({
    type: 'tool',
    call: { id: 'a', name: 'read_file' },
  });
  expect(JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) || '{}').stream).toBe(false);
});
it('normalizes Anthropic streaming tool calls and messages', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    stream([
      { type: 'message_start', message: { usage: { input_tokens: 20 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
      },
      { type: 'message_delta', usage: { output_tokens: 10 }, delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]),
  );
  vi.stubGlobal('fetch', fetchMock);
  const result = await collect(new AirforceProvider(cfg('anthropic'), 'key'));
  expect(result).toContainEqual({
    type: 'tool',
    call: { id: 't1', name: 'read_file', arguments: '{"path":"a"}' },
  });
  expect(result).toContainEqual({ type: 'usage', input: 20, output: 10 });
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.test/v1/messages');
});
it('does not leak raw HTTP error bodies or retry authentication failure', async () => {
  const mock = vi.fn(async () => new Response('private upstream diagnostic', { status: 401 }));
  vi.stubGlobal('fetch', mock);
  await expect(collect(new AirforceProvider(cfg(), 'key'))).rejects.toThrow('Check API key');
  expect(mock).toHaveBeenCalledOnce();
});
it('caches models and allows refresh', async () => {
  const mock = vi.fn(async () => new Response('{"data":[{"id":"dynamic"}]}'));
  vi.stubGlobal('fetch', mock);
  const p = new AirforceProvider(cfg(), 'key');
  await p.models();
  await p.models();
  expect(mock).toHaveBeenCalledOnce();
  p.invalidateModels();
  await p.models();
  expect(mock).toHaveBeenCalledTimes(2);
});
