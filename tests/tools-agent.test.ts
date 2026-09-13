import { it, expect } from 'vitest';
import { writeFile, readFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, FakeProvider } from './helpers.js';
import { createRuntime } from '../src/agent/runtime.js';
import { configSchema } from '../src/config/config.js';
import { newSession } from '../src/sessions/store.js';
import { Redactor } from '../src/security/redact.js';
import { hash } from '../src/tools/files.js';
import { LocalExecutor } from '../src/tools/process.js';
import type { AgentEvent } from '../src/agent/types.js';
it('completes a multi-step inspect, patch, verify loop and persists tool results', async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.root, 'hello.ts'), 'export const value = 1;\n');
    const events: AgentEvent[] = [];
    const provider = new FakeProvider([
      () => [
        { type: 'tool', call: { id: 'read', name: 'read_file', arguments: '{"path":"hello.ts"}' } },
      ],
      (messages) => {
        const result = JSON.parse(messages.at(-1)!.content) as { sha256: string };
        return [
          {
            type: 'tool',
            call: {
              id: 'edit',
              name: 'patch_file',
              arguments: JSON.stringify({
                path: 'hello.ts',
                expectedHash: result.sha256,
                oldText: 'value = 1',
                newText: 'value = 2',
              }),
            },
          },
        ];
      },
      () => [
        {
          type: 'tool',
          call: { id: 'check', name: 'read_file', arguments: '{"path":"hello.ts"}' },
        },
      ],
      (messages) => {
        expect(messages.at(-1)?.content).toContain('value = 2');
        return [
          { type: 'usage', input: 120, output: 30, costUsd: 0.0012 },
          { type: 'text', text: 'Updated hello.ts. Verified its contents; tests were not run.\n' },
        ];
      },
    ]);
    const s = newSession(w.root);
    const r = await createRuntime(
      configSchema.parse({ permissionMode: 'edit' }),
      w.home,
      s,
      provider,
      async () => false,
      (e) => events.push(e),
      new Redactor(),
    );
    const result = await r.agent.run('Change value to 2', new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(await readFile(join(w.root, 'hello.ts'), 'utf8')).toContain('value = 2');
    expect((await r.store.load(s.id)).edits).toHaveLength(1);
    expect(events.some((e) => e.type === 'file.changed')).toBe(true);
    expect(events).toContainEqual({ type: 'agent.progress', message: 'Preparing context' });
    expect(events).toContainEqual({ type: 'agent.progress', message: 'Running 1 tool' });
    expect(s.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.0012,
      priced: true,
      unpricedTokens: 0,
    });
    expect(provider.requests).toHaveLength(4);
  } finally {
    await w.cleanup();
  }
});
it('continues automatically after the model reaches its output limit', async () => {
  const w = await workspace();
  try {
    const events: AgentEvent[] = [];
    const provider = new FakeProvider([
      () => [
        {
          type: 'tool',
          call: {
            id: 'first-file',
            name: 'write_file',
            arguments: '{"path":"index.html","content":"<main>Game</main>","expectedHash":null}',
          },
        },
      ],
      () => [{ type: 'incomplete', reason: 'length' }],
      (messages) => {
        expect(messages.at(-1)?.content).toContain('replace it with smaller valid tool calls');
        return [
          {
            type: 'tool',
            call: {
              id: 'second-file',
              name: 'write_file',
              arguments: '{"path":"game.js","content":"const ready = true;","expectedHash":null}',
            },
          },
        ];
      },
      () => [{ type: 'text', text: 'Created and verified the game files.' }],
    ]);
    const session = newSession(w.root);
    const runtime = await createRuntime(
      configSchema.parse({ permissionMode: 'edit' }),
      w.home,
      session,
      provider,
      async () => false,
      (event) => events.push(event),
      new Redactor(),
    );
    const result = await runtime.agent.run('Build a game', new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed' });
    expect(await readFile(join(w.root, 'index.html'), 'utf8')).toContain('Game');
    expect(await readFile(join(w.root, 'game.js'), 'utf8')).toContain('ready');
    expect(events).toContainEqual({
      type: 'warning',
      message: 'Model reached its output limit; continuing automatically with smaller steps.',
    });
    expect(provider.requests).toHaveLength(4);
  } finally {
    await w.cleanup();
  }
});
it('refuses stale edits and undo conflicts, supports undo and redo', async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.root, 'a'), 'old');
    const r = await createRuntime(
      configSchema.parse({ permissionMode: 'edit' }),
      w.home,
      newSession(w.root),
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    await expect(r.editor.change('a', 'new', 'bad')).rejects.toThrow('changed');
    await r.editor.change('a', 'new', hash('old'));
    await r.editor.undo();
    expect(await readFile(join(w.root, 'a'), 'utf8')).toBe('old');
    await r.editor.undo(true);
    expect(await readFile(join(w.root, 'a'), 'utf8')).toBe('new');
    await writeFile(join(w.root, 'a'), 'user edit');
    await expect(r.editor.undo()).rejects.toThrow('changed');
    await link(join(w.root, 'a'), join(w.root, 'hardlink'));
    await expect(r.editor.read('hardlink')).rejects.toThrow('hard-linked');
  } finally {
    await w.cleanup();
  }
});
it('returns permission errors to the model and enforces question mode', async () => {
  const w = await workspace();
  try {
    const s = newSession(w.root);
    s.questionFirst = true;
    const provider = new FakeProvider([
      () => [
        {
          type: 'tool',
          call: {
            id: 'w',
            name: 'write_file',
            arguments: '{"path":"a","content":"oops","expectedHash":null}',
          },
        },
      ],
      (messages) => {
        expect(messages.at(-1)?.content).toContain('Question-first');
        return [{ type: 'text', text: 'What behavior should this implement?' }];
      },
    ]);
    const r = await createRuntime(
      configSchema.parse({ permissionMode: 'auto' }),
      w.home,
      s,
      provider,
      async () => true,
      () => {},
      new Redactor(),
    );
    await r.agent.run('Build it', new AbortController().signal);
    await expect(readFile(join(w.root, 'a'))).rejects.toThrow();
  } finally {
    await w.cleanup();
  }
});
it('does not overwrite a session if its lock is held', async () => {
  const w = await workspace();
  try {
    const s = newSession(w.root);
    const r = await createRuntime(
      configSchema.parse({}),
      w.home,
      s,
      new FakeProvider([]),
      async () => false,
      () => {},
      new Redactor(),
    );
    await r.store.save(s);
    const release = await r.store.lock(s.id);
    const before = await readFile(join(r.store.directory, s.id + '.json'), 'utf8');
    await expect(r.agent.run('do not save', new AbortController().signal)).rejects.toThrow(
      'locked',
    );
    expect(await readFile(join(r.store.directory, s.id + '.json'), 'utf8')).toBe(before);
    await release();
  } finally {
    await w.cleanup();
  }
});
it('runs argument arrays literally, captures failure and enforces cancellation/timeout', async () => {
  const w = await workspace();
  try {
    const executor = new LocalExecutor();
    const result = await executor.run(
      process.execPath,
      [
        '-e',
        'console.log(process.argv[1]);console.error("bad");process.exitCode=7',
        '$(echo injected)',
      ],
      w.root,
      new AbortController().signal,
    );
    expect(result.stdout).toContain('$(echo injected)');
    expect(result.stderr).toContain('bad');
    expect(result.exitCode).toBe(7);
    const timeout = await executor.run(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      w.root,
      new AbortController().signal,
      100,
    );
    expect(timeout.timedOut).toBe(true);
    const controller = new AbortController();
    const pending = executor.run(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      w.root,
      controller.signal,
    );
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  } finally {
    await w.cleanup();
  }
});
it('does not inherit API keys in child environments', async () => {
  const w = await workspace();
  try {
    process.env.AIRFORCE_API_KEY = 'test-private-value';
    const result = await new LocalExecutor().run(
      process.execPath,
      ['-e', 'console.log(process.env.AIRFORCE_API_KEY ?? "absent")'],
      w.root,
      new AbortController().signal,
    );
    expect(result.stdout.trim()).toBe('absent');
  } finally {
    delete process.env.AIRFORCE_API_KEY;
    await w.cleanup();
  }
});
