// Share a project: two kinds of link (Me / Someone else), plus who has joined.
// ctx: { api, esc, toast, ownerName }
import { confirmDialog } from './components/confirm-dialog.js';

const KIND_COPY = {
  me: { title: 'Me', desc: 'For another of my agents or devices. Signs in as me.' },
  other: { title: 'Someone else', desc: 'They get this project only. They can’t see your other projects.' },
};

export function openShareSheet(ctx, { profileId, profileName }) {
  const { api, esc, toast } = ctx;
  if (!profileId || profileId === 'all') {
    toast('Make a project first. All is never shared.', 'err');
    return;
  }
  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog share-dialog';
  dlg.setAttribute('aria-labelledby', 'share-title');
  let kind = 'other';
  const links = {};
  const revoked = {};
  let members = [];

  const paint = () => {
    const link = links[kind] || null;
    const url = link?.url || '';
    const isRevoked = Boolean(revoked[kind]) && !link;
    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="share-title">Share ${esc(profileName || profileId)}</h3>
        <button type="button" class="btn sm ghost" data-share-close>Done</button>
      </div>
      <p class="sub">Who is the link for?</p>
      <div class="share-opts" role="radiogroup" aria-label="Who is the link for">
        ${Object.entries(KIND_COPY).map(([k, c]) => `
          <button type="button" class="share-opt" role="radio" aria-checked="${k === kind}" data-share-kind="${k}">
            <span class="share-radio" aria-hidden="true"></span>
            <span><span class="share-ot">${esc(c.title)}</span><span class="share-od">${esc(c.desc)}</span></span>
          </button>`).join('')}
      </div>
      <div class="share-link">
        <span class="share-url" data-share-url>${url ? esc(url) : isRevoked ? 'Link revoked. Make a new link to share again.' : 'Making link…'}</span>
        ${isRevoked
          ? '<button type="button" class="btn sm fill" data-share-remake>New link</button>'
          : `<button type="button" class="btn sm fill" data-share-copy ${url ? '' : 'disabled'}>Copy link</button>
             ${link?.code ? '<button type="button" class="btn sm ghost danger-text" data-share-revoke>Revoke</button>' : ''}`}
      </div>
      ${members.length ? `
        <div class="share-members">
          <div class="share-mh">People with access <span>${esc(members.length)}</span></div>
          ${members.map((m) => `
            <div class="share-member">
              <span class="share-av" aria-hidden="true">${esc((m.name || '?').slice(0, 1).toUpperCase())}</span>
              <span class="share-mn">${esc(m.name)}${m.email ? ` <span class="share-me">${esc(m.email)}</span>` : ''}
                <span class="share-ma">${m.agents.length ? esc(m.agents.join(', ')) : 'No agents yet'}</span></span>
              <button type="button" class="btn sm ghost" data-share-remove="${esc(m.id)}">Remove</button>
            </div>`).join('')}
        </div>` : ''}
    `;
    dlg.querySelector('[data-share-close]').onclick = () => dlg.close();
    dlg.querySelectorAll('[data-share-kind]').forEach((btn) => {
      btn.onclick = () => {
        kind = btn.dataset.shareKind;
        paint();
        if (!links[kind] && !revoked[kind]) ensureLink();
      };
    });
    const copyBtn = dlg.querySelector('[data-share-copy]');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(links[kind]?.url || '');
          toast('Link copied.', 'ok');
        } catch {
          toast('Copy failed. Select the link and copy it.', 'err');
        }
      };
    }
    const revokeBtn = dlg.querySelector('[data-share-revoke]');
    if (revokeBtn) {
      revokeBtn.onclick = async () => {
        const cur = links[kind];
        if (!cur?.code) return;
        const ok = await confirmDialog({
          title: 'Revoke this invite link?',
          message: 'New guests cannot join with this link anymore. Existing members keep access until you remove them.',
          confirmLabel: 'Revoke link',
          danger: true,
        });
        if (!ok) return;
        revokeBtn.disabled = true;
        try {
          await api(`/api/shares/${encodeURIComponent(cur.code)}`, { method: 'DELETE' });
          delete links[kind];
          revoked[kind] = true;
          toast('Invite link revoked.', 'ok');
          if (dlg.open) paint();
        } catch (err) {
          toast(err.message || 'Could not revoke link.', 'err');
          revokeBtn.disabled = false;
        }
      };
    }
    const remakeBtn = dlg.querySelector('[data-share-remake]');
    if (remakeBtn) {
      remakeBtn.onclick = () => {
        delete revoked[kind];
        paint();
        ensureLink();
      };
    }
    dlg.querySelectorAll('[data-share-remove]').forEach((btn) => {
      btn.onclick = async () => {
        const m = members.find((x) => x.id === btn.dataset.shareRemove);
        if (!m) return;
        const ok = await confirmDialog({
          title: `Remove ${m.name}?`,
          message: `Their agents lose access to ${profileName} right away.`,
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await api(`/api/shares/members/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
          members = members.filter((x) => x.id !== m.id);
          toast(`Removed ${m.name}.`, 'ok');
          paint();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
        }
      };
    });
  };

  const ensureLink = async () => {
    if (links[kind]) return;
    const want = kind;
    try {
      const res = await api('/api/shares', {
        method: 'POST',
        body: JSON.stringify({ profile: profileId, kind: want, ownerName: ctx.ownerName || '' }),
      });
      links[want] = { code: res.code, url: res.url };
      delete revoked[want];
      if (kind === want && dlg.open) paint();
    } catch (err) {
      const msg = err?.status === 405
        ? 'Project sharing requires Loop Cloud.'
        : (err?.message || 'Could not create share link.');
      if (kind === want && dlg.open) {
        const urlEl = dlg.querySelector('[data-share-url]');
        const copyEl = dlg.querySelector('[data-share-copy]');
        if (urlEl) urlEl.textContent = msg;
        if (copyEl) copyEl.disabled = true;
      }
      toast(msg, 'err');
    }
  };

  const loadMembers = async () => {
    try {
      const res = await api(`/api/shares/profiles/${encodeURIComponent(profileId)}/members`);
      members = Array.isArray(res?.members) ? res.members : [];
      if (dlg.open) paint();
    } catch {
      // Members list is optional; the link still works.
    }
  };

  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  paint();
  dlg.showModal();
  ensureLink();
  loadMembers();
}
