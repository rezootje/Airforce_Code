import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { RepositoryIndex } from '../context/repository.js';
import type { FileEditor } from './files.js';
import { textExtension } from '../context/repository.js';
import { AirforceError } from '../utils/errors.js';
const workerSource = `const {parentPort,workerData}=require('node:worker_threads');try{const re=new RegExp(workerData.pattern,workerData.caseSensitive?'':'i');const matches=[];outer:for(const file of workerData.files){const lines=file.content.split('\\n');for(let i=0;i<lines.length;i++){if(re.test(lines[i]))matches.push({path:file.path,line:i+1,text:lines[i].slice(0,500)});if(matches.length>=workerData.limit)break outer;}}parentPort.postMessage({matches,limited:matches.length>=workerData.limit});}catch(e){parentPort.postMessage({error:e.message});}`;
export async function regexSearch(
  input: {
    pattern: string;
    caseSensitive: boolean;
    limit: number;
    files: { path: string; content: string }[];
  },
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    let settled = false;
    const done = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => done(signal.reason);
    const timer = setTimeout(
      () =>
        done(
          new AirforceError(
            'Regex search exceeded 500 ms worker budget. Simplify the pattern.',
            'REGEX',
          ),
        ),
      500,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (result: { error?: string }) =>
      result.error ? done(new AirforceError(result.error, 'REGEX')) : done(undefined, result),
    );
    worker.once('error', (error) => done(error));
    worker.once('exit', (code) => {
      if (!settled) done(new AirforceError(`Regex worker exited (${code})`, 'REGEX'));
    });
  });
}
export function registerRegexTool(
  registry: ToolRegistry,
  index: RepositoryIndex,
  editor: FileEditor,
): void {
  registry.register({
    name: 'search_regex',
    description:
      'Search repository text with a JavaScript regular expression. Runs in a disposable worker with a hard timeout to contain expensive expressions. At most 100 files / 2 MB per query; narrow with pathContains.',
    schema: z
      .object({
        pattern: z.string().min(1).max(500),
        caseSensitive: z.boolean().default(false),
        pathContains: z.string().default(''),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .strict(),
    action: (i) => ({
      tool: 'search_regex',
      description: `Searching regex ${i.pattern}`,
      risk: 'read',
    }),
    execute: async (i, c) => {
      const files: { path: string; content: string }[] = [];
      let bytes = 0;
      for (const path of (await index.files(c.signal)).filter(
        (p) => p.includes(i.pathContains) && textExtension(p),
      )) {
        c.signal.throwIfAborted();
        if (files.length >= 100 || bytes >= 2_000_000) break;
        try {
          const content = await editor.read(path);
          if (content !== null) {
            bytes += Buffer.byteLength(content);
            if (bytes <= 2_000_000) files.push({ path, content });
          }
        } catch {
          /* unreadable or protected file */
        }
      }
      return {
        result: await regexSearch({ ...i, files }, c.signal),
        filesScanned: files.length,
        scanLimited: files.length >= 100 || bytes >= 2_000_000,
      };
    },
  });
}
