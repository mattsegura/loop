// P9: Vault.resolveString uses /\{\{vault:([^}]+)\}\}/g (unbounded) -> quadratic scan on unclosed placeholders.
import { sandboxDir, result } from '../../harness.mjs';
const { Vault } = await import('../../../../lib/vault.mjs');
const { findSecretRefs } = await import('../../../../lib/secret-refs.mjs');
const v = new Vault(sandboxDir('redos'));
await v.set('X', 'x-value-123456', '');
const rows = [];
for (const n of [2500, 5000, 10000, 20000]) {
  const s = '{{vault:'.repeat(n);
  let t = Date.now();
  findSecretRefs({ headers: { Authorization: s } });
  const strictMs = Date.now() - t;
  t = Date.now();
  try { await v.resolveString(s); } catch (e) { /* no match -> returns str */ }
  rows.push({ n, kb: Math.round(s.length / 1024), strictRegexMs: strictMs, vaultResolveMs: Date.now() - t });
}
result('resolveString scaling', rows);
const per = rows.at(-1).vaultResolveMs / (rows.at(-1).kb ** 2);
result('extrapolated ms for a ~960 KB header value (fits the 1 MB body limit)', Math.round(per * 960 * 960));
