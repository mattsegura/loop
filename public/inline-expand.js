// Inline expansion: nothing in Loop opens as a pop-up over the page. A connection, an agent, a
// profile or a Vault form opens right under the row you clicked and pushes the rest of the list
// down as an inline disclosure row. Clicking the same control again, the close button,
// or Esc folds it back up.
//
// placeInline(el) puts a panel (the old .st-root popups) under the row that opened it.
// Every <dialog>.showModal() in the app is routed through the same placement, so dialogs open
// inline too; their own open/close/submit code is unchanged.

const ROW_SEL = '.st-row, .row, li, tr, summary, [role="listitem"], .hm-conn, .secret-row';
const PANEL_SEL = '.xp-panel';
const ANCHOR_FRESH_MS = 2500;

let lastClick = null; // { anchor, opener, t }

function isSideBySide(parent) {
  const cs = getComputedStyle(parent);
  if (cs.display.includes('flex')) return !cs.flexDirection.startsWith('column');
  if (cs.display.includes('grid')) return cs.gridTemplateColumns.trim().split(/\s+/).length > 1;
  return cs.display.includes('inline');
}

// The row (or block) the click came from. A panel goes after it, so it must sit in a column of blocks:
// climb out of flex rows and multi-column grids until the panel can take the full width.
function anchorFor(target) {
  if (!(target instanceof Element)) return null;
  const inPanel = target.closest(PANEL_SEL);
  // A click inside an open panel that opens another panel replaces it in the same place.
  if (inPanel) return inPanel.__xpAnchor?.isConnected ? inPanel.__xpAnchor : inPanel;
  if (target.closest('.nav, .top, .pf-menu, .pf-side, .toast, #toast')) return null;
  // A row, or a section heading's own + button (the form opens under the heading).
  let a = target.closest(ROW_SEL) || target.closest('h2, h3, .hm-lib');
  // Not a row (a page header button, say): the panel opens at the top of the page's list instead.
  if (!a || a.closest('.lib-top, .hm-bar, .ctl-search')) return null;
  while (a.parentElement && a.parentElement !== document.body && isSideBySide(a.parentElement)) a = a.parentElement;
  if (a.matches('main, .view, body')) return null;
  return a;
}

document.addEventListener('click', (e) => {
  const opener = e.target instanceof Element ? e.target.closest('button, a, [role="button"], summary, [tabindex]') : null;
  // Clicking the control that opened a panel folds it back up.
  if (opener && opener.classList.contains('xp-opener')) {
    const panel = [...document.querySelectorAll(PANEL_SEL)].find((p) => p.__xpOpener === opener);
    if (panel) {
      e.preventDefault();
      e.stopImmediatePropagation();
      collapse(panel);
      return;
    }
  }
  lastClick = { anchor: anchorFor(e.target), opener, target: e.target, t: Date.now() };
}, true);

function visibleView() {
  return [...document.querySelectorAll('main .view')].find((v) => v.style.display !== 'none') || document.querySelector('main');
}

// No row was clicked (a page header button, or nothing at all): open at the top of the page's list,
// or right under the page header when the page has no list.
function fallbackSpot(target) {
  const view = visibleView();
  if (!view) return null;
  const list = view.querySelector('.ctl-scroll');
  if (list) return { prepend: list };
  if (target instanceof Element && view.contains(target)) {
    let block = target;
    while (block.parentElement && block.parentElement !== view && !(block.parentElement.parentElement === view && block.parentElement.children.length > 1)) {
      block = block.parentElement;
    }
    if (block.parentElement) return { after: block };
  }
  return { prepend: view.firstElementChild || view };
}

function collapse(panel) {
  if (panel.tagName === 'DIALOG') {
    const ev = new Event('cancel', { cancelable: true });
    if (panel.dispatchEvent(ev)) panel.close();
    return;
  }
  const x = panel.querySelector('.st-x, [data-cp-close]:not(.st-veil), [data-ap-close]:not(.st-veil)');
  if (x) x.click();
  else panel.remove();
}

function markAnchor(panel, anchor, opener) {
  panel.__xpAnchor = anchor;
  panel.__xpOpener = opener;
  anchor?.classList.add('xp-anchor');
  if (opener) {
    opener.classList.add('xp-opener');
    opener.setAttribute('aria-expanded', 'true');
  }
  const release = () => {
    if (anchor && ![...document.querySelectorAll(PANEL_SEL)].some((p) => p !== panel && p.__xpAnchor === anchor && isOpen(p))) {
      anchor.classList.remove('xp-anchor');
    }
    if (opener) {
      opener.classList.remove('xp-opener');
      opener.setAttribute('aria-expanded', 'false');
    }
  };
  const mo = new MutationObserver(() => {
    // Closed, or opened again from another row.
    if (!panel.isConnected || !isOpen(panel) || panel.__xpOpener !== opener) {
      release();
      mo.disconnect();
    }
  });
  mo.observe(panel, { attributes: true, attributeFilter: ['class', 'open'] });
  // Removal from the page (a re-render) also ends it.
  const gone = new MutationObserver(() => {
    if (!panel.isConnected) {
      release();
      gone.disconnect();
      mo.disconnect();
    }
  });
  gone.observe(document.body, { childList: true, subtree: true });
}

function isOpen(panel) {
  return panel.tagName === 'DIALOG' ? panel.open : panel.classList.contains('is-open') || !panel.classList.contains('xp-seen');
}

// Puts a panel under the row that was just clicked, or where the panel before it was (`was`), or at
// the top of the page.
export function placeInline(el, was = null) {
  const fresh = lastClick && Date.now() - lastClick.t < ANCHOR_FRESH_MS ? lastClick : null;
  let anchor = fresh?.anchor?.isConnected ? fresh.anchor : was?.isConnected ? was : null;
  let opener = fresh?.opener?.isConnected ? fresh.opener : null;
  // Replacing a panel that is being torn down: take over its spot.
  if (anchor && anchor.matches?.(PANEL_SEL)) {
    const old = anchor;
    anchor = old.__xpAnchor?.isConnected ? old.__xpAnchor : null;
    opener = old.__xpOpener?.isConnected ? old.__xpOpener : null;
    if (!anchor) {
      old.before(el);
      anchor = null;
    }
  }
  if (opener && el.contains(opener)) opener = null;
  el.classList.add('xp-panel');
  if (anchor) anchor.after(el);
  else if (!el.isConnected || el.parentElement === document.body) {
    const spot = fallbackSpot(fresh?.target);
    if (spot?.after) spot.after.after(el);
    else if (spot?.prepend) {
      spot.prepend.prepend(el);
      if (spot.prepend.scrollTop) spot.prepend.scrollTop = 0;
    } else document.body.appendChild(el);
  }
  markAnchor(el, anchor, opener && !opener.matches(PANEL_SEL) ? opener : null);
  lastClick = null;
  // Once it has opened, keep the row in view and show as much of the panel as fits.
  setTimeout(() => {
    el.classList.add('xp-seen', 'is-done');
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 90) {
      (anchor || el).scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, 280);
  return el;
}

/* ---------- dialogs ---------- */

const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function showModalInline() {
  if (this.dataset.modal === 'keep') return nativeShowModal.call(this);
  if (this.open) return undefined;
  placeInline(this);
  this.classList.add('xp-dialog');
  this.show();
  if (!this.__xpKeys) {
    this.__xpKeys = true;
    // Non-modal dialogs get no Esc handling from the browser; keep Esc closing them.
    this.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      collapse(this);
    });
  }
  return undefined;
};
