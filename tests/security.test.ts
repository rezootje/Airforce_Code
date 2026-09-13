import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { PathGuard } from '../src/security/paths.js';
import { PermissionPolicy, classifyCommand } from '../src/security/permissions.js';
import { Redactor, sanitize } from '../src/security/redact.js';
import { configSchema, endpointSchema } from '../src/config/config.js';
import { workspace } from './helpers.js';
import type { Mode } from '../src/agent/types.js';
describe('security boundaries', () => {
  it('rejects traversal, protected paths, directory writes, and symlinks', async () => {
    const w = await workspace();
    try {
      const guard = await PathGuard.create(w.root, ['private']);
      await writeFile(join(w.base, 'outside'), 'secret');
      await symlink(join(w.base, 'outside'), join(w.root, 'link'));
      for (const path of [
        '../outside',
        '.env',
        '.env.local',
        '.ssh/key',
        '.git/config',
        'private/data',
        'link',
      ])
        await expect(guard.resolve(path, { write: true })).rejects.toThrow();
      await expect(guard.resolve('.', { write: true, allowDirectory: true })).rejects.toThrow();
      await mkdir(join(w.root, 'src'));
      expect(await guard.resolve('src/new.ts', { write: true })).toBe(join(w.root, 'src/new.ts'));
    } finally {
      await w.cleanup();
    }
  });
  it.each(['ask', 'edit', 'auto'] as Mode[])(
    'requires approval for unsandboxed executables in %s',
    async (mode) => {
      const approve = vi.fn(async () => false);
      const policy = new PermissionPolicy(mode, configSchema.parse({}), approve, () => {});
      await policy.require({ tool: 'read_file', description: 'read', risk: 'read' });
      await expect(
        policy.require({
          tool: 'run_command',
          description: 'run',
          risk: 'execute',
          command: ['node', '-e', 'bad()'],
        }),
      ).rejects.toThrow('Permission denied');
      expect(approve).toHaveBeenCalledOnce();
    },
  );
  it('enforces question-first even in auto mode', async () => {
    const approve = vi.fn(async () => true);
    const policy = new PermissionPolicy('auto', configSchema.parse({}), approve, () => {});
    policy.questionFirst = true;
    await expect(
      policy.require({ tool: 'write_file', description: 'write', risk: 'write' }),
    ).rejects.toThrow('Question-first');
    expect(approve).not.toHaveBeenCalled();
  });
  it('configuration denies override approvals', async () => {
    const approve = vi.fn(async () => true);
    const policy = new PermissionPolicy(
      'auto',
      configSchema.parse({ deniedCommands: ['node'] }),
      approve,
      () => {},
    );
    await expect(
      policy.require({
        tool: 'run_command',
        description: 'run',
        risk: 'execute',
        command: ['node', 'test.js'],
      }),
    ).rejects.toThrow('denied');
    await expect(
      policy.require({ tool: 'web', description: 'fetch', risk: 'network' }),
    ).rejects.toThrow('disabled');
    expect(approve).not.toHaveBeenCalled();
  });
  it('classifies dangerous commands conservatively', () => {
    expect(classifyCommand(['rm', '-rf', '/'])).toBe('destructive');
    expect(classifyCommand(['sudo', 'apt', 'remove', 'x'])).toBe('privileged');
    expect(classifyCommand(['git', 'push', '--force'])).toBe('destructive');
    expect(classifyCommand(['npm', 'install'])).toBe('network');
  });
  it('redacts nested values and strips terminal control sequences', () => {
    const r = new Redactor(['my-real-key-12345']);
    expect(r.value({ apiKey: 'my-real-key-12345', body: 'sk-12345678901234567890' })).toEqual({
      apiKey: '[REDACTED]',
      body: '[REDACTED]',
    });
    expect(sanitize('\x1b]52;c;c2VjcmV0\x07hello\x1b[31m\u202eevil')).toBe('helloevil');
  });
  it('rejects credential-bearing and insecure endpoints', () => {
    for (const url of [
      'http://remote.example',
      'https://u:p@example.com',
      'https://example.com?key=x',
      'file:///tmp',
    ])
      expect(endpointSchema.safeParse(url).success).toBe(false);
    expect(endpointSchema.safeParse('http://127.0.0.1:1234').success).toBe(true);
  });
  it('does not treat hard links as symlinks (editor must independently reject them)', async () => {
    const w = await workspace();
    try {
      await writeFile(join(w.root, 'one'), 'data');
      await link(join(w.root, 'one'), join(w.root, 'two'));
      expect(await (await PathGuard.create(w.root)).resolve('two')).toBe(join(w.root, 'two'));
    } finally {
      await w.cleanup();
    }
  });
});

it('redacts private-key blocks split across streaming events', async () => {
  const { StreamRedactor } = await import('../src/security/redact.js');
  const stream = new StreamRedactor(new Redactor());
  expect(stream.text('-----BEGIN PRIVATE KEY-----\n')).toContain('REDACTED');
  expect(stream.text('base64-secret-content\n')).toBe('');
  expect(stream.text('-----END PRIVATE KEY-----\n')).toBe('');
  expect(stream.text('ordinary text\n')).toBe('ordinary text\n');
});
