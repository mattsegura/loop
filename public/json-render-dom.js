// Zero-build vanilla DOM renderer for Loop @json-render/core Specs ({ root, elements, state }).
// Strictly uses DOM node creation + textContent (never raw HTML injection).

function getStatePath(state, path) {
  if (!state || typeof state !== 'object' || typeof path !== 'string') return undefined;
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
  let cur = state;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function resolveProp(val, state) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
  if (typeof val.$state === 'string') return getStatePath(state, val.$state);
  if (typeof val.$bindState === 'string') return getStatePath(state, val.$bindState);
  return val;
}

function resolveProps(rawProps, state) {
  const out = {};
  for (const [k, v] of Object.entries(rawProps || {})) out[k] = resolveProp(v, state);
  return out;
}

function isVisible(cond, state) {
  if (cond === undefined || cond === null || cond === true) return true;
  if (cond === false) return false;
  if (Array.isArray(cond)) return cond.every((c) => isVisible(c, state));
  if (typeof cond !== 'object') return Boolean(cond);
  if (Array.isArray(cond.$and)) return cond.$and.every((c) => isVisible(c, state));
  if (Array.isArray(cond.$or)) return cond.$or.some((c) => isVisible(c, state));
  if (typeof cond.$state === 'string') {
    const val = getStatePath(state, cond.$state);
    if (Object.hasOwn(cond, 'eq')) return val === cond.eq;
    if (Object.hasOwn(cond, 'neq')) return val !== cond.neq;
    if (cond.not) return !val;
    return Boolean(val);
  }
  return true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Renders a validated @json-render/core Spec into a DOM element tree.
 * Returns { element, getValues(), setBusy(bool), showError(msg) }.
 * Pass { readOnly: true } for Saved items & Agent Artifacts so interactive controls are never rendered.
 */
export function renderJsonRenderDom(spec, { onAction, titleId = 'approval-focus-title', readOnly = false } = {}) {
  const state = structuredClone(spec?.state && typeof spec.state === 'object' ? spec.state : {});
  if (!state.values || typeof state.values !== 'object') state.values = {};
  const values = state.values;
  const formControls = new Map();
  let errorEl = null;
  let rootEl = null;

  const readValues = () => {
    const out = { ...values };
    for (const [name, getter] of formControls.entries()) {
      out[name] = getter();
    }
    return out;
  };

  const renderNode = (key, depth = 0, seen = new Set()) => {
    if (!key || seen.has(key) || depth > 24) return null;
    const def = spec?.elements?.[key];
    if (!def || typeof def !== 'object') return null;
    if (!isVisible(def.visible, state)) return null;
    seen.add(key);
    const props = resolveProps(def.props, state);
    const renderChildren = (container) => {
      for (const childKey of Array.isArray(def.children) ? def.children : []) {
        const child = renderNode(childKey, depth + 1, seen);
        if (child) container.appendChild(child);
      }
    };

    if (def.type === 'Card') {
      const card = el('div', `jr-card apf-card${props.tone ? ` is-${props.tone}` : ''}`);
      if (props.kicker) card.appendChild(el('div', 'apf-kicker', props.kicker));
      if (props.title) {
        const h2 = el('h2', '', props.title);
        if (titleId) h2.id = titleId;
        card.appendChild(h2);
      }
      if (props.subtitle) card.appendChild(el('p', 'apf-sub', props.subtitle));
      renderChildren(card);
      errorEl = el('p', 'field-err');
      errorEl.hidden = true;
      card.appendChild(errorEl);
      return card;
    }

    if (def.type === 'Stack') {
      const box = el('div', `jr-stack is-${props.direction || 'column'} gap-${props.gap || 'md'}`);
      renderChildren(box);
      return box;
    }

    if (def.type === 'Heading') {
      const tag = props.level === 1 ? 'h2' : props.level === 3 ? 'h4' : 'h3';
      return el(tag, 'jr-heading', props.text || '');
    }

    if (def.type === 'Text') {
      const p = el('p', `jr-text${props.tone ? ` is-${props.tone}` : ''}${props.bold ? ' is-bold' : ''}`, props.text || '');
      return p;
    }

    if (def.type === 'Badge') {
      return el('span', `tag jr-badge${props.tone ? ` is-${props.tone}` : ''}`, props.label || '');
    }

    if (def.type === 'Alert' || def.type === 'Callout') {
      const box = el('div', `jr-alert is-${props.tone || 'info'}`);
      if (props.title) box.appendChild(el('strong', 'jr-alert-title', props.title));
      box.appendChild(el('span', 'jr-alert-text', props.text || ''));
      return box;
    }

    if (def.type === 'Link') {
      const rawUrl = String(props.url || '').trim();
      let safeHref = '';
      try {
        const parsed = new URL(rawUrl);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
          safeHref = parsed.href;
        }
      } catch {
        safeHref = '';
      }
      if (!safeHref) return el('div', 'jr-text is-muted', props.label || rawUrl);
      const a = document.createElement('a');
      a.className = props.variant === 'primary' ? 'btn btn-p jr-cta' : props.variant === 'secondary' ? 'btn jr-cta' : 'jr-link';
      a.href = safeHref;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(el('span', 'jr-link-title', props.label || safeHref));
      if (props.description && !props.variant) a.appendChild(el('span', 'jr-link-desc', props.description));
      return a;
    }

    if (def.type === 'Progress') {
      const maxVal = Number(props.max) > 0 ? Number(props.max) : 100;
      const pct = Math.max(0, Math.min(100, Math.round((Number(props.value || 0) / maxVal) * 100)));
      const box = el('div', 'jr-stack is-column gap-sm');
      box.appendChild(el('div', 'jr-text is-bold', `${props.label || 'Progress'} · ${pct}%`));
      const prog = document.createElement('progress');
      prog.max = 100;
      prog.value = pct;
      box.appendChild(prog);
      if (props.caption) box.appendChild(el('div', 'jr-text is-muted', props.caption));
      return box;
    }

    if (def.type === 'BarChart') {
      const items = Array.isArray(props.items) ? props.items : [];
      const wrap = el('div', 'jr-stack is-column gap-sm');
      if (props.title) wrap.appendChild(el('h4', 'jr-heading', props.title));
      const maxVal = Math.max(1, ...items.map((it) => Number(it.value) || 0));
      for (const it of items) {
        const row = el('div', 'jr-stack is-column gap-sm');
        row.appendChild(el('div', 'jr-text', `${it.label || ''} — ${it.displayValue !== undefined ? it.displayValue : String(it.value ?? 0)}`));
        const prog = document.createElement('progress');
        prog.max = maxVal;
        prog.value = Math.max(0, Number(it.value) || 0);
        row.appendChild(prog);
        wrap.appendChild(row);
      }
      return wrap;
    }

    if (def.type === 'Steps') {
      const list = el('ul', 'jr-checklist');
      const marks = { done: '✓', active: '●', pending: '○', error: '!' };
      for (const item of Array.isArray(props.items) ? props.items : []) {
        const st = item.status || 'pending';
        const li = el('li', `jr-check-item${st === 'done' ? ' is-done' : ''}`);
        li.appendChild(el('span', 'jr-check-mark', marks[st] || '○'));
        li.appendChild(el('span', 'jr-check-lbl', item.detail ? `${item.label || ''} — ${item.detail}` : (item.label || '')));
        list.appendChild(li);
      }
      return list;
    }

    if (def.type === 'ItemList') {
      const wrap = el('div', 'jr-facts');
      for (const item of Array.isArray(props.items) ? props.items : []) {
        const row = el('div', 'apf-row');
        row.appendChild(el('span', 'jr-text is-bold', item.title || ''));
        if (item.subtitle) row.appendChild(el('span', 'jr-text is-muted', item.subtitle));
        if (item.badge) row.appendChild(el('span', `tag jr-badge${item.badgeTone ? ` is-${item.badgeTone}` : ''}`, item.badge));
        wrap.appendChild(row);
      }
      return wrap;
    }

    if (def.type === 'Tabs') {
      const tabs = Array.isArray(props.items) ? props.items : [];
      const wrap = el('div', 'jr-stack is-column gap-sm');
      for (const t of tabs) {
        if (t.label) wrap.appendChild(el('h4', 'jr-heading', t.label));
        const child = t.elementId ? renderNode(t.elementId, depth + 1, seen) : null;
        if (child) wrap.appendChild(child);
      }
      return wrap;
    }

    if (def.type === 'Metric') {
      const tile = el('div', `jr-metric${props.tone ? ` is-${props.tone}` : ''}`);
      tile.appendChild(el('span', 'jr-metric-lbl', props.label || ''));
      tile.appendChild(el('strong', 'jr-metric-val', props.value || ''));
      if (props.change) tile.appendChild(el('span', 'jr-metric-chg', props.change));
      return tile;
    }

    if (def.type === 'MetricGrid') {
      const grid = el('div', 'jr-metric-grid');
      for (const item of Array.isArray(props.items) ? props.items : []) {
        const tile = el('div', `jr-metric${item.tone ? ` is-${item.tone}` : ''}`);
        tile.appendChild(el('span', 'jr-metric-lbl', item.label || ''));
        tile.appendChild(el('strong', 'jr-metric-val', item.value || ''));
        if (item.change) tile.appendChild(el('span', 'jr-metric-chg', item.change));
        grid.appendChild(tile);
      }
      return grid;
    }

    if (def.type === 'List') {
      const list = el(props.ordered ? 'ol' : 'ul', 'jr-list');
      for (const item of Array.isArray(props.items) ? props.items : []) {
        list.appendChild(el('li', 'jr-list-item', item));
      }
      return list;
    }

    if (def.type === 'Checklist') {
      const list = el('ul', 'jr-checklist');
      for (const item of Array.isArray(props.items) ? props.items : []) {
        const li = el('li', `jr-check-item${item.checked ? ' is-done' : ''}`);
        li.appendChild(el('span', 'jr-check-mark', item.checked ? '✓' : '○'));
        li.appendChild(el('span', 'jr-check-lbl', item.label || ''));
        list.appendChild(li);
      }
      return list;
    }

    if (def.type === 'Table') {
      const wrap = el('div', 'jr-table-wrap');
      const table = document.createElement('table');
      table.className = 'jr-table';
      const cols = Array.isArray(props.columns) ? props.columns : [];
      if (cols.length > 0) {
        const thead = document.createElement('thead');
        const tr = document.createElement('tr');
        for (const c of cols) tr.appendChild(el('th', '', c));
        thead.appendChild(tr);
        table.appendChild(thead);
      }
      const tbody = document.createElement('tbody');
      for (const row of Array.isArray(props.rows) ? props.rows : []) {
        const tr = document.createElement('tr');
        for (const cell of Array.isArray(row) ? row : []) {
          tr.appendChild(el('td', '', cell));
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }

    if (def.type === 'FactList') {
      const wrap = el('div', 'jr-facts');
      for (const item of Array.isArray(props.items) ? props.items : []) {
        const row = el('div', 'apf-row');
        row.appendChild(el('span', 'apf-lbl', item.label));
        row.appendChild(item.code ? el('code', 'inline-code', item.value) : el('span', 'jr-fact-val', item.value));
        wrap.appendChild(row);
      }
      return wrap;
    }

    if (def.type === 'Image') {
      const rawUrl = String(props.url || '').trim();
      let safeSrc = '';
      if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(rawUrl) && rawUrl.length <= 512_000) {
        safeSrc = rawUrl;
      } else {
        try {
          const parsed = new URL(rawUrl);
          if (!parsed.username && !parsed.password && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')))) {
            safeSrc = parsed.href;
          }
        } catch {
          safeSrc = '';
        }
      }
      if (!safeSrc) return null;
      const fig = el('figure', 'jr-figure');
      const img = document.createElement('img');
      img.className = 'jr-image';
      img.src = safeSrc;
      img.alt = String(props.alt || props.caption || 'Visual');
      img.loading = 'lazy';
      fig.appendChild(img);
      if (props.caption) fig.appendChild(el('figcaption', 'jr-text is-muted', props.caption));
      return fig;
    }

    if (def.type === 'CodeBlock') {
      if (props.collapsible) {
        const det = el('details', 'jr-details');
        det.appendChild(el('summary', '', props.label || 'Details'));
        det.appendChild(el('pre', 'jr-code', props.code || ''));
        return det;
      }
      const box = el('div', 'jr-code-wrap');
      if (props.label) box.appendChild(el('div', 'apf-lbl', props.label));
      box.appendChild(el('pre', 'jr-code', props.code || ''));
      return box;
    }

    if (def.type === 'Divider') {
      return el('hr', 'jr-divider');
    }

    if (readOnly) return null;

    if (def.type === 'Select') {
      const field = el('label', 'jr-field');
      field.appendChild(el('span', 'jr-field-lbl', props.label || props.name));
      const sel = document.createElement('select');
      sel.className = 'jr-select';
      sel.name = props.name;
      const curVal = values[props.name] ?? props.defaultValue ?? '';
      for (const opt of Array.isArray(props.options) ? props.options : []) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === curVal) o.selected = true;
        sel.appendChild(o);
      }
      values[props.name] = sel.value;
      sel.addEventListener('change', () => { values[props.name] = sel.value; });
      formControls.set(props.name, () => sel.value);
      field.appendChild(sel);
      if (props.hint) field.appendChild(el('span', 'jr-hint', props.hint));
      return field;
    }

    if (def.type === 'ChoiceGroup') {
      const group = el('fieldset', 'jr-fieldset');
      group.appendChild(el('legend', 'jr-field-lbl', props.label || props.name));
      const inputs = [];
      const cur = values[props.name] ?? props.defaultValue;
      const curSet = new Set(Array.isArray(cur) ? cur : (cur ? [cur] : []));
      for (const opt of Array.isArray(props.options) ? props.options : []) {
        const row = el('label', 'jr-choice');
        const input = document.createElement('input');
        input.type = props.multiple ? 'checkbox' : 'radio';
        input.name = props.name;
        input.value = opt.value;
        input.checked = curSet.has(opt.value);
        inputs.push(input);
        row.appendChild(input);
        const txt = el('span', 'jr-choice-txt', opt.label);
        row.appendChild(txt);
        group.appendChild(row);
      }
      const readGroup = () => props.multiple
        ? inputs.filter((i) => i.checked).map((i) => i.value)
        : (inputs.find((i) => i.checked)?.value ?? '');
      formControls.set(props.name, readGroup);
      if (props.hint) group.appendChild(el('span', 'jr-hint', props.hint));
      return group;
    }

    if (def.type === 'Toggle') {
      const wrap = el('label', 'jr-toggle');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = props.name;
      cb.checked = Boolean(values[props.name] ?? props.defaultValue ?? false);
      values[props.name] = cb.checked;
      cb.addEventListener('change', () => { values[props.name] = cb.checked; });
      formControls.set(props.name, () => cb.checked);
      wrap.appendChild(cb);
      const copy = el('span', 'jr-toggle-copy');
      copy.appendChild(el('span', 'jr-toggle-lbl', props.label || props.name));
      if (props.hint) copy.appendChild(el('span', 'jr-hint', props.hint));
      wrap.appendChild(copy);
      return wrap;
    }

    if (def.type === 'TextInput') {
      const field = el('label', 'jr-field');
      field.appendChild(el('span', 'jr-field-lbl', props.label || props.name));
      const ctrl = props.kind === 'long_text' ? document.createElement('textarea') : document.createElement('input');
      ctrl.className = 'jr-input';
      ctrl.name = props.name;
      if (props.kind === 'long_text') {
        ctrl.rows = 3;
      } else {
        ctrl.type = props.kind === 'password' ? 'password' : props.kind === 'email' ? 'email' : props.kind === 'number' ? 'number' : 'text';
      }
      if (props.placeholder) ctrl.placeholder = props.placeholder;
      if (values[props.name] !== undefined || props.defaultValue !== undefined) {
        ctrl.value = String(values[props.name] ?? props.defaultValue ?? '');
      }
      formControls.set(props.name, () => ctrl.value);
      field.appendChild(ctrl);
      if (props.hint) field.appendChild(el('span', 'jr-hint', props.hint));
      return field;
    }

    if (def.type === 'ActionGroup') {
      const wrap = el('div', `jr-actions ${props.layout === 'grid' ? 'apf-choices' : 'jr-actions-stack'}`);
      renderChildren(wrap);
      return wrap;
    }

    if (def.type === 'Button') {
      const toneClass = props.tone === 'primary'
        ? 'btn fill'
        : props.tone === 'danger'
          ? 'btn danger-outline'
          : 'btn';
      const btn = el('button', `${toneClass} jr-btn`, props.label || 'Continue');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        onAction?.({
          action: props.action || (props.decision ? 'decide' : 'submit'),
          optionId: props.optionId || props.decision || key,
          decision: props.decision || null,
          alwaysAllow: props.alwaysAllow || null,
          values: readValues(),
        });
      });
      return btn;
    }

    return null;
  };

  rootEl = renderNode(spec?.root) || el('div', 'apf-card', 'Nothing to show.');

  return {
    element: rootEl,
    getValues: readValues,
    setBusy: (busy) => {
      rootEl.querySelectorAll('button, input, select, textarea').forEach((n) => { n.disabled = Boolean(busy); });
    },
    showError: (msg) => {
      if (!errorEl) return;
      errorEl.textContent = msg || '';
      errorEl.hidden = !msg;
    },
  };
}
