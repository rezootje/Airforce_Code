import { z } from 'zod';
import { assertCredentials, credentialToken, type Credentials } from '../auth/credentials.js';
import type { Config } from '../config/config.js';
import type {
  Message,
  Model,
  Provider,
  ProviderEvent,
  ToolCall,
  ToolDefinition,
} from '../agent/types.js';
import { boundedText, endpoint, request, sse } from './http.js';
import { AirforceError } from '../utils/errors.js';
const functionSchema = z.object({ name: z.string().optional(), arguments: z.string().optional() });
const deltaSchema = z.object({
  content: z.string().nullish(),
  tool_calls: z
    .array(
      z.object({
        index: z.number().int().min(0).max(127).optional(),
        id: z.string().optional(),
        function: functionSchema.optional(),
      }),
    )
    .optional(),
});
const chunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        delta: deltaSchema.optional(),
        message: deltaSchema.optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .nullish(),
});
const anthropicSchema = z.object({
  type: z.string(),
  index: z.number().int().min(0).max(127).optional(),
  content_block: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
      input: z.unknown().optional(),
    })
    .optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      stop_reason: z.string().nullish(),
    })
    .optional(),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
  message: z
    .object({
      usage: z
        .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
        .optional(),
    })
    .optional(),
});
export function parseModels(value: unknown): Model[] {
  const wire = z
    .object({
      data: z
        .array(
          z
            .object({
              id: z.string().min(1),
              name: z.string().optional(),
              context_window: z.number().positive().optional(),
              context_length: z.number().positive().optional(),
              supports_streaming: z.boolean().optional(),
              supports_tools: z.boolean().optional(),
              supports_vision: z.boolean().optional(),
              pricepermilliontokens: z.number().nonnegative().optional(),
              output_pricepermilliontokens: z.number().nonnegative().optional(),
              cache_read_pricepermilliontokens: z.number().nonnegative().optional(),
              cache_write_5m_pricepermilliontokens: z.number().nonnegative().optional(),
              cache_write_1h_pricepermilliontokens: z.number().nonnegative().optional(),
              capabilities: z
                .object({
                  tools: z.boolean().optional(),
                  streaming: z.boolean().optional(),
                  vision: z.boolean().optional(),
                })
                .optional(),
            })
            .passthrough(),
        )
        .max(10000),
    })
    .parse(value);
  return wire.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.context_length ?? m.context_window,
    capabilities: {
      tools: m.supports_tools ?? m.capabilities?.tools,
      streaming: m.supports_streaming ?? m.capabilities?.streaming,
      vision: m.supports_vision ?? m.capabilities?.vision,
    },
    pricing:
      m.pricepermilliontokens !== undefined || m.output_pricepermilliontokens !== undefined
        ? {
            inputPerMillionUsd:
              m.pricepermilliontokens === undefined ? undefined : m.pricepermilliontokens / 100,
            outputPerMillionUsd:
              m.output_pricepermilliontokens === undefined
                ? undefined
                : m.output_pricepermilliontokens / 100,
            cacheReadPerMillionUsd:
              m.cache_read_pricepermilliontokens === undefined
                ? undefined
                : m.cache_read_pricepermilliontokens / 100,
            cacheWrite5mPerMillionUsd:
              m.cache_write_5m_pricepermilliontokens === undefined
                ? undefined
                : m.cache_write_5m_pricepermilliontokens / 100,
            cacheWrite1hPerMillionUsd:
              m.cache_write_1h_pricepermilliontokens === undefined
                ? undefined
                : m.cache_write_1h_pricepermilliontokens / 100,
          }
        : undefined,
    metadata: m,
  }));
}
export class AirforceProvider implements Provider {
  private cache?: { at: number; models: Model[] };
  constructor(
    readonly config: Config,
    private readonly credentials: string | Credentials,
    private modelInfo?: Model,
  ) {
    if (!config.baseUrl)
      throw new AirforceError('Set AIRFORCE_BASE_URL or run airforce setup.', 'CONFIG', 2);
  }
  private get apiKey(): string {
    if (typeof this.credentials === 'string') return this.credentials;
    assertCredentials(this.credentials, this.config.baseUrl!);
    return credentialToken(this.credentials);
  }
  setModel(model: Model): void {
    this.config.model = model.id;
    this.modelInfo = model;
  }
  invalidateModels(): void {
    this.cache = undefined;
  }
  private headers(): Record<string, string> {
    if (typeof this.credentials !== 'string' && this.credentials.kind === 'oauth')
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...(this.config.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      };
    return this.config.protocol === 'anthropic'
      ? {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }
  async models(signal = AbortSignal.timeout(15000)): Promise<Model[]> {
    if (this.cache && Date.now() - this.cache.at < 300000) return this.cache.models;
    const res = await request(
      endpoint(this.config.baseUrl!, 'models'),
      { headers: { authorization: `Bearer ${this.apiKey}` } },
      signal,
    );
    const models = parseModels(JSON.parse(await boundedText(res)));
    this.cache = { at: Date.now(), models };
    return models;
  }
  async *complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    if (!this.config.model) throw new AirforceError('Select a model first.', 'CONFIG', 2);
    const effective = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
    const available = this.modelInfo?.capabilities.tools === false ? [] : tools;
    if (this.config.protocol === 'anthropic') {
      yield* this.anthropic(messages, available, effective);
      return;
    }
    const streaming = this.modelInfo?.capabilities.streaming !== false;
    const body = {
      model: this.config.model,
      stream: streaming,
      max_tokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content || (m.toolCalls ? null : ''),
        tool_call_id: m.toolCallId,
        tool_calls: m.toolCalls?.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments },
        })),
      })),
      ...(available.length
        ? { tools: available.map((t) => ({ type: 'function', function: t })) }
        : {}),
    };
    const response = await request(
      endpoint(this.config.baseUrl!, 'chat/completions'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      effective,
    );
    const events = streaming
      ? sse(response)
      : (async function* () {
          yield JSON.parse(await boundedText(response));
        })();
    const calls = new Map<number, ToolCall>();
    let finished = false;
    for await (const raw of events) {
      const chunk = chunkSchema.parse(raw);
      if (chunk.error)
        throw new AirforceError('Provider reported an error in the completion stream', 'PROTOCOL');
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (choice?.finish_reason) {
        finished = true;
        if (['length', 'content_filter'].includes(choice.finish_reason))
          throw new AirforceError(
            `Model stopped: ${choice.finish_reason}. Increase output budget or revise request.`,
            'INCOMPLETE',
          );
      }
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const [position, part] of (delta?.tool_calls ?? []).entries()) {
        const index = part.index ?? position;
        const old = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (part.id) old.id += part.id;
        old.name += part.function?.name ?? '';
        old.arguments += part.function?.arguments ?? '';
        if (old.arguments.length > 1_000_000)
          throw new AirforceError('Tool arguments exceed limit', 'PROTOCOL');
        calls.set(index, old);
      }
      if (chunk.usage) {
        const inputTokens = chunk.usage.prompt_tokens ?? 0;
        const outputTokens = chunk.usage.completion_tokens ?? 0;
        const costUsd = this.cost(inputTokens, outputTokens);
        yield {
          type: 'usage',
          input: inputTokens,
          output: outputTokens,
          ...(costUsd === undefined ? {} : { costUsd }),
        };
      }
    }
    if (!finished)
      throw new AirforceError(
        'Completion stream ended before a finish marker. No tools executed.',
        'INCOMPLETE',
      );
    const ids = new Set<string>();
    for (const call of calls.values()) {
      if (!call.id || !call.name || ids.has(call.id))
        throw new AirforceError('Malformed or duplicate tool call', 'PROTOCOL');
      ids.add(call.id);
      yield { type: 'tool', call };
    }
  }
  private async *anthropic(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const converted: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
    for (const m of messages.filter((m) => m.role !== 'system')) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content: unknown[] =
        m.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
          : [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...(m.toolCalls ?? []).map((t) => ({
                type: 'tool_use',
                id: t.id,
                name: t.name,
                input: JSON.parse(t.arguments),
              })),
            ];
      const prev = converted.at(-1);
      if (prev?.role === role) prev.content.push(...content);
      else converted.push({ role, content });
    }
    const body = {
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      stream: true,
      system: messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n'),
      messages: converted,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };
    const response = await request(
      endpoint(this.config.baseUrl!, 'messages'),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      signal,
    );
    const calls = new Map<number, ToolCall>();
    let finished = false;
    let input = 0;
    for await (const raw of sse(response)) {
      const event = anthropicSchema.parse(raw);
      if (event.type === 'error')
        throw new AirforceError('Anthropic stream reported an error', 'PROTOCOL');
      if (event.type === 'message_stop') finished = true;
      if (event.delta?.stop_reason === 'max_tokens')
        throw new AirforceError('Model exhausted output budget', 'INCOMPLETE');
      if (event.type === 'message_start') input = event.message?.usage?.input_tokens ?? 0;
      if (event.usage) {
        const inputTokens = input || event.usage.input_tokens || 0;
        const outputTokens = event.usage.output_tokens ?? 0;
        const costUsd = this.cost(inputTokens, outputTokens);
        yield {
          type: 'usage',
          input: inputTokens,
          output: outputTokens,
          ...(costUsd === undefined ? {} : { costUsd }),
        };
      }
      if (event.content_block?.type === 'tool_use' && event.index !== undefined)
        calls.set(event.index, {
          id: event.content_block.id ?? '',
          name: event.content_block.name ?? '',
          arguments: '',
        });
      if (event.content_block?.text) yield { type: 'text', text: event.content_block.text };
      if (event.delta?.text) yield { type: 'text', text: event.delta.text };
      if (event.delta?.partial_json && event.index !== undefined) {
        const call = calls.get(event.index);
        if (!call) throw new AirforceError('Tool delta without tool start', 'PROTOCOL');
        call.arguments += event.delta.partial_json;
        if (call.arguments.length > 1_000_000)
          throw new AirforceError('Tool arguments exceed limit', 'PROTOCOL');
      }
    }
    if (!finished) throw new AirforceError('Anthropic stream ended prematurely', 'INCOMPLETE');
    const ids = new Set<string>();
    for (const call of calls.values()) {
      if (!call.id || !call.name || ids.has(call.id))
        throw new AirforceError('Malformed tool call', 'PROTOCOL');
      ids.add(call.id);
      yield { type: 'tool', call: { ...call, arguments: call.arguments || '{}' } };
    }
  }

  private cost(input: number, output: number): number | undefined {
    const pricing = this.modelInfo?.pricing;
    if (!pricing) return undefined;
    if (
      (input > 0 && pricing.inputPerMillionUsd === undefined) ||
      (output > 0 && pricing.outputPerMillionUsd === undefined)
    )
      return undefined;
    return (
      (input * (pricing.inputPerMillionUsd ?? 0) + output * (pricing.outputPerMillionUsd ?? 0)) /
      1_000_000
    );
  }
}
