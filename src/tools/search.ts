import { z } from 'zod';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryIndex, textExtension } from '../context/repository.js';
import { FileEditor } from './files.js';
import type { ToolRegistry } from './registry.js';
export function registerSearchTools(
  registry: ToolRegistry,
  index: RepositoryIndex,
  editor: FileEditor,
): void {
  registry.register({
    name: 'list_directory',
    description: 'List one directory or a bounded, gitignore-aware recursive project file map.',
    schema: z
      .object({ path: z.string().default('.'), recursive: z.boolean().default(false) })
      .strict(),
    action: (i) => ({ tool: 'list_directory', description: `Inspecting ${i.path}`, risk: 'read' }),
    execute: async (i, c) => {
      const path = await index.guard.resolve(i.path, { allowDirectory: true });
      if (i.recursive) {
        const files = await index.files(c.signal);
        return {
          files: files.filter(
            (f) => i.path === '.' || f.startsWith(i.path.replace(/\/$/, '') + '/'),
          ),
          limited: files.length >= 5000,
        };
      }
      const entries = await readdir(path, { withFileTypes: true });
      const result = [];
      for (const e of entries.slice(0, 1000)) {
        try {
          await index.guard.resolve(join(path, e.name), { allowDirectory: true });
          result.push({
            name: e.name,
            type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
          });
        } catch {
          /* protected entry */
        }
      }
      return result;
    },
  });
  registry.register({
    name: 'file_metadata',
    description: 'Inspect regular file metadata.',
    schema: z.object({ path: z.string() }).strict(),
    action: (i) => ({
      tool: 'file_metadata',
      description: `Inspecting metadata for ${i.path}`,
      risk: 'read',
    }),
    execute: async (i) => {
      const st = await lstat(await index.guard.resolve(i.path, { allowDirectory: true }));
      return { bytes: st.size, modified: st.mtime.toISOString(), directory: st.isDirectory() };
    },
  });
  registry.register({
    name: 'search_files',
    description:
      'Find repository paths using a case-insensitive substring or simple * / ** / ? glob. Respects .gitignore and protected paths.',
    schema: z
      .object({ query: z.string().max(500), limit: z.number().int().min(1).max(200).default(100) })
      .strict(),
    action: (i) => ({
      tool: 'search_files',
      description: `Finding files: ${i.query}`,
      risk: 'read',
    }),
    execute: async (i, c) => {
      const files = await index.files(c.signal);
      let matcher: (p: string) => boolean;
      if (/[?*]/.test(i.query)) {
        const escaped = i.query
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\u0001')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/\u0001/g, '.*');
        const regex = new RegExp(`^${escaped}$`, 'i');
        matcher = (p) => regex.test(p);
      } else matcher = (p) => p.toLowerCase().includes(i.query.toLowerCase());
      return { files: files.filter(matcher).slice(0, i.limit), indexLimited: files.length >= 5000 };
    },
  });
  registry.register({
    name: 'search_text',
    description:
      'Search literal text in repository files. Bounded, gitignore-aware and case configurable. Use declarations such as function/class/interface for lightweight symbol search.',
    schema: z
      .object({
        query: z.string().min(1).max(500),
        caseSensitive: z.boolean().default(false),
        pathContains: z.string().default(''),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .strict(),
    action: (i) => ({
      tool: 'search_text',
      description: `Searching repository for ${i.query}`,
      risk: 'read',
    }),
    execute: async (i, c) => {
      const matches: { path: string; line: number; text: string }[] = [];
      const files = await index.files(c.signal);
      const query = i.caseSensitive ? i.query : i.query.toLowerCase();
      let scanned = 0;
      for (const path of files.filter((p) => p.includes(i.pathContains) && textExtension(p))) {
        c.signal.throwIfAborted();
        if (scanned++ >= 1000) break;
        let text: string | null;
        try {
          text = await editor.read(path);
        } catch {
          continue;
        }
        if (text === null) continue;
        for (const [line, value] of text.split('\n').entries()) {
          if ((i.caseSensitive ? value : value.toLowerCase()).includes(query))
            matches.push({ path, line: line + 1, text: value.slice(0, 500) });
          if (matches.length >= i.limit) return { matches, limited: true };
        }
      }
      return { matches, limited: scanned >= 1000 || files.length >= 5000 };
    },
  });
}
