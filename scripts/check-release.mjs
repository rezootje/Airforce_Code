import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (process.env.GITHUB_REF_NAME !== `v${pkg.version}`)
  throw new Error('Release tag must match package.json version');
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
if (!changelog.includes(`[${pkg.version}]`))
  throw new Error('Add a versioned changelog entry before release');
