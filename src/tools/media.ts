import { z } from 'zod';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolRegistry } from './registry.js';
import type { MediaProvider } from '../extensions/interfaces.js';
import type { PathGuard } from '../security/paths.js';
import type { PermissionPolicy } from '../security/permissions.js';
export function registerMediaTool(
  registry: ToolRegistry,
  provider: MediaProvider,
  guard: PathGuard,
  policy: PermissionPolicy,
): void {
  registry.register({
    name: 'generate_image',
    description:
      'Generate one PNG project asset via the configured API. Requires optional network access and file-write permission. Use a discovered image-capable model ID. Only new .png files; generated binary assets are not covered by text undo.',
    schema: z
      .object({
        model: z.string().min(1),
        prompt: z.string().min(1).max(10000),
        path: z.string().regex(/\.png$/i),
      })
      .strict(),
    action: (i) => ({
      tool: 'generate_image',
      description: `Generate image ${i.path} with ${i.model}`,
      risk: 'network',
      paths: [i.path],
    }),
    execute: async (i, c) => {
      const path = await guard.resolve(i.path, { write: true });
      await policy.require({
        tool: 'generate_image_write',
        description: `Create PNG asset ${i.path} (not covered by text undo)`,
        risk: 'write',
        paths: [i.path],
      });
      const result = await provider.generateImage(i, c.signal);
      c.signal.throwIfAborted();
      await mkdir(dirname(path), { recursive: true });
      await guard.resolve(i.path, { write: true });
      const file = await open(path, 'wx', 0o644);
      try {
        await file.writeFile(result.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      c.emit({ type: 'file.changed', path: i.path });
      return { path: i.path, bytes: result.bytes.length, mimeType: result.mimeType };
    },
  });
}
