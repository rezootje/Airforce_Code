import type { Provider, Emit, ToolCall, Message } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Session, SessionStore } from '../sessions/store.js';
import { repairInterruptedTools } from '../sessions/store.js';
import type { ContextManager } from '../context/manager.js';
import type { PermissionPolicy } from '../security/permissions.js';
import { Redactor, sanitize } from '../security/redact.js';
import { AirforceError } from '../utils/errors.js';
export interface AgentOptions {
  provider: Provider;
  registry: ToolRegistry;
  session: Session;
  store: SessionStore;
  context: ContextManager;
  policy: PermissionPolicy;
  system: () => Promise<string>;
  emit: Emit;
  redactor: Redactor;
  maxTurns: number;
}
export class Agent {
  private running = false;
  private readonly steering: string[] = [];
  constructor(readonly options: AgentOptions) {}
  steer(instruction: string): void {
    this.steering.push(this.options.redactor.text(instruction));
  }
  async run(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ status: 'completed' | 'cancelled' | 'limited'; text: string }> {
    if (this.running) throw new AirforceError('Agent already running', 'BUSY');
    this.running = true;
    const o = this.options;
    let release: (() => Promise<void>) | undefined;
    let final = '';
    let streamed = 0;
    try {
      release = await o.store.lock(o.session.id);
      repairInterruptedTools(o.session.messages);
      const safe = o.redactor.text(prompt);
      o.session.messages.push({ role: 'user', content: safe });
      o.session.requirements.push(safe);
      if (o.session.title === 'New session') o.session.title = sanitize(safe).slice(0, 80);
      o.policy.questionFirst = o.session.questionFirst;
      await o.store.save(o.session);
      o.emit({ type: 'agent.started', sessionId: o.session.id });
      for (let step = 0; step < o.maxTurns; step++) {
        signal.throwIfAborted();
        for (const instruction of this.steering.splice(0)) {
          o.session.requirements.push(instruction);
          o.session.messages.push({ role: 'user', content: instruction });
        }
        const system =
          (await o.system()) +
          (o.session.questionFirst
            ? '\nQUESTION-FIRST MODE: Inspect only using read tools. Ask focused questions before implementation. All non-read tools are blocked until the user turns this mode off.'
            : '');
        let messages = o.context.build(system);
        if (!o.context.fits(messages)) {
          await o.context.compact(o.provider, system, signal, o.emit);
          messages = o.context.build(system);
        }
        const calls: ToolCall[] = [];
        let text = '';
        for await (const event of o.provider.complete(
          o.redactor.value(messages),
          o.registry.definitions(),
          signal,
        )) {
          signal.throwIfAborted();
          if (event.type === 'text') {
            text += event.text;
            if (text.length > 2_000_000)
              throw new AirforceError('Assistant response exceeds limit', 'RESPONSE_LIMIT');
          } else if (event.type === 'tool') {
            if (calls.length >= 32)
              throw new AirforceError('Too many tool calls in one turn', 'TOOL_LIMIT');
            calls.push(event.call);
          } else {
            o.session.usage.inputTokens += event.input;
            o.session.usage.outputTokens += event.output;
            o.session.usage.costUsd += event.costUsd ?? 0;
            if (event.costUsd === undefined)
              o.session.usage.unpricedTokens += event.input + event.output;
            o.session.usage.priced =
              o.session.usage.unpricedTokens === 0 &&
              o.session.usage.inputTokens + o.session.usage.outputTokens > 0;
            o.emit({
              type: 'usage',
              input: event.input,
              output: event.output,
              costUsd: event.costUsd,
              sessionInput: o.session.usage.inputTokens,
              sessionOutput: o.session.usage.outputTokens,
              sessionCostUsd: o.session.usage.costUsd,
              sessionPriced: o.session.usage.priced,
            });
          }
          // Buffer to newline so split credentials and terminal escapes are sanitized before UI output.
          if (event.type === 'text') {
            const end = text.lastIndexOf('\n');
            if (end >= streamed) {
              const delta = text.slice(streamed, end + 1);
              o.emit({ type: 'assistant.delta', text: sanitize(o.redactor.text(delta)) });
              streamed = end + 1;
            }
          }
        }
        if (text.length > streamed)
          o.emit({
            type: 'assistant.delta',
            text: sanitize(o.redactor.text(text.slice(streamed))),
          });
        streamed = 0;
        const ids = new Set(calls.map((c) => c.id));
        if (ids.size !== calls.length)
          throw new AirforceError('Duplicate tool call IDs', 'PROTOCOL');
        final = o.redactor.text(text);
        const message: Message = {
          role: 'assistant',
          content: final,
          ...(calls.length ? { toolCalls: calls } : {}),
        };
        o.session.messages.push(message);
        await o.store.save(o.session);
        if (final) o.emit({ type: 'assistant.message', text: sanitize(final) });
        if (!calls.length) {
          o.emit({ type: 'agent.completed', status: 'completed', text: sanitize(final) });
          return { status: 'completed', text: final };
        }
        for (const call of calls) {
          const result = await o.registry.execute(call, { signal, emit: o.emit });
          o.session.messages.push({ role: 'tool', toolCallId: call.id, content: result.content });
          await o.store.save(o.session);
        }
      }
      o.emit({ type: 'agent.completed', status: 'limited', text: final });
      return { status: 'limited', text: final };
    } catch (e) {
      if (signal.aborted) {
        repairInterruptedTools(o.session.messages);
        o.emit({ type: 'agent.completed', status: 'cancelled', text: final });
        return { status: 'cancelled', text: final };
      }
      throw e;
    } finally {
      this.running = false;
      if (release) {
        try {
          repairInterruptedTools(o.session.messages);
          await o.store.save(o.session);
          o.emit({ type: 'session.saved', sessionId: o.session.id });
        } finally {
          await release();
        }
      }
    }
  }
}
