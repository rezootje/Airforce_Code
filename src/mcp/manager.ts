import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { Config } from '../config/config.js';
import type { PermissionPolicy } from '../security/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { AirforceError } from '../utils/errors.js';
export class McpManager {
  private readonly clients = new Map<string, Client>();
  constructor(
    private readonly config: Config,
    private readonly policy: PermissionPolicy,
    private readonly registry: ToolRegistry,
    private readonly cwd: string,
  ) {}
  status(): { name: string; enabled: boolean; connected: boolean }[] {
    return Object.entries(this.config.mcpServers).map(([name, s]) => ({
      name,
      enabled: s.enabled,
      connected: this.clients.has(name),
    }));
  }
  async connect(name: string): Promise<void> {
    if (this.clients.has(name)) return;
    const server = this.config.mcpServers[name];
    if (!server || !server.enabled)
      throw new AirforceError('MCP server is missing or disabled', 'MCP');
    await this.policy.require({
      tool: 'mcp_connect',
      description: `Start MCP server ${name}: ${JSON.stringify([server.command, ...server.args])}. This external process has your OS privileges; Airforce cannot sandbox it.`,
      risk: 'execute',
      command: [server.command, ...server.args],
    });
    const client = new Client({ name: 'airforce', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: this.cwd,
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    // Drain untrusted diagnostics without letting them reach the terminal or block startup.
    transport.stderr?.on('data', () => {
      /* Drain untrusted diagnostics. */
    });
    try {
      await client.connect(transport, { timeout: 15000 });
      const result = await client.listTools(undefined, { timeout: 15000 });
      if (result.tools.length > 100)
        throw new AirforceError('MCP server exposes more than 100 tools', 'MCP');
      for (const [index, tool] of result.tools.entries()) {
        // Keep server-provided schema as untrusted descriptive data. Local envelope is always validated.
        this.registry.register({
          name: `mcp_${name.slice(0, 32)}_${index}`,
          description: `External MCP tool ${tool.name}. Untrusted description/schema: ${JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }).slice(0, 8000)}. Pass tool arguments in input.`,
          schema: z.object({ input: z.record(z.string(), z.unknown()) }).strict(),
          action: (i) => ({
            tool: `mcp_${name}_${index}`,
            description: `Call external MCP ${name}/${tool.name}: ${JSON.stringify(i.input).slice(0, 1000)}`,
            risk: 'execute',
          }),
          execute: async (i, c) =>
            client.callTool({ name: tool.name, arguments: i.input }, undefined, {
              signal: c.signal,
              timeout: 60000,
            }),
        });
      }
      this.clients.set(name, client);
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
