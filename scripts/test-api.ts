import { configSchema } from '../src/config/config.js';
import { AirforceProvider } from '../src/providers/airforce.js';
import type { ProviderEvent, Message } from '../src/agent/types.js';
if (process.env.AIRFORCE_API_TEST !== '1')
  throw new Error(
    'Paid API tests are opt-in. Set AIRFORCE_API_TEST=1, AIRFORCE_API_KEY, AIRFORCE_BASE_URL and AIRFORCE_MODEL.',
  );
const apiKey = process.env.AIRFORCE_API_KEY;
if (!apiKey) throw new Error('Missing AIRFORCE_API_KEY');
const config = configSchema.parse({
  baseUrl: process.env.AIRFORCE_BASE_URL,
  model: process.env.AIRFORCE_MODEL,
  protocol: process.env.AIRFORCE_PROTOCOL ?? 'openai',
  maxOutputTokens: 256,
});
const provider = new AirforceProvider(config, apiKey);
const models = await provider.models();
console.log(JSON.stringify({ check: 'models', count: models.length }));
const model = models.find((m) => m.id === config.model);
if (!model) throw new Error('Selected test model not found');
provider.setModel(model);
const collect = async (messages: Message[], tools: Parameters<typeof provider.complete>[1]) => {
  const events: ProviderEvent[] = [];
  for await (const e of provider.complete(messages, tools, AbortSignal.timeout(90000)))
    events.push(e);
  return events;
};
const simple = await collect(
  [{ role: 'user', content: 'Reply with exactly: connection verified' }],
  [],
);
if (!simple.some((e) => e.type === 'text')) throw new Error('No completion text');
console.log(JSON.stringify({ check: 'completion/stream', ok: true }));
if (model.capabilities.tools !== false) {
  const result = await collect(
    [{ role: 'user', content: 'Call connection_probe with value "ok". Do not answer directly.' }],
    [
      {
        name: 'connection_probe',
        description: 'A harmless provider compatibility probe. No side effects.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ],
  );
  if (!result.some((e) => e.type === 'tool'))
    throw new Error('Model did not emit a tool call; capability may be unsupported');
  console.log(JSON.stringify({ check: 'tool-calling', ok: true }));
}
console.log(
  'Compatibility checks passed. No repository content was sent. Set AIRFORCE_PROTOCOL=anthropic to test /v1/messages separately.',
);
