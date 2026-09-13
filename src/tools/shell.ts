import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Executor } from './process.js';
import { PathGuard } from '../security/paths.js';
import { classifyCommand } from '../security/permissions.js';
export function registerShellTool(
  registry: ToolRegistry,
  executor: Executor,
  guard: PathGuard,
): void {
  registry.register({
    name: 'run_command',
    description:
      'Run an executable with an argument array, never shell interpolation. Commands and project scripts execute with user privileges after explicit approval. Include a concise purpose. Output, timeout and working directory are bounded.',
    schema: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).max(200).default([]),
        cwd: z.string().default('.'),
        timeoutMs: z.number().int().min(100).max(300000).default(60000),
        purpose: z.string().min(1).max(300),
      })
      .strict(),
    action: (i) => ({
      tool: 'run_command',
      description: `${i.purpose}\n${JSON.stringify([i.command, ...i.args])}\nWorking directory: ${i.cwd}`,
      risk: classifyCommand([i.command, ...i.args]),
      command: [i.command, ...i.args],
    }),
    execute: async (i, c) =>
      executor.run(
        i.command,
        i.args,
        await guard.resolve(i.cwd, { allowDirectory: true }),
        c.signal,
        i.timeoutMs,
        (text, stream) => c.emit({ type: 'tool.output', text, stream }),
      ),
  });
}
