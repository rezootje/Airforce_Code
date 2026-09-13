import { z } from 'zod';
import type { Executor, ProcessResult } from './process.js';
import type { ToolRegistry } from './registry.js';
import type { Session } from '../sessions/store.js';
import type { FileEditor } from './files.js';
import { AirforceError } from '../utils/errors.js';
export class Git {
  constructor(
    readonly root: string,
    private readonly executor: Executor,
    private readonly excludedPaths: string[] = [],
  ) {}
  run(args: string[], signal = AbortSignal.timeout(15000)): Promise<ProcessResult> {
    const safeArgs = [...args];
    // Pathspec filtering happens before content reaches the model or terminal.
    if (
      (args[0] === 'diff' || (args[0] === 'show' && !args.some((a) => a.includes(':')))) &&
      !args.includes('--name-only')
    ) {
      if (!safeArgs.includes('--')) safeArgs.push('--', '.');
      for (const pattern of [
        '**/.env*',
        '**/.ssh/**',
        '**/.aws/**',
        '**/.azure/**',
        '**/.gnupg/**',
        '**/.kube/**',
        '**/.npmrc',
        '**/.netrc',
        '**/credentials*',
        '**/*.pem',
        '**/*.key',
        '**/*.p12',
        '**/*.pfx',
        '**/id_rsa',
        '**/id_ed25519',
      ])
        safeArgs.push(':(icase,glob,exclude)' + pattern);
      for (const path of this.excludedPaths)
        if (path && !path.startsWith('..'))
          safeArgs.push(':(literal,exclude)' + path.replaceAll('\\', '/'));
    }
    return this.executor.run(
      'git',
      [
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '-c',
        'core.pager=cat',
        ...safeArgs,
      ],
      this.root,
      signal,
    );
  }
  async status(): Promise<string> {
    const result = await this.run(['status', '--short', '--branch']);
    return result.exitCode === 0 ? result.stdout : 'Not a Git repository';
  }
}
export function registerGitTools(
  registry: ToolRegistry,
  git: Git,
  session: Session,
  editor: FileEditor,
): void {
  registry.register({
    name: 'git_inspect',
    description:
      'Inspect status, diff, staged diff, log, show, blame, or branches without external diff/textconv helpers.',
    schema: z
      .object({
        operation: z.enum(['status', 'diff', 'staged', 'log', 'show', 'blame', 'branches']),
        path: z.string().optional(),
        revision: z
          .string()
          .regex(/^[a-zA-Z0-9_/.~^@{}-]+$/)
          .optional(),
      })
      .strict(),
    action: (i) => ({
      tool: 'git_inspect',
      description: `Inspecting Git ${i.operation}`,
      risk: 'read',
    }),
    execute: async (i, c) => {
      if (i.path) await editor.guard.resolve(i.path);
      if (i.revision?.startsWith('-'))
        throw new AirforceError('Revision cannot start with -', 'GIT');
      const args: Record<typeof i.operation, string[]> = {
        status: ['status', '--short', '--branch'],
        diff: ['diff', '--no-ext-diff', '--no-textconv'],
        staged: ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
        log: ['log', '-20', '--format=%h %ad %s', '--date=short'],
        show: ['show', '--no-ext-diff', '--no-textconv', i.revision ?? 'HEAD'],
        blame: ['blame', '--', i.path ?? ''],
        branches: ['branch', '--list'],
      };
      const command = args[i.operation];
      if (i.path && i.operation !== 'blame') command.push('--', i.path);
      return git.run(command, c.signal);
    },
  });
  registry.register({
    name: 'git_branch',
    description: 'Create and switch to a new branch after approval. Existing changes are retained.',
    schema: z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/) }).strict(),
    action: (i) => ({
      tool: 'git_branch',
      description: `Creating branch ${i.name}`,
      risk: 'execute',
      command: ['git', 'switch', '-c', i.name],
    }),
    execute: (i, c) => git.run(['switch', '-c', i.name], c.signal),
  });
  registry.register({
    name: 'git_commit',
    description:
      'Commit only exact files created/changed by this session. Refuses an existing staged index or files with pre-existing modifications. Always requests approval; Git hooks may execute.',
    schema: z
      .object({ message: z.string().min(1).max(500), paths: z.array(z.string()).min(1).max(100) })
      .strict(),
    action: (i) => ({
      tool: 'git_commit',
      description: `Commit ${i.paths.join(', ')} with message: ${i.message} (Git hooks can execute)`,
      risk: 'execute',
      command: ['git', 'commit', '-m', i.message],
      paths: i.paths,
    }),
    execute: async (i, c) => {
      const staged = await git.run(['diff', '--cached', '--name-only'], c.signal);
      if (staged.exitCode || staged.stdout.trim())
        throw new AirforceError(
          'Existing staged changes: commit manually or unstage them first.',
          'GIT',
        );
      for (const path of i.paths) {
        await editor.guard.resolve(path, { write: true });
        const edits = session.edits.filter(
          (e) => e.path === path && !e.undone && e.state === 'applied',
        );
        const first = edits[0];
        const last = edits.at(-1);
        if (!first || !last || (await editor.read(path)) !== last.after)
          throw new AirforceError(`Not exclusively tracked by this session: ${path}`, 'GIT');
        const head = await git.run(['show', `HEAD:./${path}`], c.signal);
        if (first.before !== null && (head.exitCode !== 0 || head.stdout !== first.before))
          throw new AirforceError(
            `Pre-existing user changes in ${path}; refusing to include them`,
            'GIT',
          );
        if (first.before === null && head.exitCode === 0)
          throw new AirforceError(`Pre-existing deletion in ${path}`, 'GIT');
      }
      const add = await git.run(['add', '--', ...i.paths], c.signal);
      if (add.exitCode !== 0) return add;
      return git.run(['commit', '-m', i.message, '--', ...i.paths], c.signal);
    },
  });
  registry.register({
    name: 'git_index',
    description:
      'Stage or unstage explicit regular project paths after approval. Staging can execute configured Git filters. This does not authorize committing unrelated work.',
    schema: z
      .object({
        operation: z.enum(['stage', 'unstage']),
        paths: z.array(z.string()).min(1).max(100),
      })
      .strict(),
    action: (i) => ({
      tool: 'git_index',
      description: `Git ${i.operation}: ${i.paths.join(', ')}`,
      risk: 'execute',
      paths: i.paths,
      command: ['git', i.operation, ...i.paths],
    }),
    execute: async (i, c) => {
      for (const path of i.paths) await editor.guard.resolve(path, { write: true });
      return git.run(
        i.operation === 'stage' ? ['add', '--', ...i.paths] : ['reset', '--', ...i.paths],
        c.signal,
      );
    },
  });
}
