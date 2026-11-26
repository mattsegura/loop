// This is a one-time tightening of existing tool switches, not a promise about future tools.
export function readOnlyPresetTargets(mcp) {
  const disabled = new Set(mcp.disabledTools || []);
  return (mcp.tools || []).filter(t => t.enabled !== false && !disabled.has(t.name) && t.annotations?.readOnlyHint !== true).map(t => t.name);
}

export function readOnlyPresetHtml(mcp, esc) {
  const targets = readOnlyPresetTargets(mcp);
  if (!targets.length) return '';
  const disabled = new Set(mcp.disabledTools || []);
  const enabledCount = (mcp.tools || []).filter(t => t.enabled !== false && !disabled.has(t.name)).length;
  const remaining = Math.max(0, enabledCount - targets.length);
  const remainText = remaining === 0
    ? 'No tools will stay enabled.'
    : `${remaining} read-only ${remaining === 1 ? 'tool' : 'tools'} will stay enabled. No disabled tools will be turned on.`;
  const targetWord = targets.length === 1 ? 'tool' : 'tools';
  return `<details><summary>Read-only preset</summary><p>Turn off ${targets.length === 1 ? 'this 1' : `these ${targets.length}`} currently enabled ${targetWord} without a read-only label. ${remainText} Review new tools separately after future syncs.</p>
    <p>${targets.map(esc).join(', ')}</p><button type="button" class="btn sm" data-cp-apply-read-only>Turn off ${targets.length} ${targetWord}</button></details>`;
}
