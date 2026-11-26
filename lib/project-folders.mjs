import path from 'node:path';
import os from 'node:os';
import { access, constants, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { atomicWriteFile } from './json-file-store.mjs';
import { normalizeProfileTag } from './profiles.mjs';
import { LoopStore } from './store.mjs';

function validId(id) {
  return typeof id === 'string' && !!id && id !== 'all' && id === normalizeProfileTag(id);
}
function fail(status, message) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}
async function directory(input) {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) return null;
  const p = input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input;
  if (!path.isAbsolute(p)) return null;
  try {
    const canonical = await realpath(p);
    if (/[\x00-\x1f\x7f]/.test(canonical)) return null;
    const s = await stat(canonical, { bigint: true });
    if (!s.isDirectory()) return null;
    await access(canonical, constants.X_OK);
    return { path: canonical, dev: String(s.dev), ino: String(s.ino), birth: String(s.birthtimeNs) };
  } catch { return null; }
}

// Separate from profile/config records: never copied into invites, sync, or agent grants.
export class ProjectFolders {
  constructor(dataDir, store = new LoopStore(dataDir, { seedBuiltins: false })) {
    this.dir = path.join(dataDir, 'local-project-folders');
    this.store = store;
  }
  file(id) {
    if (!validId(id)) throw fail(400, 'Choose a named project.');
    return path.join(this.dir, `${id}.json`);
  }
  // The folder as this computer names it, or null when it is not a folder that Loop can open.
  async check(input) {
    return (await directory(input))?.path || null;
  }
  async attach(id, input) {
    const file = this.file(id);
    const project = await this.store.getProfile(id);
    if (!project?.createdAt) throw fail(404, 'Save the project before attaching a folder.');
    const target = await directory(input);
    if (!target) throw fail(400, 'Enter an existing, accessible folder using an absolute path or ~/path.');
    await atomicWriteFile(file, JSON.stringify({ version: 1, createdAt: project.createdAt, ...target }));
    return this.inspect(id);
  }
  async inspect(id) {
    const file = this.file(id);
    let r;
    try { r = JSON.parse(await readFile(file, 'utf8')); }
    catch (err) { return { status: err.code === 'ENOENT' ? 'none' : 'unavailable' }; }
    const project = await this.store.getProfile(id);
    if (!project?.createdAt || project.createdAt !== r?.createdAt) return { status: 'none' };
    const target = r.version === 1 && await directory(r.path);
    if (!target || ['path','dev','ino','birth'].some(k => target[k] !== r[k])) return { status: 'unavailable' };
    return { status: 'attached', path: target.path };
  }
  async resolve(id) {
    try { return (await this.inspect(id)).path || null; } catch { return null; }
  }
  async matchWorkingDirectory(cwd) {
    const target = await directory(cwd);
    if (!target) return null;
    let files;
    try { files = await readdir(this.dir); } catch { return null; }
    let best = null;
    let tied = false;
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validId(id)) continue;
      const info = await this.inspect(id).catch(() => null);
      if (!info || info.status !== 'attached' || !info.path) continue;
      const prefix = info.path.endsWith(path.sep) ? info.path : `${info.path}${path.sep}`;
      if (target.path !== info.path && !target.path.startsWith(prefix)) continue;
      if (!best || info.path.length > best.path.length) {
        best = { id, path: info.path };
        tied = false;
      } else if (info.path.length === best.path.length && id !== best.id) {
        tied = true;
      }
    }
    return best && !tied ? best.id : null;
  }
  async detach(id) {
    await rm(this.file(id), { force: true });
    return { status: 'none' };
  }
}
