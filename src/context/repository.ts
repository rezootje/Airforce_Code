import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';
import ignore from 'ignore';
import { PathGuard } from '../security/paths.js';
import { isMissing } from '../utils/errors.js';
const excluded = new Set([
  '.git',
  '.airforce',
  '.codex',
  '.agents',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'coverage',
  '.cache',
  'vendor',
]);
export async function projectRoot(cwd: string): Promise<string> {
  const start = await realpath(cwd);
  let current = start;
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
export interface RepositoryMap {
  root: string;
  manifests: string[];
  languages: string[];
  commands: Record<string, string[]>;
  files: string[];
}
export class RepositoryIndex {
  readonly accessed = new Set<string>();
  constructor(readonly guard: PathGuard) {}
  async files(signal?: AbortSignal, limit = 5000): Promise<string[]> {
    const result: string[] = [];
    let visited = 0;
    const walk = async (dir: string, rules: ReturnType<typeof ignore>): Promise<void> => {
      signal?.throwIfAborted();
      if (result.length >= limit || visited++ > 10000) return;
      const local = relative(this.guard.root, dir).replaceAll('\\', '/');
      const childRules = ignore().add(rules);
      try {
        const path = await this.guard.resolve(join(local, '.gitignore'));
        const st = await lstat(path);
        if (st.size < 100000) {
          const text = await readFile(path, 'utf8');
          childRules.add(
            text
              .split(/\r?\n/)
              .filter((line) => line && !line.startsWith('#'))
              .map((line) => {
                const negate = line.startsWith('!');
                const pattern = negate ? line.slice(1) : line;
                return `${negate ? '!' : ''}${local ? local + '/' : ''}${pattern.startsWith('/') ? pattern.slice(1) : pattern.includes('/') ? pattern : '**/' + pattern}`;
              }),
          );
        }
      } catch (e) {
        if (!isMissing(e) && !(e instanceof Error && e.message.includes('policy'))) throw e;
      }
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (result.length >= limit) return;
        if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        const name = relative(this.guard.root, path).replaceAll('\\', '/');
        if (childRules.ignores(name + (entry.isDirectory() ? '/' : ''))) continue;
        try {
          await this.guard.resolve(path, { allowDirectory: true });
        } catch {
          continue;
        }
        if (entry.isDirectory()) await walk(path, childRules);
        else if (entry.isFile()) result.push(name);
      }
    };
    await walk(this.guard.root, ignore());
    return result;
  }
  async map(): Promise<RepositoryMap> {
    const entries = await readdir(this.guard.root, { withFileTypes: true });
    const names = entries.map((e) => e.name);
    const manifests = names.filter((n) =>
      /^(package\.json|pnpm-workspace\.yaml|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Dockerfile|Makefile|.*\.sln|tsconfig.*\.json)$/.test(
        n,
      ),
    );
    const languages = new Set<string>();
    const commands: Record<string, string[]> = {};
    if (names.includes('package.json')) {
      languages.add('JavaScript/TypeScript');
      try {
        const path = await this.guard.resolve('package.json');
        const st = await lstat(path);
        if (st.size < 100000) {
          const pkg = JSON.parse(await readFile(path, 'utf8')) as {
            scripts?: Record<string, string>;
          };
          const pm = names.includes('pnpm-lock.yaml')
            ? 'pnpm'
            : names.includes('yarn.lock')
              ? 'yarn'
              : names.includes('bun.lock')
                ? 'bun'
                : 'npm';
          for (const name of Object.keys(pkg.scripts ?? {}))
            if (['test', 'build', 'lint', 'typecheck', 'format'].includes(name))
              commands[name] = [pm, 'run', name];
        }
      } catch {
        /* The file remains available for explicit inspection. */
      }
    }
    for (const [manifest, language, command] of [
      ['pyproject.toml', 'Python', ['pytest']],
      ['Cargo.toml', 'Rust', ['cargo', 'test']],
      ['go.mod', 'Go', ['go', 'test', './...']],
      ['pom.xml', 'Java', ['mvn', 'test']],
      ['build.gradle', 'JVM', ['gradle', 'test']],
    ] as const)
      if (names.includes(manifest)) {
        languages.add(language);
        commands[`${language} tests`] = [...command];
      }
    if (names.some((n) => n.endsWith('.sln'))) {
      languages.add('C#');
      commands.test = ['dotnet', 'test'];
    }
    return {
      root: this.guard.root,
      manifests,
      languages: [...languages],
      commands,
      files: names.filter((n) => !excluded.has(n)).slice(0, 100),
    };
  }
}
export const textExtension = (path: string): boolean =>
  ![
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.zip',
    '.gz',
    '.pdf',
    '.woff',
    '.ico',
    '.mp4',
    '.exe',
    '.dll',
  ].includes(extname(path).toLowerCase());
