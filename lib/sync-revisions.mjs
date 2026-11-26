// Compare fixed-width revisions without relying on a device's wall clock.
// Deletion starts an odd generation; only a deliberate recreation advances to the next even one.
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const FORMAT = /^([0-9a-f]{8}):([0-9a-f]{12}):[0-9a-f]{24}$/;

export function validateRevision(revision, deleted) {
  const match = typeof revision === 'string' && FORMAT.exec(revision);
  if (!match || Boolean(parseInt(match[1], 16) % 2) !== deleted) {
    throw Object.assign(new Error('Invalid Loop Connect record revision.'), { status: 400 });
  }
}

function legacyRevision(record) {
  const time = Math.max(0, Date.parse(record.updatedAt) || 0).toString(16).padStart(12, '0').slice(-12);
  // Vault callers pass the encrypted record here, never the cleartext value.
  const tie = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 12);
  return '00000000:000000000000:' + time + tie;
}

export function currentRevision(versions, id, record) {
  if (Object.hasOwn(versions, id)) {
    const revision = versions[id];
    validateRevision(revision, !record);
    return revision;
  }
  return record ? legacyRevision(record) : '';
}

export function updatedRevisions(before, after, versions, accepted = new Map()) {
  const next = Object.assign(Object.create(null), versions);
  for (const id of new Set([...before.keys(), ...after.keys(), ...accepted.keys()])) {
    if (accepted.has(id)) {
      next[id] = accepted.get(id);
      continue;
    }
    const old = before.get(id);
    const record = after.get(id);
    if (isDeepStrictEqual(old, record)) continue;
    const previous = currentRevision(versions, id, old);
    let [generation, counter] = previous ? previous.split(':').map((n) => parseInt(n, 16)) : [0, 0];
    if (previous && Boolean(old) !== Boolean(record)) {
      generation++;
      counter = 0;
    }
    const stamp = generation.toString(16).padStart(8, '0') + ':' + (++counter).toString(16).padStart(12, '0')
      + ':' + randomBytes(12).toString('hex');
    validateRevision(stamp, !record);
    next[id] = stamp;
  }
  return next;
}
