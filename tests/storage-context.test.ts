import { it, expect } from 'vitest';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, FakeProvider } from './helpers.js';
import { configSchema, loadConfig, saveConfig } from '../src/config/config.js';
import { SessionStore, newSession, repairInterruptedTools } from '../src/sessions/store.js';
import { PathGuard } from '../src/security/paths.js';
import { loadInstructions } from '../src/instructions/load.js';
import { ContextManager } from '../src/context/manager.js';
import { RepositoryIndex } from '../src/context/repository.js';
import { parseSlash } from '../src/cli/commands.js';
import { fuzzyScore } from '../src/ui/setup.js';
import type { Message } from '../src/agent/types.js';
it('merges config with explicit precedence while rejecting project authority escalation', async () => {
  const w = await workspace();
  try {
    await saveConfig(w.home, configSchema.parse({ model: 'user' }));
    await writeFile(join(w.root, '.airforce.json'), JSON.stringify({ model: 'project' }));
    const env = { AIRFORCE_HOME: w.home, AIRFORCE_MODEL: 'env' };
    expect((await loadConfig(w.root, { model: 'flag' }, env)).model).toBe('flag');
    expect((await loadConfig(w.root, {}, env)).model).toBe('env');
    await writeFile(
      join(w.root, '.airforce.json'),
      JSON.stringify({ baseUrl: 'https://evil.example', permissionMode: 'auto' }),
    );
    expect((await loadConfig(w.root, {}, env, false)).model).toBe('env');
    await expect(loadConfig(w.root, {}, env)).rejects.toThrow('Invalid project');
  } finally {
    await w.cleanup();
  }
});
it('persists, locks, forks and validates sessions without leaking keys', async () => {
  const w = await workspace();
  try {
    const store = new SessionStore(w.home);
    const session = newSession(w.root);
    session.messages.push({ role: 'user', content: 'sk-12345678901234567890' });
    await store.save(session);
    expect((await store.load(session.id)).messages[0]?.content).toBe('[REDACTED]');
    const fork = await store.fork(session.id);
    expect(fork.id).not.toBe(session.id);
    expect(fork.edits).toEqual([]);
    const release = await store.lock(session.id);
    await expect(store.lock(session.id)).rejects.toThrow('locked');
    await release();
    await writeFile(join(store.directory, session.id + '.lock'), '99999999');
    const recovered = await store.lock(session.id);
    await recovered();
    await expect(store.load('../bad')).rejects.toThrow('UUID');
    if (process.platform !== 'win32')
      expect((await stat(join(w.home, 'sessions', session.id + '.json'))).mode & 0o077).toBe(0);
    await store.delete(fork.id);
    expect(await store.list()).toHaveLength(1);
  } finally {
    await w.cleanup();
  }
});
it('rejects unsupported session versions and repairs interrupted tool batches', async () => {
  const w = await workspace();
  try {
    const store = new SessionStore(w.home);
    const s = newSession(w.root);
    await store.save(s);
    await writeFile(join(store.directory, s.id + '.json'), JSON.stringify({ ...s, version: 99 }));
    await expect(store.load(s.id)).rejects.toThrow('Cannot read session');
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read', arguments: '{}' },
          { id: 'b', name: 'write', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: 'ok' },
      { role: 'user', content: 'continue' },
    ];
    repairInterruptedTools(messages);
    expect(messages[2]?.toolCallId).toBe('b');
    expect(messages[3]?.role).toBe('user');
  } finally {
    await w.cleanup();
  }
});
it('loads closest instructions first with deterministic file precedence', async () => {
  const w = await workspace();
  try {
    await mkdir(join(w.root, 'src'));
    for (const p of ['AIRFORCE.md', 'AGENTS.md', 'CLAUDE.md', 'src/AIRFORCE.md', 'src/AGENTS.md'])
      await writeFile(join(w.root, p), p);
    const files = await loadInstructions(await PathGuard.create(w.root), 'src/new.ts');
    expect(files.map((f) => f.path.replaceAll('\\', '/'))).toEqual([
      'src/AIRFORCE.md',
      'src/AGENTS.md',
      'AIRFORCE.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  } finally {
    await w.cleanup();
  }
});
it('respects nested ignore rules and internal exclusions', async () => {
  const w = await workspace();
  try {
    await mkdir(join(w.root, 'src'));
    await mkdir(join(w.root, 'node_modules'));
    await writeFile(join(w.root, '.gitignore'), '*.log\n');
    await writeFile(join(w.root, 'src/.gitignore'), 'generated.ts\n');
    for (const p of [
      'a.ts',
      'x.log',
      'src/x.log',
      'src/generated.ts',
      'src/ok.ts',
      'node_modules/hidden.js',
      '.env',
    ])
      await writeFile(join(w.root, p), 'x');
    const files = await new RepositoryIndex(await PathGuard.create(w.root)).files();
    expect(files).toContain('src/ok.ts');
    for (const p of ['x.log', 'src/x.log', 'src/generated.ts', 'node_modules/hidden.js', '.env'])
      expect(files).not.toContain(p);
  } finally {
    await w.cleanup();
  }
});
it('compacts while preserving verbatim user requirements and full history', async () => {
  const s = newSession('/project');
  s.requirements = ['Do not modify the database schema.'];
  s.messages = [
    { role: 'user', content: s.requirements[0]! },
    { role: 'assistant', content: 'Tests failed in auth.ts' },
  ];
  const manager = new ContextManager(s, 32000, 4096);
  const provider = new FakeProvider([
    () => [{ type: 'text', text: 'Pending: fix auth.ts tests; keep schema unchanged.' }],
  ]);
  await manager.compact(provider, 'system', new AbortController().signal, () => {});
  expect(s.messages).toHaveLength(2);
  expect(manager.build('system')[0]?.content).toContain(s.requirements[0]);
  expect(s.compactedUntil).toBe(2);
});
it('parses slash arguments and fuzzy model search', () => {
  expect(parseSlash('/question build\na plugin')).toEqual({
    name: 'question',
    args: 'build\na plugin',
  });
  expect(parseSlash('normal')).toBeUndefined();
  expect(fuzzyScore('gpt', 'great powerful tool')).toBeGreaterThan(0);
  expect(fuzzyScore('xyz', 'model')).toBe(-1);
});

it('rejects stale session writers after another process saved a newer revision', async () => {
  const w = await workspace();
  try {
    const store = new SessionStore(w.home);
    const original = newSession(w.root);
    await store.save(original);
    const stale = await store.load(original.id);
    original.title = 'Newer history';
    await store.save(original);
    stale.title = 'Stale overwrite';
    await expect(store.save(stale)).rejects.toThrow('another process');
    expect((await store.load(original.id)).title).toBe('Newer history');
  } finally {
    await w.cleanup();
  }
});
