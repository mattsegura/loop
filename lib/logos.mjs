// Connection logos: found once on the Loop server, cached in the workspace's data directory and
// served from Loop itself, so the browser never asks a third party (and never leaks the list of
// connections to a favicon service).
//
// Where a logo comes from, first match wins:
//   1. a logo the owner set ("Change logo")
//   2. the icon the connection itself declares when it connects (MCP serverInfo.icons)
//   3. the icon of the connection's website (serverInfo.websiteUrl, then the domain it runs on)
//   4. the icon of a known brand named in the connection's name or package
// Nothing found: the dashboard draws a letter tile instead.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSafeFetch, parsePublicHttpsUrl } from './outbound-policy.mjs';

export const MAX_LOGO_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const RETRY_FAILED_MS = 3 * 24 * 60 * 60 * 1000;
const INDEX_FILE = 'logos.json';
// Bump when the search itself gets better (new brands, new sources) so earlier misses are retried.
const RESOLVER_VERSION = 3;

const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
]);
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };

// Hosts that front many unrelated connections: their icon says nothing about the connection.
const SHARED_HOSTS = /(^|\.)(github\.io|githubusercontent\.com|vercel\.app|netlify\.app|herokuapp\.com|workers\.dev|pages\.dev|fly\.dev|onrender\.com|railway\.app|ngrok(-free)?\.(app|io|dev)|trycloudflare\.com|smithery\.ai|composio\.dev|glama\.ai|pipedream\.net|zapier\.app|run\.app|amazonaws\.com|azurewebsites\.net|cloudfunctions\.net|deno\.dev|replit\.app)$/;
const STRIP_LABELS = new Set(['mcp', 'api', 'www', 'app', 'remote', 'server', 'connect', 'gateway', 'sse', 'ws', 'mcp-server']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

// Brands Loop recognises in a connection's name, package or command, and the site whose icon it uses.
// Only names that cannot mean anything else; a wrong logo is worse than a letter tile.
const KNOWN_BRANDS = [
  ['supabase', 'supabase.com'],
  ['shopify', 'shopify.com'],
  ['github', 'github.com'],
  ['gitlab', 'gitlab.com'],
  ['slack', 'slack.com'],
  ['notion', 'notion.so'],
  ['linear', 'linear.app'],
  ['figma', 'figma.com'],
  ['stripe', 'stripe.com'],
  ['sentry', 'sentry.io'],
  ['vercel', 'vercel.com'],
  ['cloudflare', 'cloudflare.com'],
  ['netlify', 'netlify.com'],
  ['brightdata', 'brightdata.com'],
  ['bright-data', 'brightdata.com'],
  ['playwright', 'playwright.dev'],
  ['puppeteer', 'pptr.dev'],
  ['postgres', 'postgresql.org'],
  ['mongodb', 'mongodb.com'],
  ['redis', 'redis.io'],
  ['docker', 'docker.com'],
  ['kubernetes', 'kubernetes.io'],
  ['langflow', 'langflow.org'],
  ['langsmith', 'langchain.com'],
  ['langchain', 'langchain.com'],
  ['aws', 'aws.amazon.com'],
  ['okx', 'okx.com'],
  ['mobbin', 'mobbin.com'],
  ['higgsfield', 'higgsfield.ai'],
  ['meta-ads', 'facebook.com'],
  ['hubspot', 'hubspot.com'],
  ['salesforce', 'salesforce.com'],
  ['airtable', 'airtable.com'],
  ['asana', 'asana.com'],
  ['atlassian', 'atlassian.com'],
  ['jira', 'atlassian.com'],
  ['confluence', 'atlassian.com'],
  ['dropbox', 'dropbox.com'],
  ['zapier', 'zapier.com'],
  ['twilio', 'twilio.com'],
  ['intercom', 'intercom.com'],
  ['perplexity', 'perplexity.ai'],
  ['firecrawl', 'firecrawl.dev'],
  ['exa', 'exa.ai'],
  ['tavily', 'tavily.com'],
  ['browserbase', 'browserbase.com'],
  ['posthog', 'posthog.com'],
  ['canva', 'canva.com'],
  ['paypal', 'paypal.com'],
  ['square', 'squareup.com'],
  ['discord', 'discord.com'],
  ['telegram', 'telegram.org'],
  ['spotify', 'spotify.com'],
  ['youtube', 'youtube.com'],
  ['reddit', 'reddit.com'],
  ['obsidian', 'obsidian.md'],
  ['todoist', 'todoist.com'],
  ['clickup', 'clickup.com'],
  ['monday', 'monday.com'],
  ['neon', 'neon.tech'],
  ['prisma', 'prisma.io'],
  ['pinecone', 'pinecone.io'],
  ['elevenlabs', 'elevenlabs.io'],
  ['replicate', 'replicate.com'],
  ['huggingface', 'huggingface.co'],
  ['arizeai', 'arize.com'],
];

function hashOf(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// The site a host belongs to: mcp.supabase.com -> supabase.com, api.foo.co.uk -> foo.co.uk.
export function brandDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const keep = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function hostCandidates(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host || SHARED_HOSTS.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return [];
  const labels = host.split('.');
  while (labels.length > 2 && STRIP_LABELS.has(labels[0])) labels.shift();
  const stripped = labels.join('.');
  const base = brandDomain(host);
  return [...new Set([stripped, base].filter(Boolean))];
}

function brandFromText(text) {
  const t = String(text || '').toLowerCase();
  for (const [needle, domain] of KNOWN_BRANDS) {
    const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[-]/g, '[-_ ]?')}([^a-z0-9]|$)`);
    if (re.test(t)) return domain;
  }
  return null;
}

// What a connection tells us about where its logo could be. Changes to any of it re-run the search.
export function logoSignature(conn) {
  return hashOf(Buffer.from(JSON.stringify([
    RESOLVER_VERSION,
    conn?.name || '',
    conn?.url || '',
    conn?.command || '',
    Array.isArray(conn?.args) ? conn.args : [],
    Array.isArray(conn?.serverIcons) ? conn.serverIcons.map((i) => i.src) : [],
    conn?.websiteUrl || '',
  ])));
}

// The places to look, in order. Each is { kind: 'icon', src } or { kind: 'site', domain | url }.
export function logoCandidates(conn) {
  const out = [];
  const icons = Array.isArray(conn?.serverIcons) ? conn.serverIcons : [];
  const score = (icon) => {
    const type = String(icon.mimeType || '').toLowerCase();
    const sizes = Array.isArray(icon.sizes) ? icon.sizes : [];
    const biggest = Math.max(0, ...sizes.map((s) => (s === 'any' ? 512 : Number(String(s).split('x')[0]) || 0)));
    return (icon.theme === 'dark' ? -1000 : 0) + (type.includes('svg') ? 600 : 0) + Math.min(biggest, 512);
  };
  for (const icon of [...icons].sort((a, b) => score(b) - score(a))) {
    out.push({ kind: 'icon', src: icon.src });
  }
  if (conn?.websiteUrl) out.push({ kind: 'site', url: conn.websiteUrl });
  if (conn?.transport !== 'stdio' && conn?.url) {
    for (const domain of hostCandidates(conn.url)) out.push({ kind: 'site', domain });
  }
  // The address's path can name a brand (…/@supabase/mcp); its host is handled above, and a shared host
  // such as vercel.app must not turn into that host's own logo.
  let urlPath = '';
  try { urlPath = conn?.url ? new URL(conn.url).pathname : ''; } catch { /* not an address */ }
  const known = brandFromText([conn?.name, conn?.command, ...(Array.isArray(conn?.args) ? conn.args : []), urlPath].join(' '));
  if (known) out.push({ kind: 'site', domain: known });
  const seen = new Set();
  return out.filter((c) => {
    const key = c.src || c.url || c.domain;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Checks the bytes really are an image of an allowed type, whatever the server said.
export function sniffImage(buf, declared = '') {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > MAX_LOGO_BYTES) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon';
  const head = b.slice(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if ((head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg')) {
    return 'image/svg+xml';
  }
  void declared;
  return null;
}

function decodeDataUri(src) {
  const m = /^data:([a-z0-9.+/-]+)?(;base64)?,(.*)$/is.exec(String(src || ''));
  if (!m) return null;
  try {
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return buf.length > MAX_LOGO_BYTES ? null : buf;
  } catch {
    return null;
  }
}

// Picks the best icon a page links to: a big touch icon, then SVG, then the largest PNG.
export function iconLinksFromHtml(html, baseUrl) {
  const head = String(html || '').slice(0, MAX_PAGE_BYTES);
  const links = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
    };
    const rel = attr('rel').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('apple-touch-icon-precomposed')) continue;
    const href = attr('href').trim();
    if (!href || href.startsWith('data:')) continue;
    let url;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), baseUrl).href;
    } catch {
      continue;
    }
    const type = attr('type').toLowerCase();
    const size = Math.max(0, ...attr('sizes').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    const touch = rel.some((r) => r.startsWith('apple-touch-icon'));
    const svg = type.includes('svg') || /\.svg(\?|$)/i.test(url);
    const rank = (touch ? 400 : 0) + (svg ? 300 : 0) + Math.min(size || (touch ? 180 : 16), 256);
    links.push({ url, rank });
  }
  return links.sort((a, b) => b.rank - a.rank).map((l) => l.url);
}

// Reads a response body up to `limit` bytes. Past the limit: the start of it when `partial`
// (and stops early once the page's head has ended), otherwise nothing.
async function readUpTo(res, limit, { partial = false } = {}) {
  const declared = Number(res.headers.get('content-length'));
  if (!partial && Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size > limit) {
        if (!partial) return null;
        break;
      }
      if (partial && /<\/head\s*>/i.test(Buffer.from(value).toString('latin1'))) break;
    }
  } catch (err) {
    if (!partial || !size) throw err;
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks);
  return partial ? buf.subarray(0, limit) : buf;
}

// ---- Mac app icons, for Local connections that come with (or are named after) an installed app ----

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const MAX_ICNS_BYTES = 8 * 1024 * 1024;

function bundleOf(file) {
  const m = /^(.*?\.app)(\/|$)/i.exec(String(file || ''));
  return m ? m[1] : null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// The app bundles a Local connection belongs to: the .app its command lives in (after following
// links), then an app in /Applications whose name is the connection's name or command name.
export async function appBundlesFor(conn, { appDirs = [path.join(path.sep, 'Applications'), path.join(os.homedir(), 'Applications')] } = {}) {
  const out = [];
  const seen = new Set();
  const add = async (bundle) => {
    if (!bundle) return;
    const key = await realpath(bundle).catch(() => bundle);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(bundle);
  };
  const command = typeof conn?.command === 'string' ? conn.command : '';
  if (path.isAbsolute(command)) {
    await add(bundleOf(command) || bundleOf(await realpath(command).catch(() => '')));
  }
  const names = new Set([conn?.name, command && path.basename(command)].map(squash).filter((n) => n.length >= 3));
  for (const dir of appDirs) {
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries.sort()) {
      if (entry.toLowerCase().endsWith('.app') && names.has(squash(entry.slice(0, -4)))) await add(path.join(dir, entry));
    }
  }
  return out;
}

// The best PNG stored inside an .icns file, about 128-256 px when there is one.
export function pngFromIcns(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') return null;
  const total = Math.min(buf.readUInt32BE(4), buf.length);
  const found = new Map();
  for (let off = 8; off + 8 <= total;) {
    const type = buf.toString('latin1', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > total) break;
    const data = buf.subarray(off + 8, off + len);
    if (!found.has(type) && sniffImage(data) === 'image/png') found.set(type, data);
    off += len;
  }
  for (const type of ['ic07', 'ic13', 'ic08', 'ic12', 'ic09', 'ic14', 'ic10', 'ic11']) {
    if (found.has(type)) return Buffer.from(found.get(type));
  }
  return null;
}

async function iconFilesOf(bundle) {
  const resources = path.join(bundle, 'Contents', 'Resources');
  const files = [];
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const plist = await readFile(plistPath).catch(() => null);
  let named = null;
  if (plist && plist.subarray(0, 6).toString('latin1') === 'bplist') {
    if (process.platform === 'darwin') named = await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plistPath]);
  } else if (plist) {
    named = /<key>\s*CFBundleIconFile\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(plist.toString('utf8'))?.[1]?.trim() || null;
  }
  if (named && !named.includes('/') && !named.includes('..')) files.push(named.toLowerCase().endsWith('.icns') ? named : `${named}.icns`);
  const listed = (await readdir(resources).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.icns'));
  const rank = (f) => (/^(appicon|app|icon|electron)\.icns$/i.test(f) ? 0 : 1);
  for (const f of listed.sort((a, b) => rank(a) - rank(b))) if (!files.includes(f)) files.push(f);
  return files.slice(0, 4).map((f) => path.join(resources, f));
}

// An app bundle's icon as a PNG. Older icon formats are converted with macOS's own sips.
export async function appIcon(bundle) {
  for (const file of await iconFilesOf(bundle)) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > MAX_ICNS_BYTES) continue;
    const png = pngFromIcns(await readFile(file).catch(() => null));
    if (png) return png;
    if (process.platform !== 'darwin') continue;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-icon-'));
    try {
      const out = path.join(tmp, 'icon.png');
      if ((await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '128', file, '--out', out])) === null) continue;
      const buf = await readFile(out).catch(() => null);
      if (buf && sniffImage(buf) === 'image/png') return buf;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  return null;
}

export class LogoStore {
  // allowNetwork: false keeps Loop from looking anywhere: a hosted personal workspace may only reach the
  // addresses it was approved for, so it uses icons sent inline, uploads and letter tiles.
  // allowLocalApps: look at installed Mac apps for Local connections (only on the owner's own computer).
  constructor(dataDir, { fetchImpl = null, now = () => Date.now(), allowNetwork = true, allowLocalApps = process.platform === 'darwin', appDirs } = {}) {
    this.allowNetwork = allowNetwork;
    this.allowLocalApps = allowLocalApps;
    this.appDirs = appDirs;
    this.dir = path.join(dataDir, 'logos');
    this.indexPath = path.join(this.dir, INDEX_FILE);
    this.now = now;
    // Only public HTTPS addresses, never redirects followed blindly, never more than the cap.
    // The fetcher's own cap only guards against endless bodies; Loop reads just what it needs (see _read).
    this.fetch = fetchImpl || createSafeFetch({ requirePublic: true, returnRedirect: true, maxResponseBytes: 8 * 1024 * 1024 });
    this.index = null;
    this.inFlight = new Map();
    this.writing = Promise.resolve();
  }

  async _load() {
    if (this.index) return this.index;
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
      this.index = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      this.index = {};
    }
    return this.index;
  }

  async _save() {
    const run = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.index, null, 2));
      await rename(tmp, this.indexPath);
    });
    this.writing = run.catch(() => {});
    return run;
  }

  _file(entry) {
    return path.join(this.dir, `${entry.hash}.${entry.ext}`);
  }

  // What the dashboard needs: a versioned address for the logo, or null.
  async publicInfo(connId) {
    const entry = (await this._load())[connId];
    if (!entry?.hash) return null;
    return { url: `/api/mcps/${encodeURIComponent(connId)}/logo?v=${entry.hash}`, custom: Boolean(entry.custom), source: entry.source || null };
  }

  // Every connection's logo address at once, for list responses.
  async publicMap() {
    const out = {};
    for (const [id, entry] of Object.entries(await this._load())) {
      if (entry?.hash) out[id] = `/api/mcps/${encodeURIComponent(id)}/logo?v=${entry.hash}`;
    }
    return out;
  }

  async read(connId) {
    const entry = (await this._load())[connId];
    if (!entry?.hash) return null;
    try {
      return { buf: await readFile(this._file(entry)), mime: EXT_TYPES[entry.ext] || 'application/octet-stream', hash: entry.hash };
    } catch {
      return null;
    }
  }

  async _store(connId, buf, { source, custom = false, signature = null }) {
    const mime = sniffImage(buf);
    if (!mime) throw new Error('That file is not a PNG, JPEG, GIF, WebP, SVG or ICO image under 256 KB.');
    const ext = IMAGE_TYPES.get(mime);
    const hash = hashOf(buf);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${hash}.${ext}`), buf);
    const index = await this._load();
    const previous = index[connId];
    index[connId] = { hash, ext, source, custom, signature, fetchedAt: new Date(this.now()).toISOString() };
    await this._save();
    if (previous?.hash && previous.hash !== hash) await this._dropFileIfUnused(previous);
    return index[connId];
  }

  async _dropFileIfUnused(entry) {
    const index = await this._load();
    if (Object.values(index).some((e) => e?.hash === entry.hash)) return;
    await rm(this._file(entry), { force: true }).catch(() => {});
  }

  // The owner's own logo: bytes they uploaded, or an image address they pasted.
  async setCustom(connId, { image = null, url = null } = {}) {
    let buf = null;
    if (typeof image === 'string' && image.startsWith('data:')) {
      buf = decodeDataUri(image);
    } else if (typeof url === 'string' && url.trim()) {
      buf = await this._fetchImage(url.trim());
    }
    if (!buf) throw Object.assign(new Error('Choose an image file or paste an image address that starts with https://.'), { status: 400 });
    return this._store(connId, buf, { source: 'custom', custom: true });
  }

  async clearCustom(connId) {
    const index = await this._load();
    const entry = index[connId];
    if (!entry) return;
    delete index[connId];
    await this._save();
    await this._dropFileIfUnused(entry);
  }

  async remove(connId) {
    return this.clearCustom(connId);
  }

  // True when this connection should be searched again: never tried, changed since, or a miss long ago.
  async needsResolve(conn) {
    const entry = (await this._load())[conn.id];
    if (!entry) return true;
    if (entry.custom) return false;
    if (entry.signature !== logoSignature(conn)) return true;
    if (!entry.hash && entry.failedAt && this.now() - Date.parse(entry.failedAt) > RETRY_FAILED_MS) return true;
    return false;
  }

  // Finds and saves a logo for one connection. Returns true when the saved logo changed.
  async resolve(conn, { force = false } = {}) {
    if (!conn?.id) return false;
    if (this.inFlight.has(conn.id)) return this.inFlight.get(conn.id);
    const run = (async () => {
      if (!force && !(await this.needsResolve(conn))) return false;
      const signature = logoSignature(conn);
      const before = (await this._load())[conn.id]?.hash || null;
      const candidates = logoCandidates(conn);
      // A Local connection's own Mac app comes right after any icon the connection sends itself.
      if (this.allowLocalApps && (conn.transport || 'stdio') === 'stdio') {
        const apps = (await appBundlesFor(conn, this.appDirs ? { appDirs: this.appDirs } : {}).catch(() => []))
          .map((bundle) => ({ kind: 'app', bundle }));
        const at = candidates.findIndex((c) => c.kind !== 'icon');
        candidates.splice(at < 0 ? candidates.length : at, 0, ...apps);
      }
      for (const candidate of candidates) {
        try {
          const buf = candidate.kind === 'icon'
            ? (String(candidate.src).startsWith('data:') ? decodeDataUri(candidate.src) : await this._fetchImage(candidate.src))
            : candidate.kind === 'app'
              ? await appIcon(candidate.bundle)
              : await this._siteIcon(candidate.url || `https://${candidate.domain}/`);
          if (buf && sniffImage(buf)) {
            const source = candidate.kind === 'icon' ? 'server' : candidate.kind === 'app' ? `app:${path.basename(candidate.bundle)}` : (candidate.domain || candidate.url);
            const saved = await this._store(conn.id, buf, { source, signature });
            return saved.hash !== before;
          }
        } catch {
          // Try the next place.
        }
      }
      const index = await this._load();
      const stale = index[conn.id];
      index[conn.id] = { hash: null, signature, failedAt: new Date(this.now()).toISOString() };
      await this._save();
      if (stale?.hash) await this._dropFileIfUnused(stale);
      return Boolean(before);
    })().finally(() => this.inFlight.delete(conn.id));
    this.inFlight.set(conn.id, run);
    return run;
  }

  // Resolves every connection that needs it, a few at a time. Calls onChange once if any logo changed.
  async resolveAll(conns, { concurrency = 3, onChange = null } = {}) {
    const queue = [];
    for (const conn of conns) if (await this.needsResolve(conn)) queue.push(conn);
    let changed = false;
    const worker = async () => {
      while (queue.length) {
        const conn = queue.shift();
        if (await this.resolve(conn).catch(() => false)) changed = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (changed) onChange?.();
    return changed;
  }

  // GET with a timeout, following up to three redirects, each one checked again as a public HTTPS address.
  async _get(rawUrl, accept, { limit = MAX_PAGE_BYTES, partial = false } = {}) {
    if (!this.allowNetwork) throw Object.assign(new Error('Logo address: this workspace cannot fetch images from other sites. Upload an image file instead.'), { status: 400 });
    let url = parsePublicHttpsUrl(String(rawUrl).replace(/^http:\/\//i, 'https://'), { label: 'Logo address' }).href;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await this.fetch(url, {
        method: 'GET',
        headers: { accept, 'user-agent': 'Loop/1.0 (connection logo)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next) return null;
        url = parsePublicHttpsUrl(new URL(next, url).href.replace(/^http:\/\//i, 'https://'), { label: 'Logo address' }).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const body = await readUpTo(res, limit, { partial });
      return body ? { url, body, type: String(res.headers.get('content-type') || '').toLowerCase() } : null;
    }
    return null;
  }

  async _fetchImage(rawUrl) {
    const got = await this._get(rawUrl, 'image/svg+xml,image/png,image/webp,image/*;q=0.8', { limit: MAX_LOGO_BYTES });
    return got && got.body.length <= MAX_LOGO_BYTES && sniffImage(got.body) ? got.body : null;
  }

  async _siteIcon(siteUrl) {
    // Icon links live in the page's head: the first part of a big page is enough.
    const page = await this._get(siteUrl, 'text/html,application/xhtml+xml', { partial: true });
    const tried = new Set();
    if (page && page.type.includes('html')) {
      for (const href of iconLinksFromHtml(page.body.toString('utf8'), page.url).slice(0, 4)) {
        tried.add(href);
        const buf = await this._fetchImage(href).catch(() => null);
        if (buf) return buf;
      }
    }
    const fallback = new URL('/favicon.ico', page?.url || siteUrl).href;
    if (tried.has(fallback)) return null;
    return this._fetchImage(fallback).catch(() => null);
  }
}

// Served with the logo: no scripts, no outside requests, even if someone opens an SVG directly.
export const LOGO_RESPONSE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=31536000, immutable',
};
