import { highlight, supportsLanguage } from 'cli-highlight';
import { Lexer, type Token, type Tokens } from 'marked';
import type { Theme } from './theme.js';

const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export interface MarkdownOptions {
  color?: boolean;
  width?: number;
}

function visibleLength(value: string): number {
  return value.replace(ansi, '').length;
}

function inline(tokens: Token[], theme: Theme): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.tokens ? inline(token.tokens, theme) : token.text;
        case 'escape':
          return token.text;
        case 'strong':
          return theme.strong(inline((token as Tokens.Strong).tokens, theme));
        case 'em':
          return theme.italic(inline((token as Tokens.Em).tokens, theme));
        case 'del':
          return theme.strikethrough(inline((token as Tokens.Del).tokens, theme));
        case 'codespan':
          return theme.accent(` ${token.text} `);
        case 'br':
          return '\n';
        case 'link': {
          const link = token as Tokens.Link;
          const label = inline(link.tokens, theme);
          return `${theme.accent(label)} ${theme.muted(`(${link.href})`)}`;
        }
        case 'image':
          return `${token.text || 'image'} ${theme.muted(`(${token.href})`)}`;
        case 'html':
          return token.text.replace(/<[^>]*>/g, '');
        default:
          return 'text' in token && typeof token.text === 'string' ? token.text : '';
      }
    })
    .join('');
}

function renderTable(token: Tokens.Table, theme: Theme, width: number): string {
  const rows = [token.header, ...token.rows].map((row) =>
    row.map((cell) => inline(cell.tokens, theme)),
  );
  const columns = token.header.length;
  const maxCell = Math.max(8, Math.floor((width - columns * 3 - 1) / Math.max(columns, 1)));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.min(maxCell, Math.max(...rows.map((row) => visibleLength(row[column] ?? '')))),
  );
  const cell = (value: string, column: number) => {
    const available = widths[column] ?? 8;
    const plain = value.replace(ansi, '');
    const shown =
      plain.length > available ? `${plain.slice(0, Math.max(1, available - 1))}…` : value;
    return `${shown}${' '.repeat(Math.max(0, available - visibleLength(shown)))}`;
  };
  const line = theme.muted(`+-${widths.map((size) => '-'.repeat(size)).join('-+-')}-+`);
  return [
    line,
    `| ${rows[0]?.map((value, i) => theme.strong(cell(value, i))).join(' | ')} |`,
    line,
    ...rows.slice(1).map((row) => `| ${row.map((value, i) => cell(value, i)).join(' | ')} |`),
    line,
  ].join('\n');
}

function blocks(tokens: Token[], theme: Theme, color: boolean, width: number, indent = ''): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'space':
          return '';
        case 'heading': {
          const heading = token as Tokens.Heading;
          const marker = token.depth === 1 ? '◆' : token.depth === 2 ? '◇' : '›';
          return `${indent}${theme.accent(marker)} ${theme.strong(inline(heading.tokens, theme))}`;
        }
        case 'paragraph':
          return `${indent}${inline((token as Tokens.Paragraph).tokens, theme)}`;
        case 'text':
          return `${indent}${token.tokens ? inline(token.tokens, theme) : token.text}`;
        case 'blockquote':
          return blocks((token as Tokens.Blockquote).tokens, theme, color, width - 2, indent)
            .split('\n')
            .map((line) => `${indent}${theme.accent('│')} ${line.slice(indent.length)}`)
            .join('\n');
        case 'hr':
          return `${indent}${theme.muted('─'.repeat(Math.max(12, Math.min(width, 72))))}`;
        case 'code': {
          const codeToken = token as Tokens.Code;
          const language = codeToken.lang?.split(/\s+/)[0]?.toLowerCase();
          let code: string = codeToken.text;
          if (color && language && supportsLanguage(language)) {
            try {
              code = highlight(code, { language, ignoreIllegals: true });
            } catch {
              // Unknown grammars remain readable as plain code.
            }
          }
          const label = language ? ` ${language} ` : ' code ';
          return [
            `${indent}${theme.muted('┌─')}${theme.accent(label)}${theme.muted('─'.repeat(Math.max(1, 8 - label.length)))}`,
            ...code.split('\n').map((line) => `${indent}${theme.muted('│')} ${line}`),
            `${indent}${theme.muted('└─')}`,
          ].join('\n');
        }
        case 'list': {
          const list = token as Tokens.List;
          let number = typeof list.start === 'number' ? list.start : 1;
          return list.items
            .map((item: Tokens.ListItem) => {
              const marker = list.ordered
                ? `${number++}.`
                : item.task
                  ? item.checked
                    ? '☑'
                    : '☐'
                  : '•';
              const body = blocks(item.tokens, theme, color, width - 3, `${indent}  `).trimStart();
              const continuation = `${indent}${' '.repeat(visibleLength(marker) + 1)}`;
              return `${indent}${theme.accent(marker)} ${body.replaceAll('\n', `\n${continuation}`)}`;
            })
            .join('\n');
        }
        case 'table':
          return `${indent}${renderTable(token as Tokens.Table, theme, width).replaceAll('\n', `\n${indent}`)}`;
        case 'html':
          return `${indent}${token.text.replace(/<[^>]*>/g, '')}`;
        default:
          return 'tokens' in token && Array.isArray(token.tokens)
            ? blocks(token.tokens, theme, color, width, indent)
            : '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

export function renderMarkdown(
  markdown: string,
  theme: Theme,
  options: MarkdownOptions = {},
): string {
  const width = Math.max(30, options.width ?? process.stdout.columns ?? 80);
  const tokens = new Lexer({ gfm: true, breaks: false }).lex(markdown);
  return blocks(tokens, theme, options.color !== false, width).trimEnd();
}

/** Buffers unfinished Markdown blocks so streaming never prints half a table or code fence. */
export class MarkdownStream {
  private source = '';

  constructor(
    private readonly theme: Theme,
    private readonly options: MarkdownOptions = {},
  ) {}

  push(delta: string): string {
    this.source += delta;
    const boundary = this.completeBlockBoundary();
    if (boundary === 0) return '';
    const complete = this.source.slice(0, boundary);
    this.source = this.source.slice(boundary);
    const rendered = renderMarkdown(complete, this.theme, this.options);
    return rendered ? `${rendered}\n` : '';
  }

  flush(): string {
    const rendered = renderMarkdown(this.source, this.theme, this.options);
    this.source = '';
    return rendered;
  }

  clear(): void {
    this.source = '';
  }

  private completeBlockBoundary(): number {
    let inFence: string | undefined;
    let boundary = 0;
    let offset = 0;
    for (const line of this.source.match(/.*(?:\n|$)/g) ?? []) {
      if (!line) continue;
      offset += line.length;
      const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        if (!inFence) inFence = fence[0];
        else if (fence[0] === inFence) {
          inFence = undefined;
          boundary = offset;
        }
      } else if (!inFence) {
        const trimmed = line.trim();
        // Pipe tables need their header, delimiter and rows parsed together.
        // Other complete lines are safe to render immediately, so a response
        // remains visibly streaming even when the model emits no blank lines.
        if (trimmed === '') boundary = offset;
        else if (!/^\|.*\|$/u.test(trimmed)) boundary = offset;
      }
    }
    return boundary;
  }
}
