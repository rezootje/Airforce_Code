import { select } from '@inquirer/prompts';
import { basename } from 'node:path';
import type { Mode } from '../agent/types.js';
import type { DirectoryConsentStore } from '../security/directory-consent.js';
import { logo, panel } from './brand.js';
import { createTheme } from './theme.js';
import { sanitize } from '../security/redact.js';

export type DirectoryDecision = 'trust' | 'once' | 'exit';

export async function requestDirectoryConsent(
  root: string,
  mode: Mode,
  store: DirectoryConsentStore,
): Promise<DirectoryDecision> {
  const theme = createTheme();
  process.stderr.write(`\n${logo(theme)}\n\n`);
  process.stderr.write(
    `${panel(
      'Directory access',
      [
        theme.strong(sanitize(basename(root) || root)),
        sanitize(root),
        '',
        '✓ Read project files and recognized instruction files',
        mode === 'ask'
          ? '△ Ask before changing project files'
          : '✓ Allow ordinary project file edits under the selected mode',
        '△ Ask before running programs, Git writes, hooks, or MCP servers',
        '× Block credential paths, symlinks, and paths outside this directory',
      ],
      theme,
    )}\n\n`,
  );
  const decision = await select<DirectoryDecision>({
    message: 'Allow Airforce Code to work in this directory?',
    choices: [
      { name: 'Trust this directory', value: 'trust', description: 'Remember this exact path.' },
      { name: 'Continue once', value: 'once', description: 'Ask again next time.' },
      { name: 'Exit', value: 'exit', description: 'Do not inspect the project.' },
    ],
  });
  if (decision === 'trust') await store.trust(root);
  return decision;
}
