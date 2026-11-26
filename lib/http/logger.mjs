// Lightweight zero-dependency structured logger for Loop Gateway.
// Never logs secret values, authorization headers, or raw tool arguments.
import { randomBytes } from 'node:crypto';

export function createRequestId() {
  return randomBytes(6).toString('hex');
}

function isJsonMode() {
  const raw = String(process.env.LOOP_LOG_FORMAT || '').trim().toLowerCase();
  return raw === 'json' || process.env.LOOP_HOSTED === '1';
}

function emit(level, event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event: String(event || 'log'),
    ...fields,
  };
  if (isJsonMode()) {
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return;
  }
  const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const msg = `[loop:${level}] ${entry.event}${suffix}`;
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

export const logger = Object.freeze({
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
});
