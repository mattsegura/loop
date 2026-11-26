// Loop v3 hybrid views:
// - #setup: Guided 3-step first-run setup (live Agent detection, verified 1-click catalog + API import, first-call confirmation)
// - #service / #service/<key>: Grouped service accounts, inline account labels/notes, Access Sets editor
// - #chat: Built-in web console for searching and running Loop tools directly from the browser

let setupPollTimer = null;

export function destroySetupView() {
  if (setupPollTimer) {
    clearInterval(setupPollTimer);
    setupPollTimer = null;
  }
}

export async function renderSetup(view, ui) {
  destroySetupView();
  const { api, esc, toast } = ui;

  view.innerHTML = `
    <section class="view-section v3-setup" data-setup-view>
      <div class="sec-head">
        <div>
          <h1>Set up Loop</h1>
          <p class="hint">Connect one agent, add one service, and run your first tool call.</p>
        </div>
        <a class="btn sm ghost" href="#home">Back to Home</a>
      </div>
      <div class="v3-steps" data-setup-steps>
        <div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Loading setup…</p></div>
      </div>
      <div class="v3-catalog" data-setup-catalog></div>
    </section>
  `;

  const stepsEl = view.querySelector('[data-setup-steps]');
  const catalogEl = view.querySelector('[data-setup-catalog]');

  async function refreshStatus() {
    if (!view.isConnected) {
      destroySetupView();
      return;
    }
    try {
      const status = await api('/api/setup/status');
      const s = status?.steps || {};
      stepsEl.innerHTML = `
        <div class="card">
          <h3>1. Connect an agent ${s.agentConnected ? '✓' : ''}</h3>
          <p class="hint">${s.agentConnected
            ? `${status.agentCount} agent(s) connected.`
            : 'Open Add Agent on Home or connect your coding assistant to Loop.'}</p>
        </div>
        <div class="card">
          <h3>2. Add a service ${s.serviceConnected ? '✓' : ''}</h3>
          <p class="hint">${s.serviceConnected
            ? `${status.connectionCount} service(s) connected.`
            : 'Pick a verified service below or import any OpenAPI or GraphQL API address.'}</p>
        </div>
        <div class="card">
          <h3>3. First tool call ${s.firstCallDone ? '✓' : ''}</h3>
          <p class="hint">${s.firstCallDone
            ? 'Loop recorded your first live call.'
            : 'Ask your connected agent to use a tool, or test one right now in Chat.'}</p>
          <div class="acts"><a class="btn sm" href="#chat">Open Loop Chat</a></div>
        </div>
      `;
      if (s.agentConnected && s.serviceConnected && s.firstCallDone) {
        destroySetupView();
      }
    } catch {
      // Ignore transient poll errors.
    }
  }

  async function loadCatalog() {
    try {
      const data = await api('/api/catalog');
      const items = Array.isArray(data?.items) ? data.items : [];
      catalogEl.innerHTML = `
        <div class="card">
          <h2>Verified services</h2>
          <div class="v3-catalog-grid">
            ${items.map((item) => `
              <div class="v3-cat-item">
                <div>
                  <strong>${esc(item.name)}</strong>
                  <div class="hint">${esc(item.description || '')}</div>
                </div>
                <button type="button" class="btn sm ${item.connected ? 'ghost' : 'fill'}" data-catalog-add="${esc(item.id)}">
                  ${item.connected ? 'Add another account' : 'Connect'}
                </button>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="card">
          <h2>Add any API address (OpenAPI or GraphQL)</h2>
          <form class="form-grid" data-api-import-form>
            <label class="field">
              <span class="lbl">Transport</span>
              <select name="transport">
                <option value="openapi">OpenAPI (JSON or YAML)</option>
                <option value="graphql">GraphQL Endpoint</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">Name</span>
              <input type="text" name="name" placeholder="Stripe API" required>
            </label>
            <label class="field">
              <span class="lbl">API or Spec URL</span>
              <input type="url" name="url" placeholder="https://api.example.com/openapi.json" required>
            </label>
            <label class="field">
              <span class="lbl">Account label (optional)</span>
              <input type="text" name="accountLabel" placeholder="Work">
            </label>
            <div class="acts">
              <button type="submit" class="btn fill">Import API</button>
            </div>
          </form>
        </div>
      `;

      catalogEl.querySelectorAll('[data-catalog-add]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-catalog-add');
          btn.disabled = true;
          try {
            const added = await api(`/api/catalog/${encodeURIComponent(id)}/add`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            toast(`Added ${added?.connection?.name || id}.`, 'ok');
            await Promise.all([refreshStatus(), loadCatalog()]);
          } catch (err) {
            toast(err?.message || 'Could not add service.', 'err');
          } finally {
            btn.disabled = false;
          }
        });
      });

      const form = catalogEl.querySelector('[data-api-import-form]');
      form?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const transport = String(fd.get('transport') || 'openapi');
        const payload = {
          transport,
          name: String(fd.get('name') || '').trim(),
          accountLabel: String(fd.get('accountLabel') || '').trim(),
          ...(transport === 'openapi'
            ? { specUrl: String(fd.get('url') || '').trim() }
            : { url: String(fd.get('url') || '').trim() }),
        };
        try {
          const res = await api('/api/mcps/import-api', { method: 'POST', body: JSON.stringify(payload) });
          toast(`Imported ${res?.connection?.name || payload.name} (${res?.toolCount ?? 0} tools).`, 'ok');
          form.reset();
          await refreshStatus();
        } catch (err) {
          toast(err?.message || 'Import failed.', 'err');
        }
      });
    } catch (err) {
      catalogEl.innerHTML = `<p class="hint">Could not load catalog: ${esc(err?.message || 'error')}</p>`;
    }
  }

  await Promise.all([refreshStatus(), loadCatalog()]);
  setupPollTimer = setInterval(refreshStatus, 2000);
}

export async function renderServicePage(view, ui, serviceKey = '') {
  const { api, esc, toast } = ui;

  async function load() {
    const [svcData, setsData] = await Promise.all([
      api('/api/services'),
      api('/api/access-sets'),
    ]);
    const services = Array.isArray(svcData?.services) ? svcData.services : [];
    const accessSets = Array.isArray(setsData?.accessSets) ? setsData.accessSets : [];
    const filtered = serviceKey
      ? services.filter((s) => s.key === serviceKey)
      : services;

    view.innerHTML = `
      <section class="view-section v3-services" data-service-view>
        <div class="sec-head">
          <div>
            <h1>${serviceKey && filtered[0] ? esc(filtered[0].name) : 'Services & Access Sets'}</h1>
            <p class="hint">Manage multi-account labels, agent notes, and reusable Access Sets.</p>
          </div>
          <div class="acts">
            <a class="btn sm ghost" href="#setup">Setup</a>
            <a class="btn sm ghost" href="#home">Home</a>
          </div>
        </div>

        <div class="v3-service-list">
          ${filtered.length === 0 ? '<p class="hint">No matching services connected yet.</p>' : filtered.map((svc) => `
            <div class="card">
              <h2>${esc(svc.name)} <span class="hint">(${svc.accounts.length} account${svc.accounts.length === 1 ? '' : 's'})</span></h2>
              ${svc.accounts.map((acc) => `
                <form class="form-grid v3-acct-form" data-conn-id="${esc(acc.connectionId || acc.id)}">
                  <div><strong>${esc(acc.name)}</strong> <span class="hint">${esc(acc.transport || acc.status || '')} · ${acc.toolCount ?? 0} tools</span></div>
                  <label class="field">
                    <span class="lbl">Account label</span>
                    <input type="text" name="accountLabel" value="${esc(acc.accountLabel || acc.label || '')}" placeholder="Work / Personal">
                  </label>
                  <label class="field">
                    <span class="lbl">Note for agents</span>
                    <input type="text" name="agentNote" value="${esc(acc.agentNote || acc.note || '')}" placeholder="When should agents use this account?">
                  </label>
                  <div class="acts"><button type="submit" class="btn sm fill">Save account</button></div>
                </form>
              `).join('')}
            </div>
          `).join('')}
        </div>

        <div class="card">
          <h2>Access Sets</h2>
          <p class="hint">Reusable permission bundles that control which services, tools, and skills an Agent can see.</p>
          <div class="v3-sets-list">
            ${accessSets.map((s) => `
              <div class="v3-set-row">
                <div>
                  <strong>${esc(s.name)}</strong> <span class="hint">(${esc(s.id)}${s.builtin ? ', built-in' : ''})</span>
                  <div class="hint">${esc(s.description || '')}</div>
                </div>
                ${s.builtin ? '' : `<button type="button" class="btn sm ghost" data-del-set="${esc(s.id)}">Delete</button>`}
              </div>
            `).join('')}
          </div>
          <form class="form-grid" data-new-set-form>
            <h3>Create Access Set</h3>
            <label class="field">
              <span class="lbl">Name</span>
              <input type="text" name="name" placeholder="Support Triage" required>
            </label>
            <label class="field">
              <span class="lbl">Read-only mode</span>
              <select name="readOnly">
                <option value="false">Allow writes (per policy)</option>
                <option value="true">Read-only tools only</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">Allowed tools (comma-separated, optional)</span>
              <input type="text" name="tools" placeholder="gmail__search, slack__list_channels">
            </label>
            <div class="acts"><button type="submit" class="btn sm fill">Create Access Set</button></div>
          </form>
        </div>
      </section>
    `;

    view.querySelectorAll('.v3-acct-form').forEach((form) => {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const connId = form.getAttribute('data-conn-id');
        const fd = new FormData(form);
        try {
          await api(`/api/mcps/${encodeURIComponent(connId)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              accountLabel: String(fd.get('accountLabel') || '').trim(),
              agentNote: String(fd.get('agentNote') || '').trim(),
            }),
          });
          toast('Saved account settings.', 'ok');
        } catch (err) {
          toast(err?.message || 'Save failed.', 'err');
        }
      });
    });

    view.querySelectorAll('[data-del-set]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-set');
        try {
          await api(`/api/access-sets/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Deleted access set.', 'ok');
          await load();
        } catch (err) {
          toast(err?.message || 'Delete failed.', 'err');
        }
      });
    });

    view.querySelector('[data-new-set-form]')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.currentTarget);
      const rawTools = String(fd.get('tools') || '').split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await api('/api/access-sets', {
          method: 'POST',
          body: JSON.stringify({
            name: String(fd.get('name') || '').trim(),
            readOnly: fd.get('readOnly') === 'true',
            ...(rawTools.length ? { tools: rawTools } : {}),
          }),
        });
        toast('Created access set.', 'ok');
        await load();
      } catch (err) {
        toast(err?.message || 'Could not create access set.', 'err');
      }
    });
  }

  await load();
}

export async function renderChat(view, ui) {
  const { api, esc, toast } = ui;
  const history = [];

  view.innerHTML = `
    <section class="view-section v3-chat" data-chat-view>
      <div class="sec-head">
        <div>
          <h1>Loop Chat Console</h1>
          <p class="hint">Search connected tools, inspect schemas, or run actions directly inside Loop.</p>
        </div>
        <div class="acts">
          <button type="button" class="btn sm ghost" data-quick="/services">Services</button>
          <button type="button" class="btn sm ghost" data-quick="/approvals">Approvals</button>
          <button type="button" class="btn sm ghost" data-quick="/help">Help</button>
        </div>
      </div>
      <div class="card v3-chat-log" data-chat-log>
        <p class="hint">Type a search or slash command (for example <code>/services</code> or <code>/run conn__tool {}</code>).</p>
      </div>
      <form class="v3-chat-form" data-chat-form>
        <input type="text" name="message" placeholder="Ask Loop or enter /search, /run, /approvals…" autocomplete="off" required>
        <button type="submit" class="btn fill">Send</button>
      </form>
    </section>
  `;

  const logEl = view.querySelector('[data-chat-log]');
  const form = view.querySelector('[data-chat-form]');
  const input = form.querySelector('input[name="message"]');

  function paint() {
    logEl.innerHTML = history.map((entry) => `
      <div class="v3-chat-msg v3-chat-${esc(entry.role)}">
        <strong>${entry.role === 'user' ? 'You' : 'Loop'}</strong>
        <pre class="v3-chat-pre">${esc(entry.text)}</pre>
        ${entry.details ? `<details><summary>Details</summary><pre class="v3-chat-pre">${esc(entry.details)}</pre></details>` : ''}
      </div>
    `).join('');
  }

  async function sendMessage(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    history.push({ role: 'user', text: trimmed });
    paint();
    try {
      const res = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });
      const detailObj = res?.result || res?.services || res?.pending || null;
      history.push({
        role: 'assistant',
        text: res?.reply || 'Done.',
        details: detailObj ? JSON.stringify(detailObj, null, 2).slice(0, 4000) : '',
      });
      paint();
    } catch (err) {
      toast(err?.message || 'Chat request failed.', 'err');
      history.push({ role: 'assistant', text: err?.message || 'Request failed.' });
      paint();
    }
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = input.value;
    input.value = '';
    await sendMessage(msg);
  });

  view.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => sendMessage(btn.getAttribute('data-quick')));
  });
}
