// P1: secret masking across output shapes, encodings and error paths (root workspace, agent without canManage).
import { startLegacy, startMockUpstream, writeMockStdio, sandboxDir, result } from '../../harness.mjs';
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));
process.on('uncaughtException', (e) => result('UNCAUGHT', String(e?.stack || e)));

const S = {
  PEM_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAbCdEfGh12345678zz\n-----END PRIVATE KEY-----',
  QUOTE_PW: 'pa"ss\\word-9911-quoted',
  UNI_PW: 'pässwörd-ünïcode-7788',
  SLASH_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY+abc=',
  SHORT: '7Q2',
  PIN: '2024',
  KEYED: 'sk-live-keyed-secret-123456',
  CONN_KEY: 'conn-header-secret-ABCDEF123',
  STDIO_KEY: 'stdio-env-secret-QWERTY9876',
};
const pyDumps = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const tools = ['echo', 'keyed', 'split', 'py_json', 'php_json', 'url_echo', 'json_report'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
const up = await startMockUpstream({
  tools,
  callTool: async (name, args) => {
    const v = String(args.v ?? '');
    switch (name) {
      case 'echo': return { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] };
      case 'keyed': return { content: [{ type: 'text', text: 'see structured' }], structuredContent: { [v]: { valid: true } } };
      case 'split': return { content: [{ type: 'text', text: v.slice(0, 9) }, { type: 'text', text: v.slice(9) }] };
      case 'py_json': return { content: [{ type: 'text', text: pyDumps(args) }] };
      case 'php_json': return { content: [{ type: 'text', text: JSON.stringify(args).replace(/\//g, '\\/') }] };
      case 'url_echo': return { content: [{ type: 'text', text: `GET https://api.example.test/v1/thing?key=${encodeURIComponent(v)}` }] };
      case 'json_report': return { content: [{ type: 'text', text: JSON.stringify({ year: 2024, created: '2024-05-01', items: [1, 2] }) }] };
      default: return { content: [{ type: 'text', text: 'unknown' }] };
    }
  },
  handler: async (body, req, res) => {
    if (body?.method === 'resources/read' || body?.method === 'prompts/get') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `upstream rejected key ${req.headers['x-api-key']}` } }));
      return true;
    }
    return false;
  },
});
// Upstream that rejects the configured key and echoes it in the 403 body (very common API behaviour).
const bad = await startMockUpstream({
  handler: async (body, req, res) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end(`Forbidden: API key ${req.headers['x-api-key']} is not valid`); return true; },
});
const L = await startLegacy();
try {
  const argSecrets = new Set(['PEM_KEY', 'QUOTE_PW', 'UNI_PW', 'SLASH_KEY', 'SHORT', 'PIN', 'KEYED']);
  for (const [key, value] of Object.entries(S)) {
    const body = argSecrets.has(key) ? { key, value, allowedSinks: [up.url] } : { key, value };
    const r = await L.api('/api/vault', { method: 'POST', body });
    if (r.status !== 201) result(`vault set ${key}`, r.status);
  }
  const add = await L.api('/api/mcps', { method: 'POST', body: { name: 'Up', transport: 'http', url: up.url, headers: { 'X-Api-Key': '{{vault:CONN_KEY}}' } } });
  result('add up', { status: add.status, id: add.json?.mcp?.id, tools: add.json?.mcp?.tools?.length });
  const addBad = await L.api('/api/mcps', { method: 'POST', body: { name: 'Bad', transport: 'http', url: bad.url, headers: { 'X-Api-Key': '{{vault:CONN_KEY}}' } } });
  result('add bad', { status: addBad.status, id: addBad.json?.mcp?.id, lastError: addBad.json?.mcp?.lastError });
  const stdioSrc = `process.stderr.write('FATAL: invalid API key ' + process.env.API_KEY + '\\n'); process.exit(1);`;
  const st = writeMockStdio(sandboxDir('stdio'), { source: stdioSrc });
  const addSt = await L.api('/api/mcps', { method: 'POST', body: { name: 'Crashy', transport: 'stdio', command: st.command, args: st.args, env: { API_KEY: '{{vault:STDIO_KEY}}' } } });
  result('add crashy', { status: addSt.status, id: addSt.json?.mcp?.id, lastError: addSt.json?.mcp?.lastError });

  const shared = ['PEM_KEY', 'QUOTE_PW', 'UNI_PW', 'SLASH_KEY', 'SHORT', 'PIN', 'KEYED'];
  const ag = await L.createAgent({ name: 'Masker', canManage: false, secrets: shared });
  const run = async (tool, args) => {
    const r = await L.callTool('loop__run', { tool, arguments: args }, { token: ag.token });
    return r.result || r.error || r.json;
  };
  const leaks = (obj, secret) => {
    const s = JSON.stringify(obj);
    const decodedOnce = s; // what the agent's MCP client sees after JSON decode is the inner string; check raw + escaped
    return {
      raw: JSON.stringify(obj) .includes(JSON.stringify(secret).slice(1, -1)) || (typeof obj === 'object' && JSON.stringify(obj).includes(secret)),
    };
  };
  // Helper: decoded text the agent sees
  const textOf = (resu) => (resu?.content || []).map((c) => c.text).join('|');
  const hasRaw = (resu, secret) => JSON.stringify(resu).includes(JSON.stringify(secret).slice(1, -1)) ;

  // 1. JSON-escaped copies in a text block (echo)
  for (const k of ['PEM_KEY', 'QUOTE_PW', 'UNI_PW', 'SLASH_KEY', 'KEYED']) {
    try {
      const resu = await run('up__echo', { v: `{{vault:${k}}}` });
      const t = textOf(resu);
      // What an agent can recover: JSON.parse of the text after 'echo:'
      let recovered = null; try { recovered = JSON.parse(t.replace(/^echo:/, '')).v; } catch {}
      result(`echo ${k}`, { text: t.slice(0, 140), recoveredEqualsSecret: recovered === S[k] });
    } catch (e) { result(`echo ${k} ERR`, String(e)); }
  }
  // 2. Python ensure_ascii and PHP-style escaping
  for (const [tool, k] of [['py_json', 'UNI_PW'], ['php_json', 'SLASH_KEY']]) {
    const resu = await run(`up__${tool}`, { v: `{{vault:${k}}}` });
    const t = textOf(resu);
    let recovered = null; try { recovered = JSON.parse(t).v; } catch {}
    result(`${tool} ${k}`, { text: t.slice(0, 120), recoveredEqualsSecret: recovered === S[k] });
  }
  // 3. URL-encoded copy
  { const resu = await run('up__url_echo', { v: '{{vault:SLASH_KEY}}' }); const t = textOf(resu);
    result('url_echo SLASH_KEY', { text: t, recoveredEqualsSecret: decodeURIComponent(t.split('key=')[1] || '') === S.SLASH_KEY }); }
  // 4. Secret as an object KEY in structuredContent
  { const resu = await run('up__keyed', { v: '{{vault:KEYED}}' });
    result('keyed structuredContent', { structuredContent: resu?.structuredContent, leaked: Object.keys(resu?.structuredContent || {}).includes(S.KEYED) }); }
  // 5. Split across content blocks
  { const resu = await run('up__split', { v: '{{vault:KEYED}}' });
    result('split blocks', { blocks: (resu?.content || []).map((c) => c.text), joinedEqualsSecret: (resu?.content || []).map((c) => c.text).join('') === S.KEYED }); }
  // 6. Short secret (3 chars, CVV-like)
  { const resu = await run('up__echo', { v: 'cvv={{vault:SHORT}}' }); result('short secret echo', textOf(resu)); }
  // 7. Over-masking: a 4-char secret shared with the agent mangles unrelated output (agent did not even use it)
  { const resu = await run('up__json_report', {}); const t = textOf(resu); let parses = true; try { JSON.parse(t); } catch { parses = false; }
    result('PIN over-masking unrelated output', { text: t, stillValidJson: parses }); }
  // 8. resources/read and prompts/get ERROR paths with the connection's own (unshared) header secret
  { const r = await L.rpc('resources/read', { uri: `loop://up/${encodeURIComponent('file:///x')}` }, { token: ag.token });
    result('resources/read error', { msg: r.json?.error?.message, leaked: JSON.stringify(r.json).includes(S.CONN_KEY) }); }
  { const r = await L.rpc('prompts/get', { name: 'up__p', arguments: {} }, { token: ag.token });
    result('prompts/get error', { msg: r.json?.error?.message, leaked: JSON.stringify(r.json).includes(S.CONN_KEY) }); }
  // 9. lastError surfaced to agents via loop__search / loop__inspect
  { const r = await L.callTool('loop__search', { type: 'connections' }, { token: ag.token });
    const s = JSON.stringify(r.json);
    result('loop__search connections leaks CONN_KEY', s.includes(S.CONN_KEY));
    result('loop__search connections leaks STDIO_KEY', s.includes(S.STDIO_KEY)); }
  for (const id of ['bad', 'crashy']) {
    const r = await L.callTool('loop__inspect', { type: 'connection', id }, { token: ag.token });
    const s = JSON.stringify(r.json);
    const m = s.match(/(Forbidden[^"\\]*|FATAL[^"\\]*)/);
    result(`loop__inspect ${id}`, { leaksConnKey: s.includes(S.CONN_KEY), leaksStdioKey: s.includes(S.STDIO_KEY), snippet: m?.[0] });
  }
  // 10. Activity log on disk stores the unmasked error text
  await new Promise((r) => setTimeout(r, 300));
  const fs = await import('node:fs');
  const act = fs.readFileSync(`${L.dataDir}/activity.jsonl`, 'utf8');
  result('activity.jsonl contains CONN_KEY plaintext', act.includes(S.CONN_KEY));
} catch (e) { result('FATAL', String(e?.stack || e)); }
finally { await L.close(); await up.close(); await bad.close(); }
