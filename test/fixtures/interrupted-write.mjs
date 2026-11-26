import { appendFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'ledger', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'append_record',
  inputSchema: { type: 'object', properties: { drop: { type: 'boolean' } }, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  await appendFile(process.argv[2], 'committed\n', { flush: true });
  if (params.arguments.drop) process.exit(0); // no tool response reaches the gateway
  return { content: [{ type: 'text', text: 'private fixture result' }] };
});
await server.connect(new StdioServerTransport());
