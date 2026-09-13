import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve('.');
const temporary = await mkdtemp(join(tmpdir(), 'airforce-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  run(npm, ['pack', '--pack-destination', temporary]);
  const archive = (await readdir(temporary)).find((f) => f.endsWith('.tgz'));
  if (!archive) throw new Error('No package archive generated');
  run(npm, [
    'install',
    '--prefix',
    temporary,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(temporary, archive),
  ]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const binary = join(temporary, 'node_modules', manifest.name, 'dist', 'cli', 'main.js');
  const help = run(process.execPath, [binary, '--help'], temporary);
  if (!help.includes('airforce') || !help.includes('--prompt'))
    throw new Error('Installed executable help is invalid');
  const version = run(process.execPath, [binary, '--version'], temporary).trim();
  if (version !== manifest.version) throw new Error('Installed version mismatch');
  for (const name of ['airforce', 'airforce-code']) {
    const bin = join(
      temporary,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${name}.cmd` : name,
    );
    if (!run(bin, ['--version'], temporary).includes(manifest.version))
      throw new Error(`${name} NPM bin link did not launch`);
  }
  console.log(`Installed ${manifest.name}@${version} from tarball; executable and help verified.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
