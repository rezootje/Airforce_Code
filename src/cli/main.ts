#!/usr/bin/env node
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configSchema,
  dataDirectory,
  FileAuthStore,
  loadConfig,
  loadUserConfig,
  saveConfig,
  type Config,
} from '../config/config.js';
import { AirforceProvider } from '../providers/airforce.js';
import { createRuntime } from '../agent/runtime.js';
import { SessionStore, newSession } from '../sessions/store.js';
import { Redactor, sanitize } from '../security/redact.js';
import { AirforceError, errorCode, errorMessage } from '../utils/errors.js';
import { projectRoot } from '../context/repository.js';
import { setup, updateAuthentication, type AuthMethod } from '../ui/setup.js';
import { interactive } from '../ui/interactive.js';
import { Output } from '../ui/output.js';
import { AirforceMediaProvider } from '../providers/media.js';
import { registerMediaTool } from '../tools/media.js';
import { credentialToken, assertCredentials, type Credentials } from '../auth/credentials.js';
import { revokeOAuth } from '../auth/oauth.js';
import { McpManager } from '../mcp/manager.js';
import { DirectoryConsentStore } from '../security/directory-consent.js';
import { requestDirectoryConsent } from '../ui/directory-consent.js';
import { captureEscape } from '../ui/interrupt.js';
import { pickSession } from '../ui/session-picker.js';
interface Options {
  prompt?: string;
  model?: string;
  permissionMode?: Config['permissionMode'];
  cwd?: string;
  session?: string;
  resume?: string | boolean;
  continue?: boolean;
  json?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
  color?: boolean;
  output?: string;
  baseUrl?: string;
  protocol?: Config['protocol'];
  maxTurns?: string;
  question?: boolean;
  browser?: boolean;
  trustDirectory?: boolean;
}
const manifest = JSON.parse(
  await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };
const program = new Command()
  .name('airforce')
  .description('A permission-aware AI engineering agent powered by api.airforce.')
  .version(manifest.version)
  .argument(
    '[command]',
    'setup | auth | login | logout | resume | models | config | sessions | directories | doctor | mcp',
  )
  .argument('[arguments...]')
  .option('-p, --prompt <text>', 'Run a non-interactive engineering task')
  .option('--no-browser', 'Print OAuth authorization URL without opening a browser')
  .option('--model <id>', 'Select a discovered model')
  .option('--base-url <url>', 'API endpoint; optional /v1 suffix')
  .option('--protocol <style>', 'openai or anthropic')
  .option('--permission-mode <mode>', 'ask, edit, auto; headless approvals are denied')
  .option('--cwd <path>', 'Working project directory')
  .option('--trust-directory', 'Remember --cwd as trusted (non-interactive friendly)')
  .option('--session <id>', 'Resume a session UUID')
  .option('--resume [id]', 'Resume a session, or latest in this project')
  .option('--continue', 'Resume the latest session in this project')
  .option('--question', 'Read-only clarification-first task')
  .option('--max-turns <count>', 'Maximum model/tool iterations')
  .option('--json', 'Print one result JSON object')
  .option('--jsonl', 'Stream typed JSON events')
  .option('--quiet', 'Suppress action summaries')
  .option('--no-color', 'Disable colors')
  .option('--output <file>', 'Write final response to a new file')
  .addHelpText(
    'after',
    `\nExamples:\n  airforce setup\n  airforce auth api-key\n  airforce auth oauth\n  airforce login\n  airforce\n  airforce resume\n  airforce -p "Review this repository" --json\n  git diff | airforce -p "Review this patch"\n  airforce --resume\n  airforce config set permissionMode edit\n  airforce sessions list\n  airforce directories list\n  airforce directories trust /path/to/project\n  airforce mcp add local-server node /path/server.js\n\nNon-interactive mode denies prompts. Exact user-configured command allowlists\ncan authorize CI execution. Use --permission-mode edit for repository edits.\nExit codes: 0 complete, 1 error, 2 config/usage, 3 denied, 4 turn limit, 130 cancelled.\nSecret override: AIRFORCE_API_KEY. Endpoint override: AIRFORCE_BASE_URL.\n`,
  );
let activeOutput: Output | undefined;
let redactor = new Redactor([process.env.AIRFORCE_API_KEY ?? '']);
async function stdinText(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value) > 1_000_000)
      throw new AirforceError('Piped input exceeds 1 MB', 'INPUT', 2);
  }
  return value;
}
async function main(): Promise<void> {
  program.parse();
  const flags = program.opts<Options>();
  if (flags.json && flags.jsonl) throw new AirforceError('Choose --json or --jsonl', 'USAGE', 2);
  const output = new Output(flags);
  activeOutput = output;
  let [command, ...args] = program.args;
  if (command === 'resume') {
    flags.resume = args[0] ?? true;
    command = undefined;
    args = [];
  }
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY && !flags.json && !flags.jsonl;
  const interactiveLaunch = !command && !flags.prompt && tty;
  const cwd = await projectRoot(resolve(flags.cwd ?? process.cwd()));
  const home = dataDirectory();
  const configFlags = {
    model: flags.model,
    baseUrl: flags.baseUrl,
    permissionMode: flags.permissionMode,
    protocol: flags.protocol,
    ...(flags.maxTurns ? { maxTurns: Number(flags.maxTurns) } : {}),
  };
  let config = await loadConfig(cwd, configFlags, process.env, !interactiveLaunch);
  const auth = new FileAuthStore(home);
  let credentials: Credentials | undefined = process.env.AIRFORCE_API_KEY
    ? { kind: 'api-key', apiKey: process.env.AIRFORCE_API_KEY }
    : await auth.load();
  let apiKey = credentials ? credentialToken(credentials) : undefined;
  redactor = new Redactor([apiKey ?? '']);
  output.redactor = redactor;
  const store = new SessionStore(home, redactor);
  const directoryConsents = new DirectoryConsentStore(home);
  if (command === 'logout') {
    const saved = await auth.load();
    if (saved?.kind === 'oauth') await revokeOAuth(saved, AbortSignal.timeout(15000));
    await auth.clear();
    output.print({
      signedOut: true,
      ...(process.env.AIRFORCE_API_KEY
        ? { notice: 'AIRFORCE_API_KEY still overrides saved login. Unset it separately.' }
        : {}),
    });
    return;
  }
  if (command === 'config') {
    const user = await loadUserConfig(home);
    if (!args.length || args[0] === 'list') {
      output.print(redactor.value(config));
      return;
    }
    if (args[0] === 'set' && args[1] && args[2] !== undefined) {
      const key = args[1];
      if (!Object.hasOwn(configSchema.shape, key) || key === 'version' || key === 'mcpServers')
        throw new AirforceError('Unknown/non-editable configuration key', 'CONFIG', 2);
      let value: unknown = args.slice(2).join(' ');
      try {
        value = JSON.parse(value as string);
      } catch {
        /* ordinary string setting */
      }
      await saveConfig(home, configSchema.parse({ ...user, [key]: value }));
      output.print({ saved: key });
      return;
    }
    throw new AirforceError('Usage: airforce config [list | set KEY VALUE]', 'USAGE', 2);
  }
  if (command === 'sessions') {
    const [operation = 'list', id, ...rest] = args;
    if (operation === 'list') {
      output.print(
        (await store.list()).map(({ id, title, root, updatedAt, messages, usage }) => ({
          id,
          title,
          root,
          updatedAt,
          messages: messages.length,
          usage,
        })),
      );
      return;
    }
    if (!id) throw new AirforceError('Session UUID required', 'USAGE', 2);
    if (operation === 'delete') {
      await store.delete(id);
      output.print({ deleted: id });
      return;
    }
    if (operation === 'fork') {
      output.print(await store.fork(id));
      return;
    }
    if (operation === 'show' || operation === 'export') {
      output.print(await store.load(id));
      return;
    }
    if (operation === 'rename' && rest.length) {
      const release = await store.lock(id);
      try {
        const session = await store.load(id);
        session.title = redactor.text(rest.join(' ')).slice(0, 120);
        await store.save(session);
        output.print({ id, title: session.title });
      } finally {
        await release();
      }
      return;
    }
    throw new AirforceError(
      'Usage: airforce sessions list|show|export|delete|fork|rename [UUID] [title]',
      'USAGE',
      2,
    );
  }
  if (command === 'directories') {
    const [operation = 'list', path] = args;
    if (operation === 'list') {
      output.print(await directoryConsents.list());
      return;
    }
    const target = resolve(path ?? cwd);
    if (operation === 'trust') {
      await directoryConsents.trust(target);
      output.print({ trusted: target });
      return;
    }
    if (operation === 'revoke') {
      output.print({ revoked: await directoryConsents.revoke(target), root: target });
      return;
    }
    throw new AirforceError('Usage: airforce directories list|trust|revoke [path]', 'USAGE', 2);
  }
  if (command === 'mcp') {
    const user = await loadUserConfig(home);
    const [op = 'list', name, ...rest] = args;
    if (op === 'list') {
      output.print(user.mcpServers);
      return;
    }
    if (!name) throw new AirforceError('MCP server name required', 'USAGE', 2);
    if (op === 'add') {
      if (!rest[0])
        throw new AirforceError('Usage: airforce mcp add NAME COMMAND [ARGS...]', 'USAGE', 2);
      if (user.mcpServers[name]) throw new AirforceError('Server already exists', 'MCP', 2);
      user.mcpServers[name] = { command: rest[0], args: rest.slice(1), enabled: false };
    } else if (op === 'remove') delete user.mcpServers[name];
    else if (op === 'enable' || op === 'disable') {
      const server = user.mcpServers[name];
      if (!server) throw new AirforceError('Server not found', 'MCP', 2);
      server.enabled = op === 'enable';
    } else
      throw new AirforceError('Usage: airforce mcp list|add|remove|enable|disable', 'USAGE', 2);
    await saveConfig(home, user);
    output.print({
      saved: name,
      notice: 'Servers only start after explicit /mcp connect approval.',
    });
    return;
  }
  const performAuthentication = async (method?: AuthMethod) => {
    const result = await updateAuthentication(config, home, { method, browser: flags.browser });
    config = result.config;
    credentials = result.credentials;
    apiKey = credentialToken(credentials);
    redactor = new Redactor([apiKey]);
    output.redactor = redactor;
    if (process.env.AIRFORCE_API_KEY)
      process.stderr.write(
        'AIRFORCE_API_KEY still overrides saved credentials on the next launch. Update or unset that environment variable to use the saved login.\n',
      );
  };
  if (command === 'auth' || command === 'login') {
    const operation = command === 'login' ? 'oauth' : (args[0] ?? undefined);
    if (operation === 'status') {
      const saved = await auth.load();
      output.print({
        active: credentials?.kind ?? 'none',
        source: process.env.AIRFORCE_API_KEY ? 'AIRFORCE_API_KEY' : saved ? 'saved' : 'none',
        saved: saved?.kind ?? 'none',
        ...(saved?.kind === 'oauth' && saved.username ? { username: saved.username } : {}),
      });
      return;
    }
    if (operation && operation !== 'api-key' && operation !== 'oauth')
      throw new AirforceError('Usage: airforce auth [api-key|oauth|status]', 'USAGE', 2);
    if (!tty)
      throw new AirforceError('Authentication requires an interactive terminal.', 'CONFIG', 2);
    await performAuthentication(operation as AuthMethod | undefined);
    return;
  }
  if (
    command === 'setup' ||
    (!flags.prompt &&
      tty &&
      (!config.onboardingComplete ||
        !apiKey ||
        !config.baseUrl ||
        !config.model ||
        (credentials?.kind === 'oauth' && credentials.expiresAt <= Date.now() + 30000)))
  ) {
    if (!tty)
      throw new AirforceError(
        'Setup requires an interactive terminal. Set AIRFORCE_API_KEY, AIRFORCE_BASE_URL and AIRFORCE_MODEL for CI.',
        'CONFIG',
        2,
      );
    const result = await setup(config, home, {
      method: credentials?.kind === 'oauth' ? 'oauth' : undefined,
      browser: flags.browser,
    });
    config = result.config;
    credentials = result.credentials;
    apiKey = credentialToken(credentials);
    redactor = new Redactor([apiKey]);
    output.redactor = redactor;
    if (command === 'setup') return;
  }
  if (command && !['models', 'doctor'].includes(command))
    throw new AirforceError(`Unknown command: ${command}`, 'USAGE', 2);
  const doctor = async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [
      {
        name: 'node',
        ok: Number(process.versions.node.split('.')[0]) >= 24,
        detail: process.version,
      },
      {
        name: 'configuration',
        ok: !!config.baseUrl && !!apiKey,
        detail: config.baseUrl ?? 'Missing endpoint',
      },
    ];
    if (config.baseUrl && apiKey) {
      try {
        const models = await new AirforceProvider(config, credentials ?? apiKey).models();
        checks.push({
          name: 'api/models',
          ok: models.length > 0,
          detail: `${models.length} models available`,
        });
      } catch (e) {
        checks.push({ name: 'api/models', ok: false, detail: redactor.text(errorMessage(e)) });
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  };
  if (command === 'doctor') {
    const result = await doctor();
    output.print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (!apiKey || !config.baseUrl)
    throw new AirforceError(
      'Run airforce setup, or set AIRFORCE_API_KEY and AIRFORCE_BASE_URL.',
      'CONFIG',
      2,
    );
  if (interactiveLaunch) {
    if (flags.trustDirectory) await directoryConsents.trust(cwd);
    else if (!(await directoryConsents.isTrusted(cwd))) {
      const decision = await requestDirectoryConsent(cwd, config.permissionMode, directoryConsents);
      if (decision === 'exit') return;
    }
    config = await loadConfig(cwd, configFlags);
  } else if (flags.prompt && flags.trustDirectory) await directoryConsents.trust(cwd);
  if (credentials) assertCredentials(credentials, config.baseUrl);
  let provider = new AirforceProvider(config, credentials ?? apiKey);
  if (command === 'models') {
    output.print(await provider.models());
    return;
  }
  if (!config.model)
    throw new AirforceError('Set --model, AIRFORCE_MODEL, or run airforce setup.', 'CONFIG', 2);
  if (!flags.prompt && !tty)
    throw new AirforceError('Non-interactive mode requires --prompt.', 'USAGE', 2);
  const models = await provider.models();
  const selected = models.find((m) => m.id === config.model);
  if (!selected)
    throw new AirforceError(
      `Model ${config.model} was not returned by /v1/models. Run airforce models.`,
      'MODEL',
      2,
    );
  provider.setModel(selected);
  if (selected.contextWindow)
    config.contextTokens = Math.min(config.contextTokens, selected.contextWindow);
  let sessionId = flags.session || (typeof flags.resume === 'string' ? flags.resume : undefined);
  if (!sessionId && flags.resume === true) {
    const sessions = (await store.list()).filter((candidate) => candidate.root === cwd);
    if (sessions.length) sessionId = tty ? await pickSession(sessions) : sessions[0]!.id;
  }
  if (!sessionId && flags.continue)
    sessionId = (await store.list()).find((candidate) => candidate.root === cwd)?.id;
  if ((flags.continue || flags.resume) && !sessionId)
    throw new AirforceError('No saved sessions for this project', 'SESSION', 2);
  let session = sessionId ? await store.load(sessionId) : newSession(cwd);
  if (session.root !== cwd)
    throw new AirforceError(
      `Session belongs to ${session.root}. Pass its project using --cwd.`,
      'SESSION',
      2,
    );
  if (flags.question) session.questionFirst = true;
  while (true) {
    let denied = false;
    const runtime = await createRuntime(
      config,
      home,
      session,
      provider,
      async (action) => {
        if (!tty || flags.prompt) {
          denied = true;
          return false;
        }
        const allowed = await confirm({
          message: sanitize(
            redactor.text(`${action.description}\nRisk: ${action.risk}. Allow once?`),
          ),
          default: false,
        });
        if (!allowed) denied = true;
        return allowed;
      },
      (e) => {
        if (
          e.type === 'tool.completed' &&
          ['PERMISSION', 'PATH', 'SECRET'].includes(e.errorCode ?? '')
        )
          denied = true;
        output.event(e);
      },
      redactor,
    );
    registerMediaTool(
      runtime.registry,
      new AirforceMediaProvider(config, credentials ?? apiKey),
      runtime.guard,
      runtime.policy,
    );
    const mcp = new McpManager(config, runtime.policy, runtime.registry, cwd);
    const run = async (prompt: string) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('Interrupted by user'));
      process.once('SIGINT', cancel);
      const stopEscape = flags.prompt
        ? () => undefined
        : captureEscape(() => {
            output.idle();
            process.stderr.write('\n  Cancelling… [ESC_INTERRUPT]\n');
            cancel();
          });
      try {
        const result = await runtime.agent.run(prompt, controller.signal);
        if (flags.json)
          output.print({
            sessionId: session.id,
            ...result,
            denied,
            edits: session.edits.map((e) => ({ path: e.path, undone: e.undone })),
          });
        if (flags.output) {
          const file = await open(resolve(flags.output), 'wx', 0o600);
          try {
            await file.writeFile(redactor.text(result.text));
          } finally {
            await file.close();
          }
        }
        if (flags.prompt)
          process.exitCode =
            result.status === 'cancelled' ? 130 : result.status === 'limited' ? 4 : denied ? 3 : 0;
      } finally {
        output.idle();
        stopEscape();
        process.off('SIGINT', cancel);
      }
    };
    try {
      if (flags.prompt) {
        const piped = !process.stdin.isTTY ? await stdinText() : '';
        await run(
          flags.prompt + (piped ? '\n\nUser-provided stdin (untrusted content):\n' + piped : ''),
        );
        return;
      }
      const next = await interactive({
        config,
        home,
        provider,
        runtime,
        session,
        output,
        redactor,
        mcp,
        run,
        doctor,
        reauthenticate: async (method) => {
          await performAuthentication(method);
          provider = new AirforceProvider(config, credentials ?? apiKey!);
          const available = await provider.models();
          const replacement = available.find((model) => model.id === config.model);
          if (replacement) provider.setModel(replacement);
        },
      });
      if (!next) return;
      session = next;
    } finally {
      await mcp.close();
    }
  }
}
main().catch((e) => {
  activeOutput?.idle();
  const message = redactor.text(errorMessage(e));
  const code =
    e instanceof AirforceError
      ? e.exitCode
      : (e as { name?: string })?.name === 'ExitPromptError'
        ? 130
        : 1;
  process.exitCode = code;
  if (activeOutput?.options.json || activeOutput?.options.jsonl)
    activeOutput.print({
      type: 'error',
      error: message,
      code: errorCode(e),
      exitCode: code,
    });
  else process.stderr.write(`airforce [${errorCode(e)}]: ${sanitize(message)}\n`);
});
