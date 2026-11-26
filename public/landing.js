// Each tab list controls its own panels.
for (const list of document.querySelectorAll('[role="tablist"]')) {
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  function select(active) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const indexForKey = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      const next = tabs[indexForKey[event.key]];
      if (!next) return;
      event.preventDefault();
      select(next);
      next.focus();
    });
  });
}

document.querySelectorAll('.copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = btn.parentElement.querySelector('pre')?.textContent || '';
    try {
      await navigator.clipboard.writeText(text.trim());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select and copy';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
});
