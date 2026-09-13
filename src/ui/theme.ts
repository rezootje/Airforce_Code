import pc from 'picocolors';

export interface Theme {
  accent(value: string): string;
  muted(value: string): string;
  success(value: string): string;
  warning(value: string): string;
  danger(value: string): string;
  strong(value: string): string;
  italic(value: string): string;
  strikethrough(value: string): string;
}

export function createTheme(enabled = !process.env.NO_COLOR && !!process.stdout.isTTY): Theme {
  const colors = pc.createColors(enabled);
  return {
    accent: colors.cyan,
    muted: colors.dim,
    success: colors.green,
    warning: colors.yellow,
    danger: colors.red,
    strong: colors.bold,
    italic: colors.italic,
    strikethrough: colors.strikethrough,
  };
}
