// The owner's IANA timezone, learned from their text messages. Schedules and the time tools use it
// as the default when a request names no timezone.
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { defaultDataDir } from './vault.mjs';
import { validTz } from './zoned-time.mjs';

export const DEFAULT_TIMEZONE = 'America/Chicago';

export class OwnerTimezone {
  constructor(dir = defaultDataDir()) {
    this.file = path.resolve(dir, 'owner-timezone.json');
    this.legacyFile = path.resolve(dir, 'heartbeat.json'); // where it was kept until 2026-11
    this._lock = createWriteQueue();
  }

  async _stored() {
    const isObject = (d) => d && typeof d === 'object' && !Array.isArray(d);
    for (const file of [this.file, this.legacyFile]) {
      const { data } = await readJsonWithBackup(file, { validate: isObject });
      if (validTz(data?.tz)) return data.tz;
    }
    return null;
  }

  async get() {
    return (await this._stored().catch(() => null)) || DEFAULT_TIMEZONE;
  }

  record(tz) {
    if (!validTz(tz)) return Promise.resolve();
    const clean = tz.trim();
    return this._lock(async () => {
      if ((await this._stored()) === clean) return;
      await atomicWriteFile(this.file, JSON.stringify({ tz: clean }, null, 2), { mode: 0o600, backup: true });
    });
  }
}
