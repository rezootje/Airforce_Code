import type { z } from 'zod';
export type Mode = 'ask' | 'edit' | 'auto';
export type Risk = 'read' | 'write' | 'execute' | 'network' | 'destructive' | 'privileged';
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface Model {
  id: string;
  name?: string;
  contextWindow?: number;
  capabilities: { tools?: boolean; streaming?: boolean; vision?: boolean };
  pricing?: {
    inputPerMillionUsd?: number;
    outputPerMillionUsd?: number;
    cacheReadPerMillionUsd?: number;
    cacheWrite5mPerMillionUsd?: number;
    cacheWrite1hPerMillionUsd?: number;
  };
  metadata?: Record<string, unknown>;
}
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'usage'; input: number; output: number; costUsd?: number };
export interface Provider {
  models(signal?: AbortSignal): Promise<Model[]>;
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Action {
  tool: string;
  description: string;
  risk: Risk;
  paths?: string[];
  command?: string[];
}
export type Approval = (action: Action) => Promise<boolean>;
export type AgentEvent =
  | { type: 'agent.started'; sessionId: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; text: string }
  | { type: 'tool.started'; id: string; name: string; description: string }
  | {
      type: 'tool.completed';
      id: string;
      name: string;
      result: string;
      ok: boolean;
      errorCode?: string;
    }
  | { type: 'tool.output'; text: string; stream: 'stdout' | 'stderr' }
  | { type: 'permission.requested'; action: Action }
  | { type: 'permission.resolved'; action: Action; allowed: boolean }
  | { type: 'file.changed'; path: string }
  | { type: 'context.compacted'; before: number; after: number }
  | {
      type: 'usage';
      input: number;
      output: number;
      costUsd?: number;
      sessionInput: number;
      sessionOutput: number;
      sessionCostUsd: number;
      sessionPriced: boolean;
    }
  | { type: 'session.saved'; sessionId: string }
  | { type: 'warning'; message: string }
  | { type: 'agent.completed'; status: 'completed' | 'cancelled' | 'limited'; text: string };
export type Emit = (event: AgentEvent) => void;
export interface ToolContext {
  signal: AbortSignal;
  emit: Emit;
}
export interface Tool<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  action(input: T): Action;
  execute(input: T, context: ToolContext): Promise<unknown>;
}
