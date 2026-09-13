import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMissing } from './errors.js';
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Unsafe storage directory: ${path}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new Error(`Storage directory must be owner-only (chmod 700): ${path}`);
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function safeStorageFile(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Unsafe storage file: ${path}`);
    if (process.platform !== 'win32' && st.mode & 0o077)
      throw new Error(`Storage file must be owner-only (chmod 600): ${path}`);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}
