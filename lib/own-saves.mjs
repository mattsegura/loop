// What a caller saved a moment ago and may take back without asking the owner.
//
// A delete needs the owner because it destroys something that was there. Taking back your own fresh
// save destroys nothing that was there before you: it is the undo of a save that needed no approval
// either. That stops being true once anyone else changes the item. After an hour, or when Loop
// restarts (this list is in memory only), the owner's delete policy applies as to any other item.
//
// Loop itself also changes a record after a save: it reads the page of a saved link, and it writes
// the run times of a schedule. That is not a change by anyone else, so those fields are not part of
// the comparison (LOOP_FIELDS). Each other field must be as the caller left it.

import { createHash } from 'node:crypto';

export const TAKE_BACK_MS = 60 * 60 * 1000;
const MAX_ITEMS = 2000;

// Page data is Loop's only for an item that has a link. The text of a note is what its writer wrote.
const PAGE_FIELDS = ['fetchedTitle', 'summary', 'markdown', 'author', 'image', 'domain', 'fetchStatus', 'fetchError'];
const LOOP_FIELDS = Object.freeze({
  saved: (record) => ['displayTitle', 'updatedAt', ...(record.url ? PAGE_FIELDS : [])],
  schedule: () => ['nextRunAt', 'nextRunLocal', 'lastRunAt', 'lastStatus', 'lastError', 'lastTaskId', 'runCount', 'updatedAt'],
  file: () => ['updatedAt'],
});

function stampOf(kind, record) {
  const skip = Object.hasOwn(LOOP_FIELDS, kind) ? new Set(LOOP_FIELDS[kind](record)) : null;
  const compared = skip ? Object.fromEntries(Object.entries(record).filter(([field]) => !skip.has(field))) : record;
  return createHash('sha256').update(JSON.stringify(compared)).digest('base64');
}

export class OwnSaves {
  constructor({ windowMs = TAKE_BACK_MS, max = MAX_ITEMS, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.items = new Map();
  }

  // `caller` is null when Loop cannot tell callers apart; such a caller never owns anything.
  #key(caller, kind, id) {
    return JSON.stringify([caller, kind, id]);
  }

  // Call after every save. `previous` is the record the save replaced. `undoable: false` marks a
  // save whose removal would not bring back the earlier state.
  saved(caller, kind, record, { created, previous = null, undoable = true }) {
    if (!caller || !record?.id) return;
    const key = this.#key(caller, kind, record.id);
    const own = undoable && (created || this.canTakeBack(caller, kind, previous));
    this.items.delete(key);
    if (!own) return;
    this.items.set(key, { stamp: stampOf(kind, record), at: this.now() });
    if (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
  }

  // `record` is the item as it is stored now.
  canTakeBack(caller, kind, record) {
    if (!caller || !record?.id) return false;
    const entry = this.items.get(this.#key(caller, kind, record.id));
    return Boolean(entry) && this.now() - entry.at <= this.windowMs && entry.stamp === stampOf(kind, record);
  }

  removed(caller, kind, id) {
    this.items.delete(this.#key(caller, kind, id));
  }
}
