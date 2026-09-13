import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspace, FakeProvider } from './helpers.js';
import { createRuntime } from '../src/agent/runtime.js';
import { configSchema } from '../src/config/config.js';
import { newSession } from '../src/sessions/store.js';
import { Redactor } from '../src/security/redact.js';
import { hash } from '../src/tools/files.js';
import { LocalExecutor } from '../src/tools/process.js';
import { AirforceMediaProvider } from '../src/providers/media.js';
import { McpManager } from '../src/mcp/manager.js';
const signal = () => new AbortController().signal;
it('filters credential files out of Git diffs and refuses commits containing pre-existing user changes', async () => {
  const w = await workspace();
  try {
    const ex = new LocalExecutor();
    const git = async (args: string[]) => {
      const r = await ex.run('git', args, w.root, signal());
      if (r.exitCode) throw new Error(r.stderr);
      return r;
    };
    await git(['init']);
    await git(['config', 'user.email', 'airforce@example.invalid']);
    await git(['config', 'user.name', 'Airforce Test']);
    await writeFile(join(w.root, 'code.ts'), 'original');
    await writeFile(join(w.root, '.env'), 'ODD_NAME=do-not-expose');
    await git(['add', '.']);
    await git(['commit', '-m', 'Initial']);
    await writeFile(join(w.root, '.env'), 'ODD_NAME=new-secret');
    await writeFile(join(w.root, 'code.ts'), 'user change');
    const r = await createRuntime(
      configSchema.parse({ permissionMode: 'edit' }),
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => true,
      () => {},
      new Redactor(),
    );
    const diff = await r.git.run(['diff', '--no-ext-diff', '--no-textconv']);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('user change');
    expect(diff.stdout).not.toContain('new-secret');
    await r.editor.change('code.ts', 'agent change', hash('user change'));
    const commit = await r.registry.execute(
      {
        id: 'commit',
        name: 'git_commit',
        arguments: JSON.stringify({ paths: ['code.ts'], message: 'Change code' }),
      },
      { signal: signal(), emit: () => {} },
    );
    expect(commit.ok).toBe(false);
    expect(commit.content).toContain('Pre-existing user changes');
  } finally {
    await w.cleanup();
  }
});
it('redo follows undo order across multiple edits and new edits invalidate redo', async () => {
  const w = await workspace();
  try {
    const r = await createRuntime(
      configSchema.parse({ permissionMode: 'edit' }),
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    await r.editor.change('a', 'one', null);
    await r.editor.change('a', 'two', hash('one'));
    await r.editor.undo();
    await r.editor.undo();
    await r.editor.undo(true);
    expect(await readFile(join(w.root, 'a'), 'utf8')).toBe('one');
    await r.editor.undo(true);
    expect(await readFile(join(w.root, 'a'), 'utf8')).toBe('two');
    await r.editor.undo();
    await r.editor.change('a', 'three', hash('one'));
    await expect(r.editor.undo(true)).rejects.toThrow('Nothing to redo');
  } finally {
    await w.cleanup();
  }
});
it('hooks cannot inherit an approved tool privilege', async () => {
  const w = await workspace();
  try {
    const config = configSchema.parse({
      permissionMode: 'auto',
      hooks: [
        { event: 'before_write', command: process.execPath, args: ['-e', 'console.log("hook")'] },
      ],
    });
    const r = await createRuntime(
      config,
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    const result = await r.registry.execute(
      {
        id: 'write',
        name: 'write_file',
        arguments: '{"path":"a","content":"value","expectedHash":null}',
      },
      { signal: signal(), emit: () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Permission denied');
    await expect(readFile(join(w.root, 'a'))).rejects.toThrow();
  } finally {
    await w.cleanup();
  }
});
it('MCP startup requires explicit approval even when globally enabled', async () => {
  const w = await workspace();
  try {
    const config = configSchema.parse({
      permissionMode: 'auto',
      mcpServers: { test: { command: process.execPath, args: [], enabled: true } },
    });
    const r = await createRuntime(
      config,
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    const mcp = new McpManager(config, r.policy, r.registry, w.root);
    await expect(mcp.connect('test')).rejects.toThrow('Permission denied');
    expect(mcp.status()[0]?.connected).toBe(false);
    await mcp.close();
  } finally {
    await w.cleanup();
  }
});
it('exact command allowlists work headlessly and do not match appended arguments', async () => {
  const w = await workspace();
  try {
    const argv = [process.execPath, '-e', 'console.log("ok")'];
    const config = configSchema.parse({ allowedCommands: [argv] });
    const r = await createRuntime(
      config,
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    const run = (args: string[]) =>
      r.registry.execute(
        {
          id: 'run',
          name: 'run_command',
          arguments: JSON.stringify({ command: argv[0], args, purpose: 'Test exact approval' }),
        },
        { signal: signal(), emit: () => {} },
      );
    expect((await run(argv.slice(1))).ok).toBe(true);
    expect((await run([...argv.slice(1), 'extra'])).ok).toBe(false);
  } finally {
    await w.cleanup();
  }
});
it('media rejects OAuth credentials without the images scope before making a request', async () => {
  const provider = new AirforceMediaProvider(configSchema.parse({}), {
    kind: 'oauth',
    accessToken: 'airf_oat_synthetic',
    expiresAt: Date.now() + 60_000,
    scope: 'profile chat',
    issuer: 'https://api.airforce',
    clientId: 'test-client',
  });
  await expect(
    provider.generateImage({ model: 'image', prompt: 'a blue square' }, signal()),
  ).rejects.toThrow('images scope');
});

it('connects to a real stdio MCP fixture and routes calls through the registry', async () => {
  const w = await workspace();
  try {
    const config = configSchema.parse({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
          enabled: true,
        },
      },
    });
    let approvals = 0;
    const r = await createRuntime(
      config,
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => {
        approvals++;
        return true;
      },
      () => {},
      new Redactor(),
    );
    const mcp = new McpManager(config, r.policy, r.registry, w.root);
    try {
      await mcp.connect('fixture');
      const definition = r.registry.definitions().find((t) => t.name.startsWith('mcp_fixture_'));
      expect(definition).toBeDefined();
      const result = await r.registry.execute(
        { id: 'mcp', name: definition!.name, arguments: '{"input":{"message":"verified MCP"}}' },
        { signal: signal(), emit: () => {} },
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain('verified MCP');
      expect(approvals).toBe(2);
    } finally {
      await mcp.close();
    }
  } finally {
    await w.cleanup();
  }
}, 15000);
