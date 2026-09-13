import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, privateDirectory, safeStorageFile } from '../utils/storage.js';
import { AirforceError, isMissing } from '../utils/errors.js';
import type { Message } from '../agent/types.js';
import { Redactor } from '../security/redact.js';
const callSchema = z.object({ id: z.string(), name: z.string(), arguments: z.string() });
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(callSchema).optional(),
  toolCallId: z.string().optional(),
});
export const editSchema = z.object({
  id: z.string(),
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  at: z.string(),
  undone: z.boolean().default(false),
  state: z.enum(['pending', 'applied', 'failed']).default('applied'),
});
export type EditRecord = z.infer<typeof editSchema>;
const sessionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).default(0),
  id: z.string().uuid(),
  title: z.string(),
  root: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
  edits: z.array(editSchema),
  questionFirst: z.boolean().default(false),
  summary: z.string().default(''),
  requirements: z.array(z.string()).default([]),
  compactedUntil: z.number().int().min(0).default(0),
  redoStack: z.array(z.string()).default([]),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      priced: z.boolean().default(false),
      unpricedTokens: z.number().int().nonnegative().default(0),
    })
    .default({ inputTokens: 0, outputTokens: 0, costUsd: 0, priced: false, unpricedTokens: 0 }),
});
export type Session = z.infer<typeof sessionSchema>;
export function newSession(root: string): Session {
  const now = new Date().toISOString();
  return {
    version: 1,
    revision: 0,
    id: randomUUID(),
    title: 'New session',
    root,
    createdAt: now,
    updatedAt: now,
    messages: [],
    edits: [],
    questionFirst: false,
    summary: '',
    requirements: [],
    compactedUntil: 0,
    redoStack: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      priced: false,
      unpricedTokens: 0,
    },
  };
}
export class SessionStore {
  readonly directory: string;
  constructor(
    home: string,
    private readonly redactor = new Redactor(),
  ) {
    this.directory = join(home, 'sessions');
  }
  private path(id: string): string {
    if (!z.string().uuid().safeParse(id).success)
      throw new AirforceError('Session ID must be a UUID', 'SESSION', 2);
    return join(this.directory, `${id}.json`);
  }
  async save(session: Session): Promise<void> {
    const release = await this.lock(session.id, '.write-lock');
    try {
      const path = this.path(session.id);
      let existing: Session | undefined;
      try {
        await stat(path);
        existing = await this.load(session.id);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      if ((existing?.revision ?? 0) !== session.revision || (!existing && session.revision !== 0))
        throw new AirforceError(
          'Session changed in another process. Resume it again before saving.',
          'SESSION_STALE',
        );
      const next = {
        ...session,
        revision: session.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (Buffer.byteLength(JSON.stringify(next)) > 64_000_000)
        throw new AirforceError(
          'Session exceeds 64 MB. Export and start a new session.',
          'SESSION_LIMIT',
        );
      await atomicJson(path, this.redactor.value(sessionSchema.parse(next)));
      session.revision = next.revision;
      session.updatedAt = next.updatedAt;
    } finally {
      await release();
    }
  }

  async load(id: string): Promise<Session> {
    const path = this.path(id);
    await safeStorageFile(path);
    try {
      if ((await stat(path)).size > 64_000_000)
        throw new AirforceError('Session exceeds 64 MB', 'SESSION_LIMIT');
      const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return sessionSchema.parse(data);
    } catch (e) {
      throw new AirforceError(
        `Cannot read session ${id}: ${e instanceof Error ? e.message : String(e)}. Restore a backup or start a new session.`,
        'SESSION',
      );
    }
  }
  async list(): Promise<Session[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
    const sessions: Session[] = [];
    for (const file of files.filter((f) => /^[\da-f-]{36}\.json$/.test(f)))
      sessions.push(await this.load(file.slice(0, -5)));
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(id: string): Promise<void> {
    const release = await this.lock(id);
    try {
      await rm(this.path(id));
    } finally {
      await release();
    }
  }
  async fork(id: string): Promise<Session> {
    const old = await this.load(id);
    const result = {
      ...old,
      id: randomUUID(),
      revision: 0,
      title: `${old.title} (fork)`,
      edits: [],
      redoStack: [],
    };
    await this.save(result);
    return result;
  }
  async lock(id: string, suffix = '.lock'): Promise<() => Promise<void>> {
    await privateDirectory(this.directory);
    const path = this.path(id) + suffix;
    let file;
    try {
      file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
    } catch {
      throw new AirforceError(
        `Session is locked. If no Airforce process is using it, remove ${path}.`,
        'SESSION_LOCK',
      );
    }
    return async () => {
      await file.close();
      await rm(path, { force: true });
    };
  }
}
export function repairInterruptedTools(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m?.toolCalls) continue;
    const results = new Set<string>();
    let end = i + 1;
    while (messages[end]?.role === 'tool') {
      results.add(messages[end]!.toolCallId!);
      end++;
    }
    const missing = m.toolCalls
      .filter((t) => !results.has(t.id))
      .map((t) => ({
        role: 'tool' as const,
        toolCallId: t.id,
        content:
          'Interrupted before a result was saved. Inspect current state before retrying any mutation.',
      }));
    messages.splice(end, 0, ...missing);
    i = end + missing.length - 1;
  }
}
