// Shared frontend utility helpers (HTML escaping, safe URLs, relative time, clipboard auto-clear).

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function safeHref(raw, { allowRelative = true } = {}) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (allowRelative && s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s, window.location.origin);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {
    // Reject malformed URLs
  }
  return null;
}

export function timeAgo(iso, { compact = false } = {}) {
  const ms = Date.parse(iso || '');
  if (Number.isNaN(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return compact ? `${mins}m ago` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return compact ? `${hours}h ago` : `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return compact ? `${days}d ago` : `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function firstSentence(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cut = flat.match(/^(.+?[.!?])(?:\s|$)/);
  const s = cut ? cut[1] : flat;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
