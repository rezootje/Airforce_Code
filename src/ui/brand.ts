import type { Theme } from './theme.js';

const wideLogo = String.raw`
    _    ___ ____  _____ ___  ____   ____ _____
   / \  |_ _|  _ \|  ___/ _ \|  _ \ / ___| ____|
  / _ \  | || |_) | |_ | | | | |_) | |   |  _|
 / ___ \ | ||  _ <|  _|| |_| |  _ <| |___| |___
/_/   \_\___|_| \_\_|   \___/|_| \_\\____|_____|
                    C O D E`;

export function logo(theme: Theme, width = process.stdout.columns ?? 80): string {
  if (width < 58) return `${theme.strong(theme.accent('AIRFORCE'))} ${theme.strong('CODE')}`;
  const lines = wideLogo.trimEnd().split('\n');
  const code = lines.pop()!;
  return `${theme.accent(lines.join('\n'))}\n${theme.strong(code)}`;
}

export function panel(title: string, lines: string[], theme: Theme, width = 76): string {
  const inner = Math.max(30, Math.min(width, (process.stdout.columns ?? width + 4) - 4));
  const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const crop = (value: string) =>
    plain(value).length > inner ? `${plain(value).slice(0, inner - 1)}…` : value;
  const border = '─'.repeat(inner + 2);
  return [
    theme.muted(`╭─ ${title} ${'─'.repeat(Math.max(0, inner - title.length - 1))}╮`),
    ...lines.map((line) => {
      const value = crop(line);
      return `${theme.muted('│')} ${value}${' '.repeat(Math.max(0, inner - plain(value).length))} ${theme.muted('│')}`;
    }),
    theme.muted(`╰${border}╯`),
  ].join('\n');
}
