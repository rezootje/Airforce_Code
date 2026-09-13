import type { HookRunner } from './hooks.js';
import { z } from 'zod';
import type { Tool, ToolContext, ToolDefinition, ToolCall } from '../agent/types.js';
import { PermissionPolicy } from '../security/permissions.js';
import { Redactor, sanitize } from '../security/redact.js';
import { AirforceError, errorMessage } from '../utils/errors.js';
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly redactor: Redactor,
    private readonly hooks?: HookRunner,
  ) {}
  register<T>(tool: Tool<T>): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.tools.has(tool.name))
      throw new Error(`Invalid or duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool as Tool);
  }
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>,
    }));
  }
  async execute(call: ToolCall, context: ToolContext): Promise<{ ok: boolean; content: string }> {
    try {
      context.signal.throwIfAborted();
      const tool = this.tools.get(call.name);
      if (!tool) throw new AirforceError(`Unknown tool: ${call.name}`, 'TOOL');
      if (call.arguments.length > 1_000_000)
        throw new AirforceError('Tool arguments too large', 'TOOL');
      if (this.redactor.text(call.arguments) !== call.arguments)
        throw new AirforceError(
          'Tool arguments contain detected credentials. Use secure local configuration instead.',
          'SECRET',
        );
      const input = tool.schema.parse(JSON.parse(call.arguments));
      const action = tool.action(input);
      await this.policy.require(action);
      context.signal.throwIfAborted();
      context.emit({
        type: 'tool.started',
        id: call.id,
        name: call.name,
        description: sanitize(this.redactor.text(action.description)),
      });
      await this.hooks?.run('before_tool', call.name, context);
      if (action.risk === 'write') await this.hooks?.run('before_write', call.name, context);
      if (call.name === 'run_command') await this.hooks?.run('before_command', call.name, context);
      const value = await tool.execute(input, context);
      if (action.risk === 'write') await this.hooks?.run('after_write', call.name, context);
      if (call.name === 'run_command') await this.hooks?.run('after_command', call.name, context);
      await this.hooks?.run('after_tool', call.name, context);
      const content = sanitize(this.redactor.text(JSON.stringify(value) ?? 'null')).slice(0, 60000);
      const failed =
        typeof value === 'object' &&
        value !== null &&
        (('exitCode' in value && value.exitCode !== 0) ||
          ('timedOut' in value && value.timedOut === true) ||
          ('isError' in value && value.isError === true));
      const failureCode =
        failed &&
        typeof value === 'object' &&
        value !== null &&
        'timedOut' in value &&
        value.timedOut
          ? 'COMMAND_TIMEOUT'
          : failed && typeof value === 'object' && value !== null && 'exitCode' in value
            ? 'COMMAND_FAILED'
            : failed
              ? 'TOOL_RESULT_ERROR'
              : undefined;
      context.emit({
        type: 'tool.completed',
        id: call.id,
        name: call.name,
        result: content,
        ok: !failed,
        ...(failureCode ? { errorCode: failureCode } : {}),
      });
      return { ok: !failed, content };
    } catch (e) {
      if (context.signal.aborted) throw e;
      const content = this.redactor.text(errorMessage(e));
      context.emit({
        type: 'tool.completed',
        id: call.id,
        name: call.name,
        result: content,
        ok: false,
        errorCode: e instanceof AirforceError ? e.code : 'TOOL',
      });
      return {
        ok: false,
        content: JSON.stringify({
          error: content,
          code: e instanceof AirforceError ? e.code : 'TOOL',
        }),
      };
    }
  }
}
