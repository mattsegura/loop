// A TypeSafe key that the service refused. The calls run in the background, so a wrong or expired
// key would otherwise be sent again for every item and every save, and nobody would notice.

import { createHash } from 'node:crypto';

const REFUSED_FOR_MS = 10 * 60_000;
const refusedUntil = new Map(); // hash of the key -> time

const mark = (apiKey) => createHash('sha256').update(String(apiKey)).digest('base64');

// Whether calls with this key wait. Another key is tried at once.
export function keyRefused(apiKey, now = Date.now()) {
  return (refusedUntil.get(mark(apiKey)) || 0) > now;
}

// Remembers the answer to a call: 401 and 403 are about the key, anything else is not.
export function noteKeyAnswer(apiKey, status, now = Date.now()) {
  if (status !== 401 && status !== 403) return;
  for (const [key, until] of refusedUntil) if (until <= now) refusedUntil.delete(key);
  refusedUntil.set(mark(apiKey), now + REFUSED_FOR_MS);
}
