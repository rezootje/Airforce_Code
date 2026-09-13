import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, parse } from 'node:path';
import { AirforceError, isMissing } from '../utils/errors.js';
import { sensitivePath } from './redact.js';
export class PathGuard {
  private constructor(
    readonly root: string,
    private readonly denied: string[],
  ) {}
  static async create(root: string, denied: string[] = []): Promise<PathGuard> {
    return new PathGuard(await realpath(root), denied);
  }
  async resolve(
    input: string,
    options: { write?: boolean; allowDirectory?: boolean } = {},
  ): Promise<string> {
    if (input.includes('\0')) throw new AirforceError('NUL in path', 'PATH');
    const path = resolve(this.root, input);
    const local = relative(this.root, path);
    const policyPath = process.platform === 'win32' ? local.toLowerCase() : local;
    if (
      process.platform === 'win32' &&
      local.split(sep).some((part) => part.includes(':') || /[. ]$/.test(part))
    )
      throw new AirforceError(
        'Windows device streams and ambiguous path suffixes are forbidden',
        'PATH',
      );
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new AirforceError('Path is outside the project root', 'PATH');
    if (
      sensitivePath(local) ||
      local
        .split(sep)
        .some((s) => ['.git', '.airforce', '.codex', '.agents'].includes(s.toLowerCase())) ||
      this.denied.some((p) => {
        const normalized = p.replaceAll('/', sep);
        const deny = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        return policyPath === deny || policyPath.startsWith(deny + sep);
      })
    )
      throw new AirforceError('Path is protected by policy', 'PATH');
    if (options.write && !local) throw new AirforceError('Cannot modify the project root', 'PATH');
    let current = parse(path).root;
    for (const component of path.slice(current.length).split(sep)) {
      current = resolve(current, component);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new AirforceError('Symbolic links are not followed', 'PATH');
        if (current === path && !stat.isFile() && !(options.allowDirectory && stat.isDirectory()))
          throw new AirforceError('Only regular files are allowed', 'PATH');
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    return path;
  }
}
