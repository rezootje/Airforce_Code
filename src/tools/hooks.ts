import type { Config } from '../config/config.js';
import type { PermissionPolicy } from '../security/permissions.js';
import type { Executor } from './process.js';
import type { ToolContext } from '../agent/types.js';
import { AirforceError } from '../utils/errors.js';
export type HookEvent =
  | 'before_tool'
  | 'after_tool'
  | 'before_write'
  | 'after_write'
  | 'before_command'
  | 'after_command';
export class HookRunner {
  constructor(
    private readonly hooks: Config['hooks'],
    private readonly policy: PermissionPolicy,
    private readonly executor: Executor,
    private readonly root: string,
  ) {}
  async run(event: HookEvent, tool: string, context: ToolContext): Promise<void> {
    for (const hook of this.hooks.filter(
      (h) => h.event === event && (!h.tool || h.tool === tool),
    )) {
      await this.policy.require({
        tool: 'hook',
        description: `Hook ${event} for ${tool}: ${JSON.stringify([hook.command, ...hook.args])}`,
        risk: 'execute',
        command: [hook.command, ...hook.args],
      });
      const result = await this.executor.run(
        hook.command,
        hook.args,
        this.root,
        context.signal,
        30000,
        (text, stream) => context.emit({ type: 'tool.output', text, stream }),
      );
      if (result.exitCode !== 0 || result.timedOut)
        throw new AirforceError(
          `Hook ${event} failed (${result.exitCode}). ${result.stderr.slice(0, 1000)}`,
          'HOOK',
        );
    }
  }
}
