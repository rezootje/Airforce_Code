import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'airforce-test-fixture', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Synthetic echo tool', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
);
await server.connect(new StdioServerTransport());
