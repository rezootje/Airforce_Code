import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, safeStorageFile } from '../utils/storage.js';
import { isMissing } from '../utils/errors.js';

const consentSchema = z
  .object({
    version: z.literal(1),
    directories: z.array(
      z
        .object({
          root: z.string().min(1),
          trustedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

type DirectoryConsents = z.infer<typeof consentSchema>;

export class DirectoryConsentStore {
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, 'trusted-directories.json');
  }

  private async load(): Promise<DirectoryConsents> {
    try {
      await safeStorageFile(this.path);
      return consentSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return { version: 1, directories: [] };
      throw error;
    }
  }

  async list(): Promise<DirectoryConsents['directories']> {
    return (await this.load()).directories;
  }

  async isTrusted(root: string): Promise<boolean> {
    const canonical = await realpath(root);
    return (await this.load()).directories.some((entry) => entry.root === canonical);
  }

  async trust(root: string): Promise<void> {
    const canonical = await realpath(root);
    const state = await this.load();
    state.directories = state.directories.filter((entry) => entry.root !== canonical);
    state.directories.push({ root: canonical, trustedAt: new Date().toISOString() });
    await atomicJson(this.path, consentSchema.parse(state));
  }

  async revoke(root: string): Promise<boolean> {
    const canonical = await realpath(root);
    const state = await this.load();
    const before = state.directories.length;
    state.directories = state.directories.filter((entry) => entry.root !== canonical);
    if (state.directories.length === before) return false;
    await atomicJson(this.path, consentSchema.parse(state));
    return true;
  }
}
