import { it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workspace } from './helpers.js';
import { configSchema, FileAuthStore, saveConfig } from '../src/config/config.js';
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end('{"data":[{"id":"mock","capabilities":{"tools":true}}]}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body) as { messages: { role: string; content: string }[] };
    const last = data.messages.at(-1);
    res.setHeader('content-type', 'text/event-stream');
    if (last?.role === 'user' && last.content.includes('wait for escape')) {
      res.flushHeaders();
      await new Promise<void>((resolveRequest) => req.once('close', resolveRequest));
      return;
    }
    let event: unknown;
    if (last?.role === 'tool') {
      event = {
        choices: [{ delta: { content: 'Verified README contents.\n' }, finish_reason: 'stop' }],
      };
    } else {
      event = {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'read-1',
                  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
    }
    res.end('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli/main.ts'), ...args],
      { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}
it('launches CLI with mock API, executes tools, emits pure JSON and resumes persisted history', async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.root, 'README.md'), 'Repository test document');
    const env = {
      AIRFORCE_HOME: w.home,
      AIRFORCE_API_KEY: 'test-key-not-paid',
      AIRFORCE_BASE_URL: url,
      AIRFORCE_MODEL: 'mock',
    };
    const result = await cli(['--cwd', w.root, '-p', 'Read README', '--json'], env);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { sessionId: string; text: string };
    expect(output.text).toContain('Verified');
    const session = JSON.parse(
      await readFile(join(w.home, 'sessions', output.sessionId + '.json'), 'utf8'),
    ) as { messages: unknown[] };
    expect(session.messages).toHaveLength(4);
    const resumed = await cli(
      ['--cwd', w.root, '--resume', output.sessionId, '-p', 'Read again', '--jsonl'],
      env,
    );
    expect(resumed.code).toBe(0);
    const events = resumed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
    expect(events.some((e) => e.type === 'agent.completed')).toBe(true);
  } finally {
    await w.cleanup();
  }
}, 15000);
it('reports missing setup in machine-readable mode and can inspect config without credentials', async () => {
  const w = await workspace();
  try {
    const env = {
      AIRFORCE_HOME: w.home,
      AIRFORCE_API_KEY: '',
      AIRFORCE_BASE_URL: '',
      AIRFORCE_MODEL: '',
    };
    const result = await cli(['--cwd', w.root, '-p', 'hello', '--json'], env);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('type', 'error');
    const help = await cli(['--help'], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('headless approvals are denied');
  } finally {
    await w.cleanup();
  }
});

it('reports authentication source without exposing the saved API key', async () => {
  const w = await workspace();
  try {
    await new FileAuthStore(w.home).save({ kind: 'api-key', apiKey: 'status-private-key' });
    const result = await cli(['--cwd', w.root, '--json', 'auth', 'status'], {
      AIRFORCE_HOME: w.home,
      AIRFORCE_API_KEY: '',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('status-private-key');
    expect(JSON.parse(result.stdout)).toEqual({
      active: 'api-key',
      source: 'saved',
      saved: 'api-key',
    });
  } finally {
    await w.cleanup();
  }
});

it.skipIf(process.platform !== 'linux')(
  'completes real first-run onboarding in a pseudoterminal',
  async () => {
    const w = await workspace();
    try {
      const env = {
        ...process.env,
        AIRFORCE_HOME: w.home,
        AIRFORCE_API_KEY: '',
        AIRFORCE_BASE_URL: url,
        AIRFORCE_MODEL: '',
      };
      const result = await new Promise<{ output: string; code: number }>(
        (resolvePromise, reject) => {
          const command = [
            process.execPath,
            '--import',
            'tsx',
            resolve('src/cli/main.ts'),
            '--cwd',
            w.root,
            'setup',
          ];
          const child = spawn(
            'python3',
            [resolve('tests/terminal-driver.py'), JSON.stringify(command)],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let output = '';
          child.stdout.on('data', (d) => (output += String(d)));
          child.stderr.on('data', (d) => (output += String(d)));
          child.on('error', reject);
          child.on('close', (code) => resolvePromise({ output, code: code ?? 1 }));
        },
      );
      expect(result.output).toContain('PTY onboarding passed');
      expect(result.code).toBe(0);
      expect(await readFile(join(w.home, 'credentials.json'), 'utf8')).toContain(
        'synthetic-pty-key',
      );
      expect(await readFile(join(w.home, 'config.json'), 'utf8')).not.toContain(
        'synthetic-pty-key',
      );
    } finally {
      await w.cleanup();
    }
  },
  30000,
);

it.skipIf(process.platform !== 'linux')(
  'shows directory consent once and provides a searchable slash-command palette',
  async () => {
    const w = await workspace();
    try {
      // Keep this synthetic project isolated even when the host temp directory
      // happens to sit inside an unrelated Git worktree.
      await mkdir(join(w.root, '.git'));
      const config = configSchema.parse({
        onboardingComplete: true,
        baseUrl: url,
        model: 'mock',
      });
      await saveConfig(w.home, config);
      await new FileAuthStore(w.home).save({ kind: 'api-key', apiKey: 'synthetic-ui-key' });
      const env = { ...process.env, AIRFORCE_HOME: w.home, AIRFORCE_API_KEY: '' };
      const command = [
        process.execPath,
        '--import',
        'tsx',
        resolve('src/cli/main.ts'),
        '--cwd',
        w.root,
      ];
      const result = await new Promise<{ output: string; code: number }>(
        (resolvePromise, reject) => {
          const child = spawn(
            'python3',
            [resolve('tests/interactive-driver.py'), JSON.stringify(command)],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let output = '';
          child.stdout.on('data', (data) => (output += String(data)));
          child.stderr.on('data', (data) => (output += String(data)));
          child.on('error', reject);
          child.on('close', (code) => resolvePromise({ output, code: code ?? 1 }));
        },
      );
      expect(result.output).toContain('PTY interactive UI passed');
      expect(result.code).toBe(0);
      expect(await readFile(join(w.home, 'trusted-directories.json'), 'utf8')).toContain(w.root);
    } finally {
      await w.cleanup();
    }
  },
  30000,
);
