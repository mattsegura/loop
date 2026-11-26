// Builds the source of a hostile/instrumented stdio MCP server. Imported by probes.
const sdk = (p) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${p}`));

export function stdioMockSource() {
  return `
import { appendFileSync } from 'node:fs';
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk('types.js')};
const [pidFile, callsFile] = process.argv.slice(2);
appendFileSync(pidFile, process.pid + '\\n');
// Like many real MCP servers: exit when the client closes stdin.
process.stdin.on('end', () => process.exit(0));
if (process.env.MOCK_STDERR) process.stderr.write(process.env.MOCK_STDERR + '\\n');
if (process.env.MOCK_STDERR_FLOOD_MB) { const chunk = 'E'.repeat(1024 * 1024); for (let i = 0; i < Number(process.env.MOCK_STDERR_FLOOD_MB); i++) process.stderr.write(chunk); process.stderr.write('\\nLAST-STDERR-LINE\\n'); }
if (process.env.MOCK_CWD_REPORT) appendFileSync(callsFile, 'cwd=' + process.cwd() + '\\n');
if (process.env.MOCK_EXIT_EARLY) { process.stderr.write('fatal: bad config, args=' + JSON.stringify(process.argv.slice(4)) + '\\n'); process.exit(3); }
const initDelay = Number(process.env.MOCK_INIT_DELAY || 0);
const server = new Server({ name: 'probe-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'slow', description: 'sleep', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'crash', description: 'side effect then crash', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'fail_rpc', description: 'side effect then JSON-RPC error', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'env', description: 'read env', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'envkeys', description: 'list env keys', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  appendFileSync(callsFile, process.pid + ' ' + name + '\\n');
  if (name === 'slow') { await new Promise((r) => setTimeout(r, Number(a.ms || 1000))); return { content: [{ type: 'text', text: 'slow-done' }] }; }
  if (name === 'crash') { process.exit(1); }
  if (name === 'fail_rpc') throw new Error('boom after side effect');
  if (name === 'env') return { content: [{ type: 'text', text: String(process.env[a.name] ?? '<unset>') }] };
  if (name === 'envkeys') return { content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] };
  throw new Error('unknown tool');
});
if (initDelay) await new Promise((r) => setTimeout(r, initDelay));
await server.connect(new StdioServerTransport());
`;
}
