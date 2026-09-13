import type { ToolContext, Action } from '../agent/types.js';
import type { Executor } from '../tools/process.js';
// Optional integrations are capabilities, never implicit privileges.
export interface WebSearch {
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ title: string; url: string; excerpt: string }[]>;
}
export interface GitHubClient {
  request(
    operation: 'repository' | 'issues' | 'pulls' | 'ci' | 'comment' | 'createPull',
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<unknown>;
}
export interface SandboxBackend extends Executor {
  readonly isolation: 'none' | 'container' | 'os' | 'remote';
  describe(): string;
}
export interface Extension {
  id: string;
  capabilities: Action['risk'][];
  close(): Promise<void>;
}
export interface MediaProvider {
  generateImage(
    input: { model: string; prompt: string },
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: 'image/png' }>;
}
