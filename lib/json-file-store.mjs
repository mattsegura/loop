// Shared crash-safe atomic file persistence, per-file serialization, and strict config parsing.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOOP_PORT = 8799;

export function createWriteQueue() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const next = tail.then(fn, fn);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}

export function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

// Crash-safe atomic write: unique tmp file -> write + fsync -> chmod -> optional .bak of prior valid file -> atomic rename.
export async function atomicWriteFile(
  filePath,
  content,
  { mode = 0o600, backup = false, fsync = true } = {},
) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle = null;
  try {
    handle = await open(tmpFile, 'w', mode);
    await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined);
    if (fsync) {
      try {
        await handle.sync();
      } catch {
        // Some virtual/network filesystems reject fsync; ignore cleanly.
      }
    }
    await handle.close();
    handle = null;
    await chmod(tmpFile, mode);

    if (backup && existsSync(filePath)) {
      const bak = backupPathFor(filePath);
      const bakTmp = `${bak}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await copyFile(filePath, bakTmp);
        await chmod(bakTmp, mode);
        await rename(bakTmp, bak);
      } catch {
        await unlink(bakTmp).catch(() => {});
      }
    }

    await rename(tmpFile, filePath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(tmpFile).catch(() => {});
    throw err;
  }
}

export function atomicWriteFileSync(
  filePath,
  content,
  { mode = 0o600, backup = false, fsync = false } = {},
) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd = null;
  try {
    if (fsync) {
      fd = openSync(tmpFile, 'w', mode);
      writeFileSync(fd, content, typeof content === 'string' ? 'utf8' : undefined);
      try {
        fsyncSync(fd);
      } catch {
        // Ignore fsync unsupported errors.
      }
      closeSync(fd);
      fd = null;
    } else {
      writeFileSync(tmpFile, content, { mode });
    }
    chmodSync(tmpFile, mode);

    if (backup && existsSync(filePath)) {
      const bak = backupPathFor(filePath);
      const bakTmp = `${bak}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        copyFileSync(filePath, bakTmp);
        chmodSync(bakTmp, mode);
        renameSync(bakTmp, bak);
      } catch {
        try { unlinkSync(bakTmp); } catch { /* ignore */ }
      }
    }

    renameSync(tmpFile, filePath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

// Reads and JSON-parses a file, optionally falling back to its `.bak` copy when the primary is truncated/corrupted.
export async function readJsonWithBackup(
  filePath,
  { validate = null, fallbackToBackup = true, strictMissingBackup = false } = {},
) {
  const tryRead = async (p) => {
    const text = await readFile(p, 'utf8');
    const parsed = JSON.parse(text);
    if (validate && !validate(parsed)) {
      throw new Error(`Invalid JSON structure in ${path.basename(p)}.`);
    }
    return parsed;
  };

  try {
    return { data: await tryRead(filePath), missing: false, recoveredFromBackup: false };
  } catch (primaryErr) {
    if (primaryErr?.code === 'ENOENT') {
      if (fallbackToBackup) {
        try {
          return {
            data: await tryRead(backupPathFor(filePath)),
            missing: false,
            recoveredFromBackup: true,
          };
        } catch (err) {
          if (strictMissingBackup && err?.code !== 'ENOENT') throw err;
        }
      }
      return { data: null, missing: true, recoveredFromBackup: false };
    }

    if (fallbackToBackup) {
      try {
        const bak = await tryRead(backupPathFor(filePath));
        return { data: bak, missing: false, recoveredFromBackup: true, primaryError: primaryErr };
      } catch {
        // Backup unavailable or also invalid; rethrow primary error.
      }
    }
    throw primaryErr;
  }
}

export function readJsonWithBackupSync(
  filePath,
  { validate = null, fallbackToBackup = true } = {},
) {
  const tryRead = (p) => {
    const text = readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    if (validate && !validate(parsed)) {
      throw new Error(`Invalid JSON structure in ${path.basename(p)}.`);
    }
    return parsed;
  };

  try {
    return { data: tryRead(filePath), missing: false, recoveredFromBackup: false };
  } catch (primaryErr) {
    if (primaryErr?.code === 'ENOENT') {
      return { data: null, missing: true, recoveredFromBackup: false };
    }
    if (fallbackToBackup) {
      try {
        return {
          data: tryRead(backupPathFor(filePath)),
          missing: false,
          recoveredFromBackup: true,
          primaryError: primaryErr,
        };
      } catch {
        // Ignore and throw primary error.
      }
    }
    throw primaryErr;
  }
}

// Strict shared LOOP_HUB_PORT parser (G7-15).
// Empty/undefined returns fallback (8799). AllowZero is only for programmatic ephemeral test servers (port: 0).
export function parseLoopPort(raw, { fallback = DEFAULT_LOOP_PORT, allowZero = false } = {}) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new Error(`Invalid LOOP_HUB_PORT "${raw}": must be an integer between 1 and 65535.`);
    }
    if (raw === 0 && allowZero) return 0;
    if (raw < 1 || raw > 65535) {
      throw new Error(`Invalid LOOP_HUB_PORT "${raw}": must be an integer between 1 and 65535.`);
    }
    return raw;
  }
  const str = String(raw).trim();
  if (!str) return fallback;
  if (!/^\d+$/.test(str)) {
    throw new Error(`Invalid LOOP_HUB_PORT "${raw}": must be an integer between 1 and 65535.`);
  }
  const n = Number(str);
  if (n === 0 && allowZero) return 0;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid LOOP_HUB_PORT "${raw}": must be an integer between 1 and 65535.`);
  }
  return n;
}
