// Loads before the page paints: applies the Look choice (System, Light or Dark).
// Colors in CSS are light-dark() pairs, so color-scheme alone picks the palette.
// data-theme is the choice; data-dark is what shows now (for images and canvas).
(function () {
  var KEY = 'loop.theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function choice() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  }
  function apply(v) {
    var dark = v === 'dark' || (v === 'system' && !!(mq && mq.matches));
    root.dataset.theme = v;
    root.style.colorScheme = v === 'system' ? 'light dark' : v;
    if (dark) root.setAttribute('data-dark', ''); else root.removeAttribute('data-dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1A1614' : '#FDFCFB');
    try { window.dispatchEvent(new CustomEvent('loop-theme', { detail: { theme: v, dark: dark } })); } catch (e) {}
  }
  // A later change: every part changes at once, with no color fades.
  function change(v) {
    root.setAttribute('data-theme-switch', '');
    apply(v);
    if (document.body) void document.body.offsetHeight; // the new colors land now, with fades off
    setTimeout(function () { root.removeAttribute('data-theme-switch'); }, 50);
  }
  apply(choice());
  if (mq) {
    var onChange = function () { if (choice() === 'system') change('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  // Another tab changed the choice.
  window.addEventListener('storage', function (e) { if (e.key === KEY) change(choice()); });
  window.loopTheme = {
    get: choice,
    set: function (v) {
      v = v === 'light' || v === 'dark' ? v : 'system';
      try { if (v === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) {}
      change(v);
    },
  };
})();
