import { it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace } from './helpers.js';
import { configSchema } from '../src/config/config.js';
const prompts = vi.hoisted(() => ({
  input: vi.fn(),
  password: vi.fn(),
  search: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => prompts);
import { setup, updateAuthentication } from '../src/ui/setup.js';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('validates credentials, discovers models, offers OAuth and persists key separately', async () => {
  const w = await workspace();
  try {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    prompts.input.mockResolvedValue('https://configured.test');
    prompts.password.mockResolvedValue('setup-private-key');
    prompts.select
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('api-key')
      .mockResolvedValueOnce('edit');
    prompts.search.mockResolvedValue('new-model');
    prompts.confirm.mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"data":[{"id":"new-model"}]}')),
    );
    const result = await setup(configSchema.parse({}), w.home);
    expect(result.config.model).toBe('new-model');
    expect(result.config.onboardingComplete).toBe(true);
    expect(prompts.select.mock.calls[1]?.[0].choices[1].value).toBe('oauth');
    expect(prompts.select.mock.calls[1]?.[0].choices[1].disabled).toBe(true);
    expect(await readFile(join(w.home, 'config.json'), 'utf8')).not.toContain('setup-private-key');
    expect(await readFile(join(w.home, 'credentials.json'), 'utf8')).toContain('setup-private-key');
  } finally {
    await w.cleanup();
  }
});

it('validates a replacement API key before overwriting saved credentials', async () => {
  const w = await workspace();
  try {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const config = configSchema.parse({
      onboardingComplete: true,
      baseUrl: 'https://configured.test',
      model: 'current-model',
    });
    const { FileAuthStore } = await import('../src/config/config.js');
    const auth = new FileAuthStore(w.home);
    await auth.save({ kind: 'api-key', apiKey: 'old-private-key' });
    prompts.select.mockResolvedValueOnce('custom');
    prompts.input.mockResolvedValue('https://configured.test');
    prompts.password.mockResolvedValueOnce('invalid-private-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 401 })),
    );
    await expect(updateAuthentication(config, w.home, { method: 'api-key' })).rejects.toThrow();
    expect(await auth.load()).toEqual({ kind: 'api-key', apiKey: 'old-private-key' });

    prompts.select.mockResolvedValueOnce('custom');
    prompts.password.mockResolvedValueOnce('new-private-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"data":[{"id":"current-model"}]}')),
    );
    await updateAuthentication(config, w.home, { method: 'api-key' });
    expect(await auth.load()).toEqual({ kind: 'api-key', apiKey: 'new-private-key' });
  } finally {
    await w.cleanup();
  }
});
