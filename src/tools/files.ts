import { constants } from 'node:fs';
import { open, rename, rm, mkdir, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { PathGuard } from '../security/paths.js';
import { Redactor } from '../security/redact.js';
import type { Session, SessionStore, EditRecord } from '../sessions/store.js';
import type { ToolRegistry } from './registry.js';
import { AirforceError, isMissing } from '../utils/errors.js';
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export class FileEditor {
  constructor(
    readonly guard: PathGuard,
    private readonly session: Session,
    private readonly store: SessionStore,
    private readonly redactor: Redactor,
  ) {}
  async read(path: string): Promise<string | null> {
    const safe = await this.guard.resolve(path);
    let handle;
    try {
      handle = await open(safe, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > 1_000_000)
        throw new AirforceError('File is non-regular, hard-linked, or larger than 1 MB', 'FILE');
      const buffer = await handle.readFile();
      if (buffer.includes(0)) throw new AirforceError('Binary files are not read as text', 'FILE');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    } finally {
      await handle?.close();
    }
  }
  async change(
    path: string,
    after: string | null,
    expectedHash: string | null,
    track = true,
  ): Promise<string> {
    const safe = await this.guard.resolve(path, { write: true });
    const before = await this.read(path);
    if ((before === null ? null : hash(before)) !== expectedHash)
      throw new AirforceError(
        'File changed since it was read. Read it again and rebase the edit.',
        'STALE_EDIT',
      );
    if ([before, after].some((x) => x !== null && this.redactor.text(x) !== x))
      throw new AirforceError(
        'Edit contains detected credentials; redact or edit this file manually.',
        'SECRET',
      );
    if (after !== null && Buffer.byteLength(after) > 1_000_000)
      throw new AirforceError('File exceeds 1 MB edit limit', 'FILE');
    if (before === after) return 'No changes';
    const record: EditRecord = {
      id: randomUUID(),
      path: relative(this.guard.root, safe),
      before,
      after,
      at: new Date().toISOString(),
      undone: false,
      state: 'pending',
    };
    if (track) {
      this.session.edits.push(record);
      this.session.redoStack = [];
      await this.store.save(this.session);
    }
    let mode = 0o644;
    try {
      mode = (await stat(safe)).mode & 0o777;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    if (after === null) {
      await this.guard.resolve(path, { write: true });
      await rm(safe);
    } else {
      await mkdir(dirname(safe), { recursive: true });
      await this.guard.resolve(path, { write: true });
      const tmp = `${safe}.airforce-${randomUUID()}.tmp`;
      try {
        const file = await open(tmp, 'wx', mode);
        try {
          await file.writeFile(after);
          await file.sync();
        } finally {
          await file.close();
        }
        const fresh = await this.read(path);
        if (fresh !== before)
          throw new AirforceError('Concurrent file modification detected', 'STALE_EDIT');
        await this.guard.resolve(path, { write: true });
        await rename(tmp, safe);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    if (track) {
      record.state = 'applied';
      await this.store.save(this.session);
    }
    return createTwoFilesPatch(path, path, before ?? '', after ?? '').slice(0, 30000);
  }
  async undo(redo = false): Promise<string> {
    const record = redo
      ? this.session.edits.find((e) => e.id === this.session.redoStack.at(-1))
      : [...this.session.edits].reverse().find((e) => !e.undone && e.state !== 'failed');
    if (!record) throw new AirforceError(redo ? 'Nothing to redo' : 'Nothing to undo', 'UNDO');
    const expected = redo ? record.before : record.after;
    const target = redo ? record.after : record.before;
    const diff = await this.change(
      record.path,
      target,
      expected === null ? null : hash(expected),
      false,
    );
    record.undone = !redo;
    if (redo) this.session.redoStack.pop();
    else this.session.redoStack.push(record.id);
    await this.store.save(this.session);
    return diff;
  }
}
export function registerFileTools(
  registry: ToolRegistry,
  editor: FileEditor,
  onRead: (path: string) => void,
): void {
  registry.register({
    name: 'read_file',
    description:
      'Read a UTF-8 repository file or line range. Returns the full-file SHA256 required for safe edits. Credential paths and binary files are blocked.',
    schema: z
      .object({
        path: z.string(),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(1).optional(),
      })
      .strict(),
    action: (i) => ({
      tool: 'read_file',
      description: `Reading ${i.path}`,
      risk: 'read',
      paths: [i.path],
    }),
    execute: async (i) => {
      const text = await editor.read(i.path);
      if (text === null) throw new AirforceError('File not found', 'FILE');
      onRead(i.path);
      const lines = text.split('\n');
      return {
        path: i.path,
        sha256: hash(text),
        totalLines: lines.length,
        startLine: i.startLine,
        content: lines.slice(i.startLine - 1, i.endLine ?? i.startLine + 399).join('\n'),
      };
    },
  });
  registry.register({
    name: 'write_file',
    description:
      'Create or replace a text file. expectedHash must match the most recent read; use null only to create a new file. Prefer patch_file for edits.',
    schema: z
      .object({
        path: z.string(),
        content: z.string().max(1_000_000),
        expectedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict(),
    action: (i) => ({
      tool: 'write_file',
      description: `Writing ${i.path}`,
      risk: 'write',
      paths: [i.path],
    }),
    execute: async (i, c) => {
      const diff = await editor.change(i.path, i.content, i.expectedHash);
      c.emit({ type: 'file.changed', path: i.path });
      return { diff };
    },
  });
  registry.register({
    name: 'patch_file',
    description:
      'Replace one exact, unique text span in a repository file. Supply its last-read SHA256. Fails on stale content or ambiguous matches.',
    schema: z
      .object({
        path: z.string(),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        oldText: z.string().min(1),
        newText: z.string(),
      })
      .strict(),
    action: (i) => ({
      tool: 'patch_file',
      description: `Patching ${i.path}`,
      risk: 'write',
      paths: [i.path],
    }),
    execute: async (i, c) => {
      const before = await editor.read(i.path);
      if (before === null || before.split(i.oldText).length !== 2)
        throw new AirforceError('Patch text must occur exactly once', 'PATCH');
      const diff = await editor.change(
        i.path,
        before.replace(i.oldText, () => i.newText),
        i.expectedHash,
      );
      c.emit({ type: 'file.changed', path: i.path });
      return { diff };
    },
  });
  registry.register({
    name: 'delete_file',
    description:
      'Delete one regular file after explicit approval and a matching SHA256. No recursive deletion.',
    schema: z.object({ path: z.string(), expectedHash: z.string() }).strict(),
    action: (i) => ({
      tool: 'delete_file',
      description: `Deleting ${i.path}`,
      risk: 'destructive',
      paths: [i.path],
    }),
    execute: async (i, c) => {
      const diff = await editor.change(i.path, null, i.expectedHash);
      c.emit({ type: 'file.changed', path: i.path });
      return { diff };
    },
  });
  registry.register({
    name: 'copy_file',
    description:
      'Copy a regular text file into a new path. Existing destinations are never overwritten.',
    schema: z.object({ source: z.string(), destination: z.string() }).strict(),
    action: (i) => ({
      tool: 'copy_file',
      description: `Copying ${i.source} to ${i.destination}`,
      risk: 'write',
      paths: [i.source, i.destination],
    }),
    execute: async (i) => {
      const text = await editor.read(i.source);
      if (text === null) throw new AirforceError('Source not found', 'FILE');
      return { diff: await editor.change(i.destination, text, null) };
    },
  });
  registry.register({
    name: 'move_file',
    description:
      'Move one regular text file to a new path after approval. Copy and deletion are separate tracked edits; if interrupted inspect both paths. Never overwrites the destination.',
    schema: z
      .object({
        source: z.string(),
        destination: z.string(),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    action: (i) => ({
      tool: 'move_file',
      description: `Move ${i.source} to ${i.destination}`,
      risk: 'destructive',
      paths: [i.source, i.destination],
    }),
    execute: async (i, c) => {
      const text = await editor.read(i.source);
      if (text === null || hash(text) !== i.expectedHash)
        throw new AirforceError('Source changed since read', 'STALE_EDIT');
      await editor.guard.resolve(i.destination, { write: true });
      const created = await editor.change(i.destination, text, null);
      c.emit({ type: 'file.changed', path: i.destination });
      const removed = await editor.change(i.source, null, i.expectedHash);
      c.emit({ type: 'file.changed', path: i.source });
      return { created, removed };
    },
  });
}
