import { emitKeypressEvents } from 'node:readline';
import type { SlashCommand } from '../cli/commands.js';
import { sanitize } from '../security/redact.js';
import type { Theme } from './theme.js';

export interface PromptContext {
  model: string;
  mode: string;
  project: string;
  cost: string;
}

export interface PromptViewport {
  text: string;
  cursorColumn: number;
}

export function promptViewport(value: string, cursor: number, width: number): PromptViewport {
  const before = sanitize(value.slice(0, cursor)).replaceAll('\n', ' ↵ ');
  const complete = sanitize(value).replaceAll('\n', ' ↵ ');
  const characters = [...complete];
  const cursorOffset = [...before].length;
  const available = Math.max(1, width);
  const start = Math.max(0, cursorOffset - available + 1);
  const visible = characters.slice(start, start + available).join('');
  return {
    text: `${start > 0 ? '…' : ''}${start > 0 ? [...visible].slice(1).join('') : visible}`,
    cursorColumn: Math.min(available, Math.max(0, cursorOffset - start)),
  };
}

export function slashSuggestions(value: string, commands: SlashCommand[]): SlashCommand[] {
  if (!value.startsWith('/') || /\s/.test(value)) return [];
  const query = value.slice(1).toLowerCase();
  const score = (command: SlashCommand): number => {
    const name = command.name.toLowerCase();
    if (!query) return 1;
    if (name === query) return 2_000;
    if (name.startsWith(query)) return 1_000;
    if (name.includes(query)) return 500 - name.indexOf(query);
    const description = command.description.toLowerCase();
    return description.includes(query) ? 100 - description.indexOf(query) : -1;
  };
  return commands
    .map((command, index) => ({ command, index, score: score(command) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

export function suggestionWindow(total: number, selected: number, pageSize: number) {
  const size = Math.max(1, Math.min(total, pageSize));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
  return { start, end: start + size };
}

export async function readAgentInput(
  commands: SlashCommand[],
  history: string[],
  context: PromptContext,
  theme: Theme,
): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const input = process.stdin;
  const output = process.stdout;
  const previousRaw = input.isRaw;
  let value = '';
  let cursor = 0;
  let selected = 0;
  let historyIndex = -1;
  let historyDraft = '';
  let closed = false;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(`\n${theme.muted('╭─')} ${theme.strong('You')}\n`);

  const currentSuggestions = () => slashSuggestions(value, commands);
  const render = () => {
    const matches = currentSuggestions();
    if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
    const prefix = `${theme.muted('╰─')} ${theme.accent('❯')} `;
    const prefixWidth = 5;
    const columns = Math.max(20, output.columns ?? 80);
    const viewport = promptViewport(value, cursor, columns - prefixWidth - 1);
    const crop = (text: string) => {
      const characters = [...text];
      return characters.length < columns ? text : `${characters.slice(0, columns - 2).join('')}…`;
    };
    const supportLines: string[] = [];
    if (matches.length) {
      const pageSize = Math.max(3, Math.min(9, (output.rows ?? 24) - 5));
      const window = suggestionWindow(matches.length, selected, pageSize);
      const suggestions = matches.slice(window.start, window.end);
      supportLines.push(
        theme.muted(
          crop(`  Commands · ${window.start + 1}-${window.end} of ${matches.length} · ↑↓ scroll`),
        ),
      );
      for (const [index, command] of suggestions.entries()) {
        const active = window.start + index === selected;
        const marker = active ? '›' : ' ';
        const usage = command.usage ? ` ${command.usage}` : '';
        const line = crop(`  ${marker} /${command.name}${usage}  ${command.description}`);
        supportLines.push(active ? theme.strong(line) : theme.muted(line));
      }
    } else {
      supportLines.push(
        theme.muted(
          crop(
            `  ${sanitize(context.project)}  ·  ${sanitize(context.model)}  ·  ${sanitize(context.cost)}  ·  / commands`,
          ),
        ),
      );
    }
    // Keep the cursor anchored on the input row. Every render clears that row and
    // everything below it, redraws the palette, then returns to the input cursor.
    // This avoids save/restore sequences, which are inconsistently implemented by terminals.
    output.write(`\r\x1b[J${prefix}${value ? viewport.text : theme.muted('Ask Airforce Code…')}`);
    for (const line of supportLines) output.write(`\n${line}`);
    if (supportLines.length) output.write(`\x1b[${supportLines.length}A`);
    output.write('\r');
    const cursorColumn = prefixWidth + viewport.cursorColumn;
    if (cursorColumn) output.write(`\x1b[${cursorColumn}C`);
    output.write('\x1b[?25h');
  };

  const insert = (text: string) => {
    const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    value = value.slice(0, cursor) + safe + value.slice(cursor);
    cursor += safe.length;
    selected = 0;
    historyIndex = -1;
  };

  return new Promise<string | undefined>((resolve) => {
    const finish = (result?: string) => {
      if (closed) return;
      closed = true;
      output.off('resize', render);
      input.off('keypress', onKeypress);
      input.setRawMode(previousRaw ?? false);
      input.pause();
      output.write('\r\x1b[J');
      if (result !== undefined)
        output.write(`${theme.muted('╰─')} ${theme.accent('❯')} ${sanitize(result)}\n`);
      else output.write('\n');
      resolve(result);
    };

    const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      const suggestions = currentSuggestions();
      if (key.ctrl && key.name === 'c') {
        if (value) {
          value = '';
          cursor = 0;
          selected = 0;
          render();
        } else finish();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        value = value.slice(cursor);
        cursor = 0;
      } else if (key.ctrl && key.name === 'l') {
        output.write('\x1b[2J\x1b[H');
      } else if (key.ctrl && key.name === 'j') {
        insert('\n');
      } else if (key.name === 'return' || key.name === 'enter') {
        if (suggestions.length && !/\s/.test(value)) {
          const command = suggestions[selected]!;
          finish(`/${command.name}`);
        } else if (value.endsWith('\\')) {
          value = `${value.slice(0, -1)}\n`;
          cursor = value.length;
        } else finish(value);
        return;
      } else if (key.name === 'tab' && suggestions.length) {
        const command = suggestions[selected]!;
        value = `/${command.name}${command.usage ? ' ' : ''}`;
        cursor = value.length;
        selected = 0;
      } else if (key.name === 'space' && suggestions.length && !/\s/.test(value)) {
        value = `/${suggestions[selected]!.name} `;
        cursor = value.length;
        selected = 0;
      } else if (key.name === 'up') {
        if (suggestions.length) selected = (selected - 1 + suggestions.length) % suggestions.length;
        else if (history.length) {
          if (historyIndex < 0) historyDraft = value;
          historyIndex = Math.min(history.length - 1, historyIndex + 1);
          value = history[historyIndex] ?? value;
          cursor = value.length;
        }
      } else if (key.name === 'down') {
        if (suggestions.length) selected = (selected + 1) % suggestions.length;
        else if (historyIndex >= 0) {
          historyIndex--;
          value = historyIndex >= 0 ? (history[historyIndex] ?? '') : historyDraft;
          cursor = value.length;
        }
      } else if (key.name === 'pageup' && suggestions.length) {
        selected = Math.max(0, selected - Math.max(3, Math.min(9, (output.rows ?? 24) - 5)));
      } else if (key.name === 'pagedown' && suggestions.length) {
        selected = Math.min(
          suggestions.length - 1,
          selected + Math.max(3, Math.min(9, (output.rows ?? 24) - 5)),
        );
      } else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(value.length, cursor + 1);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = value.length;
      else if (key.name === 'backspace') {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
          selected = 0;
        }
      } else if (key.name === 'delete') value = value.slice(0, cursor) + value.slice(cursor + 1);
      else if (key.name === 'escape') {
        value = '';
        cursor = 0;
        selected = 0;
      } else if (text && !key.ctrl) insert(text);
      render();
    };

    input.on('keypress', onKeypress);
    output.on('resize', render);
    render();
  });
}
