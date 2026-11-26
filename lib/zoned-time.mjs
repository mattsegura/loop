// Wall-clock time in an IANA timezone.

export function validTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function tzOffset(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function zonedTime(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

export function localClock(ms, tz = 'America/Chicago') {
  const safeTz = validTz(tz) ? tz : 'America/Chicago';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const mi = Number(parts.minute);
  return { tz: safeTz, date: `${parts.year}-${parts.month}-${parts.day}`, y, mo, d, h, mi, totalMin: h * 60 + mi };
}
