// Accessible native <dialog> replacements for window.confirm() and window.prompt().
import { esc } from '../core/utils.js';

export function confirmDialog({
  title = 'Confirm action',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'loop-dialog cmd-confirm-dlg';
    dlg.setAttribute('data-modal', 'keep');
    dlg.setAttribute('aria-labelledby', 'loop-confirm-title');
    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="loop-confirm-title">${esc(title)}</h3>
      </div>
      ${message ? `<p class="sub">${esc(message)}</p>` : ''}
      <div class="acts acts-end">
        <button type="button" class="btn sm ghost" data-confirm-no>${esc(cancelLabel)}</button>
        <button type="button" class="btn sm ${danger ? 'danger' : 'fill'}" data-confirm-yes>${esc(confirmLabel)}</button>
      </div>
    `;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(val);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    dlg.querySelector('[data-confirm-no]')?.addEventListener('click', () => finish(false));
    dlg.querySelector('[data-confirm-yes]')?.addEventListener('click', () => finish(true));
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector(danger ? '[data-confirm-no]' : '[data-confirm-yes]')?.focus();
  });
}

export function promptDialog({
  title = 'Enter value',
  message = '',
  label = 'Value',
  placeholder = '',
  defaultValue = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
} = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'loop-dialog cmd-confirm-dlg';
    dlg.setAttribute('data-modal', 'keep');
    dlg.setAttribute('aria-labelledby', 'loop-prompt-title');
    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="loop-prompt-title">${esc(title)}</h3>
      </div>
      ${message ? `<p class="sub">${esc(message)}</p>` : ''}
      <form class="form-grid" data-prompt-form>
        <label class="field">
          <span class="lbl">${esc(label)}</span>
          <input type="text" name="value" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" autocomplete="off" required>
        </label>
        <div class="acts acts-end">
          <button type="button" class="btn sm ghost" data-prompt-no>${esc(cancelLabel)}</button>
          <button type="submit" class="btn sm fill">${esc(confirmLabel)}</button>
        </div>
      </form>
    `;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(val);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dlg.querySelector('[data-prompt-no]')?.addEventListener('click', () => finish(null));
    dlg.querySelector('[data-prompt-form]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = dlg.querySelector('input[name="value"]');
      finish(input ? input.value : '');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    const inp = dlg.querySelector('input[name="value"]');
    if (inp) {
      inp.focus();
      inp.select();
    }
  });
}
