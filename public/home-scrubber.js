// Narrow windows and phones: the section scrubber. At rest it is a short stack of marks halfway down the left
// gutter, one for each section, with the section in view drawn longest. Press it and the section
// names open over the page, which stays where it is under a soft blur. Slide to the name you want and
// let go, or tap to leave the names open and tap one.
//
// It reads the page's own side menu (.hm-rail, which narrow windows do not show) for the sections and lives
// outside #main, so a repaint of the page in the middle of a drag changes nothing.
//
// On a page of Library the names start with its parts (Memories, Skills, Saved, Files, Schedules, Tasks),
// as the side menu does, so no page needs a line of tabs above it. A part opens when you let go or
// tap: a slide over the names does not load each page that the thumb passes.

import { BRAIN_NAME } from './brain-parts.js';

const ROW = 30; // a name's height, when every name fits
const ROW_MIN = 26;
const EDGE = 48; // the names keep this far from the top and bottom of the screen
const TICK = 14; // from one resting mark to the next
const TICK_MIN = 8;
const TICKS = 240; // the marks together are at most this tall
const LINE = 110; // a section counts as in view once its name is this close to the top

// Where the names go: around the middle of the screen, as the marks are. With more sections than
// fit, the list is as tall as the screen allows and scrolls.
export function scrubLayout({ n, height }) {
  const space = Math.max(0, height - 2 * EDGE);
  const row = Math.max(ROW_MIN, Math.min(ROW, Math.floor(space / Math.max(1, n))));
  const shown = Math.min(n * row, space);
  return { row, shown, start: (height - shown) / 2, scrolls: n * row > space };
}

// The section beside the thumb, or -1 above and below the list. In a list that scrolls, the whole
// height of the list stands for all of it.
export function rowAt(layout, n, y) {
  const i = Math.floor(((y - layout.start) / layout.shown) * n);
  return i >= 0 && i < n ? i : -1;
}

// How far such a list is scrolled to have row i beside the thumb.
export function scrollFor(layout, n, i, y) {
  const want = (i + 0.5) * layout.row - (y - layout.start);
  return Math.max(0, Math.min(n * layout.row - layout.shown, want));
}

// Where the resting marks go: around the middle of the screen, so they stay put from page to page.
// They sit closer together when they would not fit, and past that there are fewer marks than
// sections. A section's place is at(i) either way.
export function tickLayout({ n, top, bottom, middle }) {
  const space = Math.max(0, Math.min(TICKS, bottom - top));
  const count = Math.max(1, Math.min(n, Math.floor(space / TICK_MIN)));
  const step = Math.min(TICK, space / count);
  const start = Math.max(top, Math.min(bottom - count * step, middle - (count * step) / 2));
  const at = (i) => start + (n > 1 && count < n ? (i * (count - 1)) / (n - 1) + 0.5 : i + 0.5) * step;
  return { count, step, start, at };
}

// The section in view. The line it is measured at moves down over the last screen, so the last
// sections, which cannot reach the top, get their turn too.
export function sectionInView(tops, { scroll, max, height }) {
  const span = Math.min(max, height);
  const end = span > 0 ? Math.max(0, Math.min(1, (scroll - (max - span)) / span)) : 0;
  const line = scroll + LINE + end * Math.max(0, height - LINE);
  let at = 0;
  tops.forEach((t, i) => { if (t <= line) at = i; });
  return at;
}

// The page on screen: the part that moves, the side menu's rows, and what choosing one does. A page
// that scrolls has a group in it for each row. Memory is one map, where a row chooses what it shows.
// A row with `go` is a part of Library: it opens another page, so it waits for the thumb to let go.
function pageOf(main) {
  const view = main.querySelector('.view:not(.is-staged)');
  if (!view) return null;
  const shell = view.querySelector('.mem-brain-shell');
  if (shell) {
    if (shell.classList.contains('is-wide')) return null;
    const map = Boolean(shell.querySelector('canvas'));
    // The side menu's own order: Memories, the other parts, then what the map can show. Memories
    // is the row that shows all of them. A list or a notice has only the parts.
    const isPart = (b) => Boolean(b.dataset.brainPart) || b.dataset.memFilter === 'all';
    const rows = [...view.querySelectorAll('.mem-rail .hm-jump')].filter((b) => isPart(b) || (map && !b.classList.contains('is-empty')));
    const review = rows.find((b) => b.dataset.memPanel);
    const reviewing = review?.getAttribute('aria-pressed') === 'true';
    const isOn = (b) => (reviewing ? b === review : b.getAttribute('aria-current') === 'true');
    const firstOwn = rows.findIndex((b) => !isPart(b));
    return {
      key: 'memory',
      box: shell,
      rows: rows.map((b, i) => ({
        id: b.dataset.brainPart ? `part:${b.dataset.brainPart}` : b.dataset.memPanel || `${b.dataset.memFilter}:${b.dataset.memValue}`,
        label: b.querySelector('.mem-jump-l')?.textContent || '',
        warn: false,
        go: Boolean(b.dataset.brainPart),
        sep: i === firstOwn && i > 0,
        el: b,
      })),
      on: () => Math.max(0, rows.findIndex(isOn)),
      choose(b) {
        // Review covers the map.
        if (reviewing && b !== review) view.querySelector('[data-mem-feed-close]')?.click();
        if (b !== review ? b.getAttribute('aria-current') !== 'true' : !reviewing) b.click();
      },
    };
  }
  const box = view.querySelector('.hm .ctl-scroll');
  if (!box) return null;
  // Another part of Library (Skills, Saved, Files, Schedules, Tasks): its side menu is the parts.
  const parts = [...view.querySelectorAll('.hm-rail [data-brain-part]')];
  if (parts.length) {
    return {
      key: 'library',
      box,
      rows: parts.map((b) => ({ id: `part:${b.dataset.brainPart}`, label: b.querySelector('.mem-jump-l')?.textContent || '', warn: false, go: true, sep: false, el: b })),
      on: () => Math.max(0, parts.findIndex((b) => b.getAttribute('aria-current') === 'true')),
      choose(b) {
        if (b.getAttribute('aria-current') !== 'true') b.click();
      },
    };
  }
  if (view.querySelector('.ctl-search')?.value) return null;
  const rows = [...view.querySelectorAll('.hm-rail [data-hm-jump], .hm-rail [data-rail-jump]')].map((b) => {
    const { hmJump, railJump } = b.dataset;
    const group = box.querySelector(hmJump ? `[data-hm-group="${CSS.escape(hmJump)}"]` : `[data-rail-group="${CSS.escape(railJump)}"]`);
    return { id: hmJump || railJump, label: b.querySelector('span')?.textContent || '', warn: b.classList.contains('is-warn'), el: group?.closest('.hm-sec') || group };
  });
  return { key: view.querySelector('.hm')?.getAttribute('aria-label') || '', box, rows: rows.filter((it) => it.el) };
}

export function mountScrubber(main, phone) {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)') || { matches: false };
  const root = document.createElement('div');
  root.className = 'hm-scrub';
  root.hidden = true;
  root.innerHTML = `
    <div class="hm-scrub-scrim"></div>
    <div class="hm-scrub-list" id="hm-scrub-list" role="group" aria-label="Sections"></div>
    <button type="button" class="hm-scrub-grip" aria-label="Choose a section" aria-expanded="false" aria-controls="hm-scrub-list"></button>
    <span class="hm-scrub-ticks" aria-hidden="true"></span>
    <span class="hm-scrub-mark" aria-hidden="true"></span>`;
  // Before the bottom bar, so keyboard order follows the screen.
  main.after(root);
  const list = root.querySelector('.hm-scrub-list');
  const grip = root.querySelector('.hm-scrub-grip');
  const ticks = root.querySelector('.hm-scrub-ticks');
  const mark = root.querySelector('.hm-scrub-mark');

  let page = null;
  let items = []; // [{ id, label, warn, el }]
  let sig = '';
  let cur = 0; // the selected section
  let p = 0; // the same, on its way there
  let isOpen = false;
  let layout = null;
  let drag = null;
  let held = false; // the selected section was picked here, and the page has not been scrolled since
  let moving = null; // the page's scroll position while it goes to the selected section
  let wrote = null; // the last scroll position set here
  let closeTimer = 0;
  let frame = 0;

  const scroller = () => (page?.box.isConnected ? page.box : null);
  const maxScroll = (box) => Math.max(0, box.scrollHeight - box.clientHeight);
  const topOf = (box, i) => (i === 0 ? 0 : items[i].el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop);
  const inView = (box) => (page.on ? page.on() : sectionInView(items.map((_, i) => topOf(box, i)), { scroll: box.scrollTop, max: maxScroll(box), height: box.clientHeight }));

  function bounds(box) {
    const r = box.getBoundingClientRect();
    const nav = document.querySelector('.nav:not([hidden])')?.getBoundingClientRect();
    return { top: r.top + 6, bottom: Math.min(nav?.height ? nav.top : window.innerHeight, window.innerHeight) - 16 };
  }

  // The page was painted again, or another page came up.
  function sync() {
    const was = page;
    page = phone.matches ? pageOf(main) : null;
    if (was?.key !== page?.key) {
      reset();
      sig = '';
      items = [];
    }
    const box = scroller();
    const next = page?.rows || [];
    if (isOpen && box && items.length) {
      // The names stay as they are until they close.
      items = items.map((it) => next.find((n) => n.id === it.id) || it);
      wake();
      return;
    }
    const nextSig = JSON.stringify(next.map(({ el, ...it }) => it));
    if (nextSig !== sig) {
      const id = items[cur]?.id;
      sig = nextSig;
      cur = Math.max(0, next.findIndex((it) => it.id === id));
      p = cur;
      held = held && next[cur]?.id === id;
      list.replaceChildren(...next.map((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `hm-scrub-row${it.warn ? ' is-warn' : ''}${it.sep ? ' is-sep' : ''}`;
        b.tabIndex = -1;
        const name = document.createElement('span');
        name.textContent = it.label;
        b.append(name);
        return b;
      }));
    }
    items = next;
    const show = items.length > 1;
    if (!show) reset();
    root.hidden = !show;
    if (!show) return;
    // What the names are, for a reader that cannot see them.
    const parts = items.some((it) => it.go);
    grip.setAttribute('aria-label', parts ? `Choose a part of ${BRAIN_NAME}` : 'Choose a section');
    list.setAttribute('aria-label', parts ? `Parts of ${BRAIN_NAME}` : 'Sections');
    const b = bounds(box);
    grip.style.top = `${b.top}px`;
    grip.style.height = `${Math.max(0, b.bottom - b.top)}px`;
    if (page.on) cur = inView(box);
    else if (!held) cur = p = inView(box);
    label();
    wake();
  }

  // A repaint can come between a frame and the sync it asks for.
  const fresh = () => { if (items.some((it) => !it.el.isConnected)) sync(); };

  function reset() {
    clearTimeout(closeTimer);
    drag = null;
    isOpen = false;
    moving = null;
    held = false;
    root.classList.remove('is-open');
    grip.setAttribute('aria-expanded', 'false');
  }

  function label() {
    [...list.children].forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === cur));
      b.tabIndex = isOpen && i === cur ? 0 : -1;
    });
  }

  function place() {
    layout = scrubLayout({ n: items.length, height: window.innerHeight });
    list.style.top = `${layout.start}px`;
    list.style.height = `${layout.shown}px`;
    list.style.setProperty('--row', `${layout.row}px`);
    list.classList.toggle('is-scrolling', layout.scrolls);
    list.scrollTop = (cur + 0.5) * layout.row - layout.shown / 2;
  }

  function setOpen(next) {
    clearTimeout(closeTimer);
    const box = scroller();
    if (!box) return;
    if (next && !isOpen) {
      if (!held) cur = p = inView(box);
      place();
    }
    isOpen = next;
    root.classList.toggle('is-open', next);
    grip.setAttribute('aria-expanded', String(next));
    label();
    wake();
    if (!next) queueSync();
  }
  const closeSoon = () => { closeTimer = setTimeout(() => setOpen(false), 140); };

  function pick(i) {
    fresh();
    const box = scroller();
    if (!box || !items[i]?.el.isConnected) return;
    held = true;
    if (i !== cur) {
      cur = i;
      label();
      // A part of Library opens another page: that waits for commit().
      if (!items[i].go) page.choose?.(items[i].el);
    }
    if (!page.choose && moving === null) moving = box.scrollTop;
    wake();
  }

  // Opens the part of Library that the thumb stopped on, or that was tapped.
  function commit() {
    const it = items[cur];
    if (it?.go && it.el.isConnected) page?.choose?.(it.el);
  }

  const ease = (from, to, k, near) => {
    const next = from + (to - from) * (still.matches ? 1 : k);
    return Math.abs(to - next) < near ? to : next;
  };

  function wake() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick() {
    frame = 0;
    fresh();
    const box = scroller();
    if (!box || root.hidden) return;
    p = ease(p, cur, 0.32, 0.004);
    let there = true;
    if (moving !== null) {
      const to = Math.min(topOf(box, cur), maxScroll(box));
      moving = ease(moving, to, 0.17, 0.6);
      box.scrollTop = moving;
      wrote = box.scrollTop;
      there = moving === to;
      if (there && !isOpen) moving = null;
    }
    paint(box);
    if (p !== cur || !there) wake();
  }

  function paint(box) {
    const rest = tickLayout({ n: items.length, ...bounds(box), middle: window.innerHeight / 2 });
    while (ticks.children.length > rest.count) ticks.lastChild.remove();
    while (ticks.children.length < rest.count) ticks.append(document.createElement('i'));
    const at = rest.at(p);
    [...ticks.children].forEach((el, i) => {
      const y = rest.start + (i + 0.5) * rest.step;
      el.classList.toggle('is-warn', rest.count === items.length && items[i].warn);
      // The long mark stands in for the tick it is on.
      el.style.opacity = String(Math.min(1, Math.abs(y - at) / rest.step));
      el.style.transform = `translateY(${y - 1.5}px)`;
    });
    mark.classList.toggle('is-warn', items[cur].warn);
    mark.style.transform = `translate(4px, ${at - 1.5}px)`;
  }

  grip.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    drag = { id: e.pointerId, y: e.clientY, opened: !isOpen, moved: false, entered: false };
    setOpen(true);
    try { grip.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !layout) return;
    if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
    if (!drag.moved) return;
    let i = rowAt(layout, items.length, e.clientY);
    if (i >= 0) drag.entered = true;
    if (!drag.entered) return;
    if (i < 0) i = e.clientY < layout.start ? 0 : items.length - 1;
    if (layout.scrolls) list.scrollTop = scrollFor(layout, items.length, i, e.clientY);
    pick(i);
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      if (d.entered) commit();
      closeSoon();
    } else if (!d.opened) setOpen(false); // a first tap on the edge leaves the names open
  });
  window.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    setOpen(false);
  });

  root.querySelector('.hm-scrub-scrim').addEventListener('click', () => setOpen(false));
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.hm-scrub-row');
    if (!isOpen) return;
    if (!row) {
      setOpen(false);
      return;
    }
    pick([...list.children].indexOf(row));
    commit();
    closeSoon();
    if (!e.detail) grip.focus({ preventScroll: true });
  });
  // Keyboard and assistive tech: a press that did not come from a pointer.
  grip.addEventListener('click', (e) => {
    if (e.detail) return;
    if (isOpen) {
      setOpen(false);
      return;
    }
    setOpen(true);
    list.children[cur]?.focus({ preventScroll: true });
  });
  root.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    const to = { ArrowDown: cur + 1, ArrowUp: cur - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      pick(Math.max(0, Math.min(items.length - 1, to)));
      list.children[cur]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      grip.focus({ preventScroll: true });
    }
  });
  root.addEventListener('focusout', (e) => {
    if (isOpen && !drag && e.relatedTarget && !root.contains(e.relatedTarget)) setOpen(false);
  });

  // The page's own scrolling moves the mark.
  main.addEventListener('scroll', (e) => {
    fresh();
    const box = scroller();
    if (!box || e.target !== box || root.hidden || page.on) return;
    if (moving === null && !isOpen && wrote !== box.scrollTop) {
      held = false;
      cur = inView(box);
      label();
    }
    wake();
  }, { capture: true, passive: true });
  for (const type of ['wheel', 'touchstart']) {
    main.addEventListener(type, () => { if (!isOpen) moving = null; }, { capture: true, passive: true });
  }

  let queued = false;
  const queueSync = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  };
  new MutationObserver(queueSync).observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed'] });
  main.addEventListener('input', queueSync);
  window.addEventListener('resize', () => {
    if (isOpen) place();
    queueSync();
  });
  phone.addEventListener?.('change', () => {
    if (!phone.matches) reset();
    queueSync();
  });
  sync();
}
