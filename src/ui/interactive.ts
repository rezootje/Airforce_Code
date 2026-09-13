import { basename } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import type { Config } from '../config/config.js';
import { saveConfig, loadUserConfig } from '../config/config.js';
import type { AirforceProvider } from '../providers/airforce.js';
import type { Runtime } from '../agent/runtime.js';
import type { Session } from '../sessions/store.js';
import { newSession } from '../sessions/store.js';
import { slashCommands, parseSlash } from '../cli/commands.js';
import { pickModel } from './setup.js';
import { Output } from './output.js';
import { estimateTokens } from '../context/manager.js';
import { loadInstructions } from '../instructions/load.js';
import { sanitize, Redactor } from '../security/redact.js';
import { formatError } from '../utils/errors.js';
import type { McpManager } from '../mcp/manager.js';
import { logo, panel } from './brand.js';
import { readAgentInput } from './prompt.js';
import { createTheme } from './theme.js';
import type { AuthMethod } from './setup.js';
import { formatTokens, formatUsd } from '../models/pricing.js';
import { pickSession } from './session-picker.js';
import { renderStatus } from './status.js';
export interface InteractiveOptions {
  config: Config;
  home: string;
  provider: AirforceProvider;
  runtime: Runtime;
  session: Session;
  output: Output;
  redactor: Redactor;
  mcp: McpManager;
  run: (prompt: string) => Promise<void>;
  doctor: () => Promise<unknown>;
  reauthenticate: (method?: AuthMethod) => Promise<void>;
}
export async function interactive(o: InteractiveOptions): Promise<Session | undefined> {
  const { runtime: r, session: s, output: out } = o;
  const theme = createTheme(
    o.output.options.color !== false && !process.env.NO_COLOR && !!process.stdout.isTTY,
  );
  const git = sanitize((await r.git.status()).split('\n')[0] || 'Not a Git repository');
  process.stdout.write(`\n${logo(theme)}\n\n`);
  process.stdout.write(
    `${panel(
      'Workspace',
      [
        `${theme.strong(sanitize(basename(s.root) || s.root))}  ${theme.muted(sanitize(s.root))}`,
        `Model  ${sanitize(o.config.model ?? 'none')}`,
        `Mode   ${r.policy.mode}${s.questionFirst ? ' · question-first' : ''}`,
        `Usage  ${formatTokens(s.usage.inputTokens)} in · ${formatTokens(s.usage.outputTokens)} out · ${s.usage.priced ? `est. ${formatUsd(s.usage.costUsd)}` : 'price unavailable'}`,
        `Git    ${git}`,
        `Session ${s.id.slice(0, 8)}`,
      ],
      theme,
    )}\n\n`,
  );
  process.stdout.write(
    `${theme.muted('Type / to browse commands · Ctrl+J for a new line · Ctrl+C to clear or exit')}\n`,
  );
  const history = s.requirements.slice(-100).reverse();
  let closed = false;
  while (!closed) {
    const line = await readAgentInput(
      slashCommands,
      history,
      {
        model: o.config.model ?? 'No model',
        mode: `${r.policy.mode}${s.questionFirst ? ' · question-first' : ''}`,
        project: basename(s.root) || s.root,
        cost: s.usage.priced ? `est. ${formatUsd(s.usage.costUsd)}` : 'price unavailable',
      },
      theme,
    );
    if (line === undefined) break;
    if (!line.trim()) continue;
    history.unshift(line);
    try {
      const command = parseSlash(line);
      if (!command) {
        await o.run(line);
        continue;
      }
      const definition = slashCommands.find((c) => c.name === command.name);
      if (!definition) {
        out.print(`Unknown command /${command.name}. Use /help.`);
        continue;
      }
      if (definition.prompt) {
        const previous = s.questionFirst;
        if (command.name === 'review') s.questionFirst = true;
        try {
          await o.run(definition.prompt + (command.args ? '\n' + command.args : ''));
        } finally {
          s.questionFirst = previous;
          r.policy.questionFirst = previous;
        }
        continue;
      }
      switch (command.name) {
        case 'help':
          out.print(
            slashCommands
              .map((c) => `/${c.name}${c.usage ? ' ' + c.usage : ''}\n  ${c.description}`)
              .join('\n'),
          );
          break;
        case 'exit':
          closed = true;
          break;
        case 'auth': {
          const method = command.args || undefined;
          if (method && method !== 'api-key' && method !== 'oauth')
            throw new Error('Usage: /auth [api-key|oauth]');
          await o.reauthenticate(method as AuthMethod | undefined);
          out.print('Authentication updated. Reloading the agent with the new credentials.');
          return s;
        }
        case 'model': {
          if (command.args === 'refresh') o.provider.invalidateModels();
          const models = await o.provider.models();
          const model =
            command.args && command.args !== 'refresh'
              ? models.find((m) => m.id === command.args)
              : await pickModel(models, o.config);
          if (!model) throw new Error('Model ID not found');
          o.provider.setModel(model);
          o.config.model = model.id;
          o.config.recentModels = [
            model.id,
            ...o.config.recentModels.filter((id) => id !== model.id),
          ].slice(0, 10);
          const user = await loadUserConfig(o.home);
          await saveConfig(o.home, {
            ...user,
            model: model.id,
            recentModels: o.config.recentModels,
          });
          out.print(`Model: ${model.id}`);
          break;
        }
        case 'permissions': {
          const mode = ['ask', 'edit', 'auto'].includes(command.args)
            ? (command.args as Config['permissionMode'])
            : await select({
                message: 'Permission mode',
                choices: ['ask', 'edit', 'auto'].map((value) => ({
                  name: value,
                  value: value as Config['permissionMode'],
                })),
              });
          r.policy.mode = mode;
          out.print(`Permission mode: ${mode}. Executables still require explicit approval.`);
          break;
        }
        case 'question': {
          s.questionFirst = command.args === 'off' ? false : command.args ? true : !s.questionFirst;
          r.policy.questionFirst = s.questionFirst;
          await r.store.save(s);
          out.print(
            `Question-first mode ${s.questionFirst ? 'enabled (read-only until /question off)' : 'disabled'}.`,
          );
          if (command.args && command.args !== 'off') await o.run(command.args);
          break;
        }
        case 'status':
          out.print(
            renderStatus({
              session: s,
              config: o.config,
              mode: r.policy.mode,
              git: await r.git.status(),
              contextTokens: estimateTokens(r.context.build(await r.system())),
              theme,
            }),
          );
          break;
        case 'git':
          out.print(await r.git.status());
          break;
        case 'diff':
          out.print((await r.git.run(['diff', '--no-ext-diff', '--no-textconv'])).stdout);
          break;
        case 'branch':
          if (command.args)
            out.print(
              await r.registry.execute(
                {
                  id: 'ui-branch',
                  name: 'git_branch',
                  arguments: JSON.stringify({ name: command.args }),
                },
                { signal: AbortSignal.timeout(30000), emit: out.event },
              ),
            );
          else out.print((await r.git.run(['branch', '--list'])).stdout);
          break;
        case 'files':
          out.print([...r.index.accessed]);
          break;
        case 'tools':
          out.print(
            r.registry.definitions().map((t) => ({ name: t.name, description: t.description })),
          );
          break;
        case 'instructions':
          out.print(await loadInstructions(r.guard));
          break;
        case 'context':
          out.print({
            estimatedTokens: estimateTokens(r.context.build(await r.system())),
            budget: o.config.contextTokens,
            historyMessages: s.messages.length,
            compactedMessages: s.compactedUntil,
            summary: s.summary,
          });
          break;
        case 'compact': {
          const controller = new AbortController();
          const abort = () => controller.abort();
          process.once('SIGINT', abort);
          try {
            await r.context.compact(o.provider, await r.system(), controller.signal, out.event);
            await r.store.save(s);
          } finally {
            process.off('SIGINT', abort);
          }
          break;
        }
        case 'clear':
          if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
          break;
        case 'undo':
        case 'redo':
          await r.policy.require({
            tool: command.name,
            description: `${command.name} most recent tracked file change`,
            risk: 'destructive',
          });
          out.print(await r.editor.undo(command.name === 'redo'));
          break;
        case 'hooks':
          out.print(o.config.hooks);
          break;
        case 'history':
          out.print(
            s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-20),
          );
          break;
        case 'export':
          out.print(o.redactor.value(s));
          break;
        case 'sessions':
          out.print(
            (await r.store.list()).map(({ id, title, updatedAt, root, messages, usage }) => ({
              id,
              title,
              updatedAt,
              root,
              messages: messages.length,
              usage,
            })),
          );
          break;
        case 'resume': {
          const sessions = (await r.store.list()).filter((x) => x.root === s.root);
          if (!sessions.length) {
            out.print('No sessions for this project.');
            break;
          }
          const id = command.args || (await pickSession(sessions));
          const next = await r.store.load(id);
          if (next.root !== s.root)
            throw new Error('Session belongs to a different project; use --cwd with that project.');
          return next;
        }
        case 'new':
          return newSession(s.root);
        case 'config': {
          const key = await select({
            message: 'Setting',
            choices: [
              { name: 'Inspect all settings', value: 'inspect' },
              { name: 'Default model', value: 'model' },
              { name: 'Default permissions', value: 'permissionMode' },
              { name: 'API endpoint', value: 'baseUrl' },
              {
                name: 'Authentication — API key or OAuth',
                value: 'auth',
              },
            ],
          });
          if (key === 'auth') {
            await o.reauthenticate();
            out.print('Authentication updated. Reloading the agent with the new credentials.');
            return s;
          }
          if (key === 'inspect') {
            out.print(o.config);
            break;
          }
          const user = await loadUserConfig(o.home);
          const value = await input({
            message: key,
            default: String(user[key as keyof Config] ?? ''),
          });
          if (
            key === 'baseUrl' &&
            !(await confirm({
              message:
                'This endpoint will receive your API key and repository context after restart. Save?',
              default: false,
            }))
          )
            break;
          await saveConfig(o.home, { ...user, [key]: value });
          out.print('Saved. Restart Airforce to apply.');
          break;
        }
        case 'mcp':
          if (command.args.startsWith('connect ')) {
            await o.mcp.connect(command.args.slice(8).trim());
            out.print(o.mcp.status());
          } else out.print(o.mcp.status());
          break;
        case 'doctor':
          out.print(await o.doctor());
          break;
      }
    } catch (e) {
      out.print(`Error ${o.redactor.text(formatError(e))}`);
    }
  }
  await r.store.save(s);
  return undefined;
}
