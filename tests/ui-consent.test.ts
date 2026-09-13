import { stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { slashCommands } from '../src/cli/commands.js';
import { DirectoryConsentStore } from '../src/security/directory-consent.js';
import { logo } from '../src/ui/brand.js';
import { promptViewport, slashSuggestions, suggestionWindow } from '../src/ui/prompt.js';
import { isInterruptKey } from '../src/ui/interrupt.js';
import { createTheme } from '../src/ui/theme.js';
import { AirforceError, formatError } from '../src/utils/errors.js';
import { workingFrame } from '../src/ui/activity.js';
import { formatModelPricing, formatTokens, formatUsd } from '../src/models/pricing.js';
import { MarkdownStream, renderMarkdown } from '../src/ui/markdown.js';
import { renderStatus } from '../src/ui/status.js';
import { configSchema } from '../src/config/config.js';
import { newSession } from '../src/sessions/store.js';
import { Output } from '../src/ui/output.js';
import { workspace } from './helpers.js';

describe('interactive discovery', () => {
  it('renders the Airforce Code identity at wide and narrow widths', () => {
    const theme = createTheme(false);
    expect(logo(theme, 100)).toContain('C O D E');
    expect(logo(theme, 40)).toBe('AIRFORCE CODE');
  });

  it('lists commands in registry order and filters by name or description', () => {
    expect(slashSuggestions('/', slashCommands)[0]?.name).toBe('help');
    expect(slashSuggestions('/mod', slashCommands)[0]?.name).toBe('model');
    expect(slashSuggestions('/search', slashCommands).map((command) => command.name)).toContain(
      'model',
    );
    expect(slashSuggestions('/model refresh', slashCommands)).toEqual([]);
  });

  it('keeps long and multiline input inside a single stable viewport', () => {
    expect(promptViewport('short', 5, 20)).toEqual({ text: 'short', cursorColumn: 5 });
    const viewport = promptViewport('first\nsecond and a long tail', 28, 12);
    expect(viewport.text).not.toContain('\n');
    expect([...viewport.text].length).toBeLessThanOrEqual(12);
    expect(viewport.text.startsWith('…')).toBe(true);
    expect(viewport.cursorColumn).toBeLessThanOrEqual(12);
  });

  it('scrolls a bounded window across every matching command', () => {
    expect(suggestionWindow(25, 0, 7)).toEqual({ start: 0, end: 7 });
    expect(suggestionWindow(25, 12, 7)).toEqual({ start: 9, end: 16 });
    expect(suggestionWindow(25, 24, 7)).toEqual({ start: 18, end: 25 });
  });

  it('recognizes Escape as the request interrupt key', () => {
    expect(isInterruptKey({ name: 'escape' })).toBe(true);
    expect(isInterruptKey({ name: 'up' })).toBe(false);
  });

  it('formats stable error codes for people and terminal logs', () => {
    expect(formatError(new AirforceError('Model unavailable', 'MODEL'))).toBe(
      '[MODEL] Model unavailable',
    );
    expect(formatError(new Error('Unexpected failure'))).toBe('[GENERAL] Unexpected failure');
  });

  it('renders a compact timed working status', () => {
    expect(workingFrame('Working', 0, 0, 30)).toBe('✦ Working');
    expect(workingFrame('Reading a very long authentication module', 3200, 1, 18)).toBe(
      '✧ Reading… · 3s',
    );
  });

  it('formats discovered model prices and session totals', () => {
    expect(
      formatModelPricing({
        id: 'priced',
        capabilities: {},
        pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
      }),
    ).toBe('Input $3.00 · Output $15.00 / 1M');
    expect(formatModelPricing({ id: 'unknown', capabilities: {} })).toBe('Pricing unavailable');
    expect(formatUsd(0.001234)).toBe('$0.0012');
    expect(formatTokens(12500)).toBe('12.5K');
  });

  it('renders GFM blocks, inline styles, links, tables, and fenced code for the terminal', () => {
    const theme = createTheme(false);
    const output = renderMarkdown(
      '# Result\n\n**Bold** and [docs](https://example.test).\n\n| Name | State |\n| --- | --- |\n| API | ready |\n\n```ts\nconst ready = true;\n```',
      theme,
      { color: false, width: 80 },
    );
    expect(output).toContain('◆ Result');
    expect(output).toContain('Bold and docs (https://example.test).');
    expect(output).toContain('| Name');
    expect(output).toContain('const ready = true;');
    expect(output).not.toContain('\x1b');
  });

  it('does not emit partial fenced code while Markdown is streaming', () => {
    const stream = new MarkdownStream(createTheme(false), { color: false });
    expect(stream.push('```ts\nconst')).toBe('');
    expect(stream.push(' value = 1;\n```\n')).toContain('const value = 1;');
    expect(stream.flush()).toBe('');
  });

  it('renders ordinary completed lines immediately while streaming', () => {
    const stream = new MarkdownStream(createTheme(false), { color: false });
    expect(stream.push('Inspecting the repository\n')).toContain('Inspecting the repository');
  });

  it('shows live command output instead of silently capturing it', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const output = new Output({ color: false });
    output.event({ type: 'agent.started', sessionId: 'test' });
    output.event({ type: 'tool.output', stream: 'stdout', text: 'tests running\n' });
    output.event({ type: 'agent.completed', status: 'completed', text: '' });
    expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain('tests running');
    write.mockRestore();
  });

  it('renders status as a readable dashboard with Git and context summaries', () => {
    const session = newSession('/work/example');
    session.title = 'Fix login';
    session.usage = {
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.02,
      priced: true,
      unpricedTokens: 0,
    };
    const status = renderStatus({
      session,
      config: configSchema.parse({ model: 'af-code', contextTokens: 32000 }),
      mode: 'edit',
      git: '## feature/login...origin/feature/login\n M src/login.ts\n?? tests/login.ts\n',
      contextTokens: 8000,
      theme: createTheme(false),
    });
    expect(status).toContain('Airforce Code status');
    expect(status).toContain('af-code');
    expect(status).toContain('25%');
    expect(status).toContain('1 modified · 1 untracked');
    expect(status).not.toContain('{\n');
  });
});

describe('directory consent', () => {
  it('stores canonical trusted paths privately and can revoke them', async () => {
    const w = await workspace();
    try {
      const store = new DirectoryConsentStore(w.home);
      expect(await store.isTrusted(w.root)).toBe(false);
      await store.trust(w.root);
      expect(await store.isTrusted(w.root)).toBe(true);
      expect((await store.list())[0]?.root).toBe(w.root);
      expect((await stat(`${w.home}/trusted-directories.json`)).mode & 0o777).toBe(0o600);
      expect(await store.revoke(w.root)).toBe(true);
      expect(await store.isTrusted(w.root)).toBe(false);
    } finally {
      await w.cleanup();
    }
  });
});
