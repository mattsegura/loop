// An agent's own picture: one small PNG, JPEG or WebP image per agent, in a file beside the config.
// The agent record keeps only a short version, so agent lists and agents' own searches stay small.

import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './json-file-store.mjs';

const MAX_BYTES = 48 * 1024;
const AGENT_ID_RE = /^[a-z0-9_]{1,120}$/;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
// A plain tint with the first letter of the name. No file.
export const PICTURE_TINTS = Object.freeze(['blue', 'green', 'amber']);

function pictureError(message) {
  return Object.assign(new Error(message), { status: 400, publicMessage: message });
}

function looksLike(type, bytes) {
  if (type === 'png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** What an agent record may hold: a tint name, or the version of a saved image. */
export function normalizePicture(raw) {
  if (typeof raw !== 'string') return null;
  return PICTURE_TINTS.includes(raw) || /^[0-9a-f]{12}$/.test(raw) ? raw : null;
}

export class AgentPictureStore {
  constructor(dir) {
    this.dir = path.join(path.resolve(dir), 'agent-pictures');
    this._cache = new Map(); // agent id -> { version, url }
  }

  _file(agentId) {
    if (!AGENT_ID_RE.test(String(agentId || ''))) throw pictureError('Invalid agent id.');
    return path.join(this.dir, agentId);
  }

  /** Saves a picture and returns what the agent record keeps: a tint, a version, or null for none. */
  async save(agentId, picture) {
    const file = this._file(agentId);
    if (picture === null || picture === '') {
      await this.remove(agentId);
      return null;
    }
    if (PICTURE_TINTS.includes(picture)) {
      await this.remove(agentId);
      return picture;
    }
    const match = typeof picture === 'string' && picture.length < MAX_BYTES * 2 ? DATA_URL_RE.exec(picture) : null;
    if (!match) throw pictureError('Use a PNG, JPEG or WebP picture.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 32 || !looksLike(match[1], bytes)) throw pictureError('Use a PNG, JPEG or WebP picture.');
    if (bytes.length > MAX_BYTES) throw pictureError('That picture is too large.');
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const url = `data:image/${match[1]};base64,${bytes.toString('base64')}`;
    await atomicWriteFile(file, url, { mode: 0o600, backup: false });
    this._cache.set(agentId, { version, url });
    return version;
  }

  /** The image of an agent as a data URL, or null when it has none. */
  async url(agent) {
    const version = normalizePicture(agent?.picture);
    if (!version || PICTURE_TINTS.includes(version)) return null;
    const known = this._cache.get(agent.id);
    if (known?.version === version) return known.url;
    const url = await readFile(this._file(agent.id), 'utf8').catch(() => null);
    if (!url || !DATA_URL_RE.test(url)) return null;
    this._cache.set(agent.id, { version, url });
    return url;
  }

  async remove(agentId) {
    this._cache.delete(agentId);
    await unlink(this._file(agentId)).catch(() => {});
  }
}
