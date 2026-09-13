import { basename } from 'node:path';
import type { Config } from '../config/config.js';
import type { Session } from '../sessions/store.js';
import { formatTokens, formatUsd } from '../models/pricing.js';
import { sanitize } from '../security/redact.js';
import { panel } from './brand.js';
import type { Theme } from './theme.js';

interface StatusOptions {
  session: Session;
  config: Config;
  mode: Config['permissionMode'];
  git: string;
  contextTokens: number;
  theme: Theme;
}

function gitSummary(status: string): { branch: string; changes: string } {
  if (status.trim() === 'Not a Git repository')
    return { branch: 'Not a Git repository', changes: '' };
  const lines = status.trimEnd().split('\n');
  const branch = (lines.shift() ?? '').replace(/^##\s*/, '') || 'Detached HEAD';
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith('??')) untracked++;
    else {
      if (line[0] && line[0] !== ' ') staged++;
      if (line[1] && line[1] !== ' ') unstaged++;
    }
  }
  const parts = [
    staged ? `${staged} staged` : '',
    unstaged ? `${unstaged} modified` : '',
    untracked ? `${untracked} untracked` : '',
  ].filter(Boolean);
  return { branch, changes: parts.join(' · ') || 'clean' };
}

function meter(value: number, maximum: number, theme: Theme): string {
  const ratio = maximum > 0 ? Math.min(1, value / maximum) : 0;
  const filled = Math.round(ratio * 12);
  const bar = theme.accent('█'.repeat(filled)) + theme.muted('░'.repeat(12 - filled));
  return `${bar} ${Math.round(ratio * 100)}%`;
}

export function renderStatus(options: StatusOptions): string {
  const { session, config, theme } = options;
  const git = gitSummary(options.git);
  const edits = session.edits.filter((edit) => edit.state === 'applied' && !edit.undone).length;
  const cost = session.usage.priced
    ? `est. ${formatUsd(session.usage.costUsd)}`
    : 'price unavailable';
  const label = (value: string) => theme.muted(value.padEnd(12));
  return panel(
    'Airforce Code status',
    [
      `${theme.strong(sanitize(basename(session.root) || session.root))}  ${theme.muted(sanitize(session.root))}`,
      '',
      `${label('MODEL')}${theme.accent(sanitize(config.model ?? 'No model selected'))}`,
      `${label('MODE')}${options.mode}${session.questionFirst ? ' · question-first' : ''}`,
      `${label('SESSION')}${sanitize(session.title)} · ${session.id.slice(0, 8)}`,
      '',
      `${label('CONTEXT')}${meter(options.contextTokens, config.contextTokens, theme)}`,
      `${label('')}${formatTokens(options.contextTokens)} / ${formatTokens(config.contextTokens)} tokens`,
      `${label('USAGE')}${formatTokens(session.usage.inputTokens)} input · ${formatTokens(session.usage.outputTokens)} output`,
      `${label('COST')}${cost}`,
      '',
      `${label('GIT')}${sanitize(git.branch)}`,
      `${label('CHANGES')}${git.changes}${edits ? ` · ${edits} by Airforce` : ''}`,
    ],
    theme,
  );
}
