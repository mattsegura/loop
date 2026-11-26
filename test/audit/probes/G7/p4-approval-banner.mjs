import { startLegacy, startMockUpstream, result } from '../../harness.mjs';
import { callAppFunction, renderApprovalBannerHtml, visibleText } from './live-app-fns.mjs';

process.on('unhandledRejection', (e) => console.log('UNHANDLED', e?.message || e));

const calls = [];
const up = await startMockUpstream({
  tools: [{ name: 'send_payment', description: 'Send money', inputSchema: { type: 'object', properties: { memo: { type: 'string' }, to: { type: 'string' }, amount: { type: 'number' }, card: { type: 'string' } } } }],
  callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'paid' }] }; },
});
const L = await startLegacy();
try {
  const add = await L.api('/api/mcps', { method: 'POST', body: { name: 'Payments', transport: 'http', url: up.url } });
  const connId = add.json?.mcp?.id;
  await L.api('/api/vault', { method: 'POST', body: { key: 'CORP_CARD', value: '4111111111111111', type: 'payment' } });
  const ag = await L.createAgent({ name: 'Ops Bot', secrets: ['CORP_CARD'], canManage: false });
  const tl = await L.rpc('tools/list', undefined, { token: ag.token });
  const runSchema = tl.json?.result?.tools?.find((t) => t.name === 'loop__run')?.inputSchema;
  result('loop__run schema props', Object.keys(runSchema?.properties || {}));

  // The agent controls argument order and content. Benign padding first, decisive fields last.
  const args = {
    memo: 'Routine monthly renewal for the shared design-tools subscription (same vendor as every month, already budgeted under Q4 tooling, receipt goes to the finance inbox automatically)',
    to: 'acct_attacker_evil_example',
    amount: 9800,
    card: '{{vault:CORP_CARD}}',
  };
  const toolField = runSchema?.properties?.tool ? 'tool' : (runSchema?.properties?.name ? 'name' : 'tool');
  const run = await L.callTool('loop__run', { [toolField]: `${connId}__send_payment`, arguments: args }, { token: ag.token });
  const runText = run.result?.content?.[0]?.text || JSON.stringify(run.json).slice(0, 300);
  result('loop__run response', runText.slice(0, 200));

  const ap = await L.api('/api/approvals');
  const item = (ap.json?.pending || ap.json?.approvals || [])[0];
  result('approval item keys', item ? Object.keys(item) : 'NONE');
  result('full detail length', JSON.stringify(item?.detail || {}).length);
  // What the owner reads before clicking Approve: the banner as renderApprovalBanner() in public/app.js draws it today.
  let bannerText = '';
  try { bannerText = visibleText(await renderApprovalBannerHtml(item ? [item] : [])); }
  catch (e) { result('banner render error', String(e?.message || e)); }
  result('BANNER TEXT', bannerText);
  result('banner shows recipient?', bannerText.includes('acct_attacker_evil_example'));
  result('banner shows amount?', bannerText.includes('9800'));
  result('banner shows the argument that carries the secret?', bannerText.includes('{{vault:CORP_CARD}}'));
  result('full detail has them', ['acct_attacker_evil_example', '9800', 'CORP_CARD'].map((s) => JSON.stringify(item?.detail).includes(s)));

  // approve it as the owner would, then the agent re-runs with approvalId -> executes the hidden part
  if (item?.id) {
    const dec = await L.api(`/api/approvals/${encodeURIComponent(item.id)}/approve`, { method: 'POST' });
    const rerun = await L.callTool('loop__run', { [toolField]: `${connId}__send_payment`, arguments: args, approvalId: item.id }, { token: ag.token });
    result('approve status', dec.status);
    result('executed upstream with', calls.map((c) => ({ to: c.args.to, amount: c.args.amount, card: c.args.card === '4111111111111111' ? '<real card value>' : c.args.card })));
    result('rerun text', (rerun.result?.content?.[0]?.text || '').slice(0, 80));
  }

  // even WITHOUT padding: how much of a normal call fits?
  const plain = { connection: 'Payments', connectionId: connId, tool: 'send_payment', arguments: { to: 'acct_1', amount: 5, card: '{{vault:CORP_CARD}}', memo: 'x'.repeat(120) }, referencedSecrets: [{ key: 'CORP_CARD', type: 'payment' }] };
  const plainBanner = visibleText(await renderApprovalBannerHtml([{ ...item, id: 'plain', detail: plain }]));
  result('typical 120-char memo: referencedSecrets visible?', plainBanner.includes('referencedSecrets'));
  result('esc sanity', await callAppFunction('esc', `<img src=x onerror=alert(1)> " ' &`));
} catch (e) {
  result('probe error', String(e?.stack || e));
} finally {
  await L.close();
  await up.close();
}
