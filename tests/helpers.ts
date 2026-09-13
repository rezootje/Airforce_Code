import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Provider, ProviderEvent, ToolDefinition } from '../src/agent/types.js';
export async function workspace() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'airforce-test-')));
  const root = join(base, 'project');
  const home = join(base, 'private');
  await mkdir(root);
  return { base, root, home, cleanup: () => rm(base, { recursive: true, force: true }) };
}
export class FakeProvider implements Provider {
  readonly requests: Message[][] = [];
  constructor(
    private readonly turns: ((messages: Message[]) => ProviderEvent[] | Promise<ProviderEvent[]>)[],
  ) {}
  async models() {
    return [{ id: 'test-model', capabilities: { tools: true } }];
  }
  async *complete(messages: Message[], _tools: ToolDefinition[], signal: AbortSignal) {
    signal.throwIfAborted();
    this.requests.push(structuredClone(messages));
    const turn = this.turns.shift();
    if (!turn) throw new Error('Unexpected provider turn');
    for (const event of await turn(messages)) yield event;
  }
}
