// Built-in zero-dependency Time, Date Math, Exact Safe Math, and CSV/JSON Data Utilities (`loop_utils`).
// Never uses eval() or Function(): implements a strict recursive-descent arithmetic parser.

import { inputError } from './mcp-errors.mjs';
import { localClock, validTz, zonedTime } from './zoned-time.mjs';

export const BUILTIN_UTILS_ID = 'loop_utils';

export const BUILTIN_UTILS_TOOLS = Object.freeze([
  Object.freeze({
    name: 'time_now',
    description:
      'Get exact current date, clock time, weekday, and Unix timestamp in the user\'s timezone (plus optional extra timezones).',
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'Optional IANA timezone (defaults to workspace timezone).' },
        convertTo: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 8,
          description: 'Optional extra IANA timezones to show side-by-side.',
        },
      },
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'date_math',
    description:
      'Exact calendar date math: add/subtract days, weeks, months, years, hours, or minutes, compute date differences (including business days), or convert a timestamp between timezones. Whole days, weeks, months and years are calendar units in the timezone (January 31 plus 1 month is the last day of February). A date or time with no offset is read in that timezone (for "convert": in the workspace timezone).',
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['add', 'diff', 'convert'], description: 'Operation to run.' },
        date: { type: 'string', description: 'Base ISO date or timestamp (defaults to now).' },
        endDate: { type: 'string', description: 'Second ISO date or timestamp (required for "diff").' },
        amount: { type: 'number', description: 'Numeric delta for "add" (negative to subtract).' },
        unit: { type: 'string', enum: ['minutes', 'hours', 'days', 'weeks', 'months', 'years'] },
        timezone: { type: 'string', description: 'IANA timezone for the calculation and the result (defaults to workspace timezone).' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'calc',
    description:
      'Evaluate an exact arithmetic expression safely (no code execution). Integers of any size and decimals keep every digit (0.1 + 0.2 is 0.3); a result that cannot be exact (sqrt(2), log, 1/3) has exact: false. round() rounds a half away from zero. Supports +, -, *, /, %, ^, parentheses, pi, e, and functions: abs, round, floor, ceil, sqrt, pow, min, max, log, log10, sum, avg.',
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression to evaluate, e.g. "(1250 * 1.0825) / 12".' },
        precision: { type: 'integer', minimum: 0, maximum: 12, description: 'Optional decimal places to round to.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'query_data',
    description:
      'Filter, sort, and aggregate a CSV string or JSON array of objects accurately (count, sum, avg, min, max, groupBy). Data that cannot be read and an unknown field name are errors, never an empty result.',
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
        data: { description: 'JSON array of objects or CSV text.' },
        filter: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: { type: 'string' },
        sortDir: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
        groupBy: { type: 'string' },
        aggregate: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
            field: { type: 'string' },
          },
          required: ['op'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['data'],
      additionalProperties: false,
    },
  }),
]);

export const BUILTIN_UTILS_CONNECTION = Object.freeze({
  id: BUILTIN_UTILS_ID,
  name: 'Time & Math',
  description: 'Built-in exact clock/timezone, calendar date math, safe calculator, and CSV/JSON query tools.',
  transport: 'builtin',
  url: null,
  command: null,
  args: [],
  env: {},
  headers: {},
  profiles: ['all'],
  enabled: true,
  disabledTools: [],
  allowedTools: null,
  pinnedTools: ['time_now', 'calc'],
  pinsCustomized: false,
  authRequired: false,
  toolNames: ['time_now', 'date_math', 'calc', 'query_data'],
});

/* ---------------- Exact numbers ---------------- */

// calc works with fractions of two BigInts, so 0.1 + 0.2 is 0.3 and an integer of any size keeps
// every digit. A value that no fraction can hold (sqrt(2), log, pi) is a JS number, and the answer
// then says exact: false.
const MAX_EXACT_DIGITS = 1200; // a fraction with more digits than this goes on as a JS number
const MAX_PLAIN_DECIMALS = 40; // an exact decimal with more places than this is rounded in the answer
const DEFAULT_DECIMALS = 12;

const isFrac = (v) => v !== null && typeof v === 'object';
const absBig = (x) => (x < 0n ? -x : x);
const digitsOf = (x) => absBig(x).toString().length;

function gcdBig(a, b) {
  let x = absBig(a);
  let y = absBig(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** The decimal text of a fraction with `places` decimal places. A half rounds away from zero. */
function fracToDecimal({ n, d }, places) {
  const scale = 10n ** BigInt(places);
  const q = (absBig(n) * scale * 2n + d) / (2n * d);
  const digits = q.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const text = places ? `${whole}.${digits.slice(-places)}` : whole;
  return n < 0n && q !== 0n ? `-${text}` : text;
}

function fracToNumber(v) {
  // Enough places for 20 significant digits, also when the value is very small.
  const places = Math.max(20, 21 + digitsOf(v.d) - digitsOf(v.n));
  return Number(fracToDecimal(v, places));
}

const toFloat = (v) => (isFrac(v) ? fracToNumber(v) : v);

/** A fraction in lowest terms, or a JS number when it has too many digits to stay exact. */
function makeFrac(n, d = 1n) {
  if (d === 0n) throw inputError('Division by zero.');
  const g = gcdBig(n, d) || 1n;
  const v = d < 0n ? { n: -n / g, d: -d / g } : { n: n / g, d: d / g };
  return digitsOf(v.n) > MAX_EXACT_DIGITS || digitsOf(v.d) > MAX_EXACT_DIGITS ? fracToNumber(v) : v;
}

/** "12", "1.0825", ".5" or "2.5e-3" as an exact fraction. */
function parseNumberLiteral(raw) {
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m || (!m[1] && !m[2])) throw inputError(`Invalid number "${raw}".`);
  const exp = m[3] ? Number(m[3]) : 0;
  if (Math.abs(exp) > 400) {
    const num = Number(raw);
    if (!Number.isFinite(num)) throw inputError(`Invalid number "${raw}".`);
    return num;
  }
  const decimals = m[2] || '';
  let n = BigInt(`${m[1] || '0'}${decimals}`);
  let d = 10n ** BigInt(decimals.length);
  if (exp > 0) n *= 10n ** BigInt(exp);
  else if (exp < 0) d *= 10n ** BigInt(-exp);
  return makeFrac(n, d);
}

/** A decimal text with an optional sign ("-0.3", "1e+21") as a fraction, or null when it is not one. */
function decimalTextToFrac(text) {
  const s = String(text).trim();
  const body = s.replace(/^[+-]/, '');
  if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(body)) return null;
  const v = parseNumberLiteral(body);
  if (!isFrac(v)) return null;
  return s.startsWith('-') ? makeFrac(-v.n, v.d) : v;
}

const sameFrac = (a, b) => isFrac(a) && isFrac(b) && a.n === b.n && a.d === b.d;
const cmpFrac = (a, b) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

/** How many decimal places 1/d has, or null when the decimal does not end (1/3). */
function terminatingPlaces(d) {
  let x = d;
  let twos = 0;
  let fives = 0;
  while (x % 2n === 0n) { x /= 2n; twos += 1; }
  while (x % 5n === 0n) { x /= 5n; fives += 1; }
  return x === 1n ? Math.max(twos, fives) : null;
}

/** An exact decimal text for JSON: a number when a JSON number holds every digit, else the text. */
function decimalForJson(text) {
  const num = Number(text);
  if (Number.isFinite(num) && sameFrac(decimalTextToFrac(String(num)), decimalTextToFrac(text))) return num;
  return text;
}

function isqrtBig(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function truncValue(v) {
  return isFrac(v) ? makeFrac(v.n / v.d) : Math.trunc(v);
}

function arith(op, a, b) {
  if (isFrac(a) && isFrac(b)) {
    if (op === '+') return makeFrac(a.n * b.d + b.n * a.d, a.d * b.d);
    if (op === '-') return makeFrac(a.n * b.d - b.n * a.d, a.d * b.d);
    if (op === '*') return makeFrac(a.n * b.n, a.d * b.d);
    if (b.n === 0n) throw inputError('Division by zero.');
    if (op === '/') return makeFrac(a.n * b.d, a.d * b.n);
    // The sign of the result is the sign of the left number, as in JavaScript.
    return arith('-', a, arith('*', b, truncValue(arith('/', a, b))));
  }
  const x = toFloat(a);
  const y = toFloat(b);
  if (op === '+') return x + y;
  if (op === '-') return x - y;
  if (op === '*') return x * y;
  if (y === 0) throw inputError('Division by zero.');
  return op === '/' ? x / y : x % y;
}

function power(base, exp) {
  if (isFrac(base) && isFrac(exp) && exp.d === 1n) {
    const mag = absBig(exp.n);
    if (mag <= 4096n && Math.max(digitsOf(base.n), digitsOf(base.d)) * Number(mag) <= MAX_EXACT_DIGITS) {
      if (exp.n < 0n && base.n === 0n) throw inputError('Division by zero.');
      const n = base.n ** mag;
      const d = base.d ** mag;
      return exp.n < 0n ? makeFrac(d, n) : makeFrac(n, d);
    }
  }
  return Math.pow(toFloat(base), toFloat(exp));
}

function roundValue(v, places) {
  if (isFrac(v)) return decimalTextToFrac(fracToDecimal(v, places));
  return Number.isFinite(v) ? Number(v.toFixed(places)) : v;
}

const sumValues = (a) => a.reduce((acc, v) => arith('+', acc, v), makeFrac(0n));
const pickValue = (a, keepLeft) => a.reduce((best, v) => (
  isFrac(best) && isFrac(v) ? (keepLeft(cmpFrac(best, v)) ? best : v) : (keepLeft(Math.sign(toFloat(best) - toFloat(v))) ? best : v)
));

/* ---------------- Safe Recursive-Descent Math Evaluator ---------------- */

const MATH_CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E });
const MATH_FUNCS = Object.freeze({
  abs: (a) => (isFrac(a[0]) ? makeFrac(absBig(a[0].n), a[0].d) : Math.abs(a[0])),
  round: (a) => roundValue(a[0], a.length >= 2 ? Math.max(0, Math.min(DEFAULT_DECIMALS, Math.trunc(toFloat(a[1])) || 0)) : 0),
  floor: (a) => {
    if (!isFrac(a[0])) return Math.floor(a[0]);
    const q = a[0].n / a[0].d;
    return makeFrac(a[0].n < 0n && a[0].n % a[0].d !== 0n ? q - 1n : q);
  },
  ceil: (a) => {
    if (!isFrac(a[0])) return Math.ceil(a[0]);
    const q = a[0].n / a[0].d;
    return makeFrac(a[0].n > 0n && a[0].n % a[0].d !== 0n ? q + 1n : q);
  },
  sqrt: (a) => {
    const v = a[0];
    if (isFrac(v) && v.n >= 0n) {
      const rn = isqrtBig(v.n);
      const rd = isqrtBig(v.d);
      if (rn * rn === v.n && rd * rd === v.d) return makeFrac(rn, rd);
    }
    return Math.sqrt(toFloat(v));
  },
  pow: (a) => {
    if (a.length < 2) throw inputError('Function "pow" requires two arguments.');
    return power(a[0], a[1]);
  },
  min: (a) => pickValue(a, (c) => c <= 0),
  max: (a) => pickValue(a, (c) => c >= 0),
  log: (a) => Math.log(toFloat(a[0])),
  log10: (a) => Math.log10(toFloat(a[0])),
  sin: (a) => Math.sin(toFloat(a[0])),
  cos: (a) => Math.cos(toFloat(a[0])),
  tan: (a) => Math.tan(toFloat(a[0])),
  sum: (a) => sumValues(a),
  avg: (a) => arith('/', sumValues(a), makeFrac(BigInt(a.length))),
});

function tokenizeMath(expr) {
  const src = String(expr ?? '').trim();
  if (!src || src.length > 500) throw inputError('Expression must be between 1 and 500 characters.');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9._eE]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-')) j += 2;
        else j += 1;
      }
      tokens.push({ type: 'num', value: parseNumberLiteral(src.slice(i, j).replace(/_/g, '')) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw inputError(`Unsupported character "${ch}" in expression.`);
  }
  return tokens;
}

/** The value of an expression: an exact fraction { n, d } of BigInts, or a JS number when it is not exact. */
export function evaluateMathExact(expr) {
  const tokens = tokenizeMath(expr);
  let pos = 0;
  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++];

  function parseExpression() {
    let left = parseTerm();
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      left = arith(op, left, parseTerm());
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      left = arith(op, left, parseUnary());
    }
    return left;
  }

  // A sign binds less tightly than "^", as in mathematics: -2 ^ 2 is -(2 ^ 2), and 2 ^ -2 is 0.25.
  function parseUnary() {
    if (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const val = parseUnary();
      if (op === '+') return val;
      return isFrac(val) ? makeFrac(-val.n, val.d) : -val;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek()?.type === 'op' && peek().value === '^') {
      consume();
      return power(base, parseUnary());
    }
    return base;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw inputError('Unexpected end of expression.');
    if (tok.type === 'num') {
      consume();
      return tok.value;
    }
    if (tok.type === 'ident') {
      consume();
      if (peek()?.type === 'op' && peek().value === '(') {
        const fn = Object.hasOwn(MATH_FUNCS, tok.value) ? MATH_FUNCS[tok.value] : null;
        if (!fn) throw inputError(`Unknown function "${tok.value}".`);
        consume(); // '('
        const args = [];
        if (!(peek()?.type === 'op' && peek().value === ')')) {
          while (true) {
            args.push(parseExpression());
            if (peek()?.type === 'op' && peek().value === ',') { consume(); continue; }
            break;
          }
        }
        if (peek()?.type !== 'op' || peek().value !== ')') throw inputError(`Expected ")" after ${tok.value} arguments.`);
        consume();
        if (args.length === 0) throw inputError(`Function "${tok.value}" requires at least one argument.`);
        return fn(args);
      }
      if (Object.hasOwn(MATH_CONSTANTS, tok.value)) return MATH_CONSTANTS[tok.value];
      throw inputError(`Unknown identifier "${tok.value}".`);
    }
    if (tok.type === 'op' && tok.value === '(') {
      consume();
      const val = parseExpression();
      if (peek()?.type !== 'op' || peek().value !== ')') throw inputError('Missing closing parenthesis ")".');
      consume();
      return val;
    }
    throw inputError(`Unexpected token "${tok.value}".`);
  }

  const value = parseExpression();
  if (pos < tokens.length) throw inputError(`Unexpected trailing token "${tokens[pos].value}".`);
  if (!isFrac(value) && !Number.isFinite(value)) throw inputError('Result is not a finite number.');
  return value;
}

/** The value of an expression as a JS number. Use evaluateMathExact when every digit matters. */
export function evaluateMathExpression(expr) {
  const value = toFloat(evaluateMathExact(expr));
  if (!Number.isFinite(value)) throw inputError('Result is not a finite number.');
  return value;
}

/** What calc answers: the result, and if every digit of it is exact. */
function calcAnswer(value, precision) {
  const places = Number.isInteger(precision) ? Math.max(0, Math.min(DEFAULT_DECIMALS, precision)) : null;
  if (!isFrac(value)) return { result: Number(value.toFixed(places ?? DEFAULT_DECIMALS)), exact: false };
  const textAnswer = (text, exact, extra = {}) => {
    const result = decimalForJson(text);
    return {
      result,
      exact,
      ...extra,
      ...(typeof result === 'string' ? { note: 'The result is text, because a JSON number cannot hold all its digits.' } : {}),
    };
  };
  if (places !== null) {
    const text = fracToDecimal(value, places);
    return textAnswer(text, sameFrac(decimalTextToFrac(text), value));
  }
  const ends = terminatingPlaces(value.d);
  if (ends !== null && ends <= MAX_PLAIN_DECIMALS) return textAnswer(fracToDecimal(value, ends), true);
  const short = digitsOf(value.n) <= 18 && digitsOf(value.d) <= 18;
  return textAnswer(fracToDecimal(value, DEFAULT_DECIMALS), false, short ? { fraction: `${value.n}/${value.d}` } : {});
}

/* ---------------- Time & Date Helpers ---------------- */

const TZ_HINT = 'Use an IANA name, for example "America/New_York" or "Asia/Tokyo".';

/** The time zone to use. An unknown name is an error: a silent default gives a wrong clock time. */
function requireTz(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback) return fallback;
    throw inputError(`A time zone is required. ${TZ_HINT}`);
  }
  if (typeof raw !== 'string' || !validTz(raw)) {
    throw inputError(`Unknown time zone "${String(raw).slice(0, 60)}". ${TZ_HINT}`);
  }
  return raw.trim();
}

const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dayNumber = (c) => Math.round(Date.UTC(c.y, c.mo - 1, c.d) / 86_400_000);

function formatClockZone(ms, tz) {
  const safeTz = validTz(tz) ? tz : 'America/Chicago';
  const clk = localClock(ms, safeTz);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: safeTz, weekday: 'long' }).format(new Date(ms));
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
  return {
    timezone: safeTz,
    date: clk.date,
    time24: `${pad2(clk.h)}:${pad2(clk.mi)}`,
    weekday,
    formatted,
    isoUtc: new Date(ms).toISOString(),
    unixSeconds: Math.floor(ms / 1000),
  };
}

/**
 * A date argument as { ms, dateOnly, y, mo, d }. A date with no time, and a date and time with no
 * offset, are a calendar date and a clock time in `tz`: not in UTC, and not in the zone of the server.
 */
function parseDateArg(raw, tz, fallbackMs, label = 'date') {
  if (raw === undefined || raw === null || raw === '') {
    if (!Number.isFinite(fallbackMs)) throw inputError(`${label} is required.`);
    return { ms: fallbackMs, dateOnly: false };
  }
  const s = String(raw).trim();
  const bad = () => inputError(`Invalid ${label} "${s.slice(0, 60)}". Use an ISO date such as 2026-01-31 or 2026-01-31T09:00:00Z.`);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw bad();
    if (m[4] === undefined) return { ms: zonedTime(y, mo, d, 0, 0, tz), dateOnly: true, zoneAssumed: true, y, mo, d };
    const [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)];
    if (h > 23 || mi > 59 || sec > 59) throw bad();
    return { ms: zonedTime(y, mo, d, h, mi, tz) + sec * 1000, dateOnly: false, zoneAssumed: true };
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw bad();
  return { ms, dateOnly: false };
}

/** Whole calendar units added to a date. A day that the new month does not have becomes its last day. */
function addCalendar(c, unit, amount) {
  if (unit === 'days' || unit === 'weeks') {
    const dt = new Date(Date.UTC(c.y, c.mo - 1, c.d + amount * (unit === 'weeks' ? 7 : 1)));
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), clamped: false };
  }
  const total = c.y * 12 + (c.mo - 1) + (unit === 'years' ? amount * 12 : amount);
  const y = Math.floor(total / 12);
  const mo = total - y * 12 + 1;
  const last = daysInMonth(y, mo);
  return { y, mo, d: Math.min(c.d, last), clamped: c.d > last };
}

/** Weekdays from the first calendar date up to, and not with, the second. */
function countBusinessDays(a, b) {
  const start = dayNumber(a);
  const end = dayNumber(b);
  const lo = Math.min(start, end);
  const span = Math.abs(end - start);
  const dow0 = ((new Date(lo * 86_400_000).getUTCDay() % 7) + 7) % 7;
  let count = Math.floor(span / 7) * 5;
  for (let i = 0; i < span % 7; i += 1) {
    const dow = (dow0 + i) % 7;
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return end >= start ? count : -count;
}

/* ---------------- CSV & JSON Query Helpers ---------------- */

const MAX_QUERY_ROWS = 5000;

function parseCsvRows(rawCsv) {
  const lines = String(rawCsv || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows: [], columns: [], truncated: false };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < MAX_QUERY_ROWS; i += 1) {
    const vals = parseLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      const v = vals[idx] ?? '';
      const num = v !== '' && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN;
      obj[h] = Number.isFinite(num) ? num : v;
    });
    rows.push(obj);
  }
  return { rows, columns: headers, truncated: lines.length - 1 > MAX_QUERY_ROWS };
}

/** The rows of query_data. Data that Loop cannot read is an error, never an empty result. */
function readQueryRows(args) {
  const data = args.data;
  const text = typeof data === 'string' ? data.trim() : null;
  if (text === null && !Array.isArray(data)) throw inputError('data must be a JSON array of objects or CSV text.');
  if (text !== null && text === '') throw inputError('data is empty. Give a JSON array of objects or CSV text with a header line.');
  let rows;
  let truncated = false;
  let columns = null;
  if (text !== null && (args.format === 'csv' || !/^[[{]/.test(text))) {
    ({ rows, columns, truncated } = parseCsvRows(text));
  } else {
    let parsed = data;
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw inputError(`data is not valid JSON: ${String(err?.message || err).slice(0, 160)}`);
      }
    }
    if (!Array.isArray(parsed)) throw inputError('JSON data must be an array of objects.');
    const badIndex = parsed.findIndex((r) => r === null || typeof r !== 'object' || Array.isArray(r));
    if (badIndex >= 0) throw inputError(`JSON data must be an array of objects. Item ${badIndex} is not an object.`);
    truncated = parsed.length > MAX_QUERY_ROWS;
    rows = parsed.slice(0, MAX_QUERY_ROWS);
  }
  if (!columns) {
    const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
    columns = [...seen];
  }
  return { rows, columns, truncated };
}

function matchFilter(row, f) {
  const left = row?.[f.field];
  const right = f.value;
  if (f.op === 'eq') return left == right; // intentional string/number convenience
  if (f.op === 'neq') return left != right;
  if (f.op === 'gt') return Number(left) > Number(right);
  if (f.op === 'gte') return Number(left) >= Number(right);
  if (f.op === 'lt') return Number(left) < Number(right);
  if (f.op === 'lte') return Number(left) <= Number(right);
  if (f.op === 'contains') return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
  return true;
}

/** A cell as an exact fraction when it is a number or the text of one. An empty cell is not a zero. */
function numericCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? decimalTextToFrac(String(v)) : null;
  if (typeof v === 'string' && v.trim() !== '') return decimalTextToFrac(v);
  return null;
}

function aggregateRows(rows, agg) {
  if (!agg) return { value: null, skipped: 0 };
  if (agg.op === 'count') return { value: rows.length, skipped: 0 };
  const cells = rows.map((r) => numericCell(r?.[agg.field]));
  const nums = cells.filter(Boolean);
  const skipped = cells.length - nums.length;
  if (nums.length === 0) return { value: null, skipped };
  if (agg.op === 'min' || agg.op === 'max') {
    const best = nums.reduce((b, v) => (((agg.op === 'min') === (cmpFrac(v, b) < 0)) && cmpFrac(v, b) !== 0 ? v : b));
    return { value: decimalForJson(fracToDecimal(best, terminatingPlaces(best.d) ?? 10)), skipped };
  }
  const sum = nums.reduce((a, b) => arith('+', a, b), makeFrac(0n));
  const out = agg.op === 'sum' ? sum : arith('/', sum, makeFrac(BigInt(nums.length)));
  if (!isFrac(out)) return { value: out, skipped };
  const ends = terminatingPlaces(out.d);
  return { value: decimalForJson(fracToDecimal(out, ends !== null && ends <= MAX_PLAIN_DECIMALS ? ends : 10)), skipped };
}

function queryData(args) {
  const { rows: allRows, columns, truncated } = readQueryRows(args);
  const fieldList = columns.slice(0, 40).map((c) => `"${c}"`).join(', ') || 'none';
  const needField = (name, where) => {
    const field = typeof name === 'string' ? name.trim() : '';
    if (!field) throw inputError(`${where} needs a field name. Fields: ${fieldList}.`);
    if (allRows.length > 0 && !columns.includes(field)) throw inputError(`Unknown field "${field.slice(0, 60)}" in ${where}. Fields: ${fieldList}.`);
    return field;
  };

  let rows = allRows;
  if (args.filter !== undefined && args.filter !== null) {
    if (!Array.isArray(args.filter)) throw inputError('filter must be a list of { field, op, value }.');
    const filters = args.filter.map((f, i) => {
      if (!f || typeof f !== 'object') throw inputError(`filter[${i}] must be { field, op, value }.`);
      if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'].includes(f.op)) throw inputError(`filter[${i}].op must be one of: eq, neq, gt, gte, lt, lte, contains.`);
      return { ...f, field: needField(f.field, `filter[${i}]`) };
    });
    rows = rows.filter((row) => filters.every((f) => matchFilter(row, f)));
  }
  let aggregate = null;
  if (args.aggregate !== undefined && args.aggregate !== null) {
    const op = args.aggregate?.op;
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(op)) throw inputError('aggregate.op must be one of: count, sum, avg, min, max.');
    aggregate = op === 'count' ? { op } : { op, field: needField(args.aggregate.field, `aggregate "${op}"`) };
  }
  if (typeof args.sortBy === 'string' && args.sortBy.trim()) {
    const field = needField(args.sortBy, 'sortBy');
    const dir = args.sortDir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a?.[field];
      const bv = b?.[field];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }
  const notes = [];
  if (truncated) notes.push(`Only the first ${MAX_QUERY_ROWS} rows were read.`);
  if (allRows.length === 0) notes.push(`The data has no rows. Fields: ${fieldList}.`);
  const withNotes = (out, skipped = 0) => {
    if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? 'value is' : 'values are'} not a number in "${aggregate.field}" and ${skipped === 1 ? 'is' : 'are'} not in the result.`);
    return notes.length ? { ...out, note: notes.join(' ') } : out;
  };

  if (typeof args.groupBy === 'string' && args.groupBy.trim()) {
    const gField = needField(args.groupBy, 'groupBy');
    const groups = new Map();
    for (const r of rows) {
      const k = String(r?.[gField] ?? '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    let skippedTotal = 0;
    const grouped = [...groups.entries()].map(([group, list]) => {
      if (!aggregate) return { group, count: list.length };
      const { value, skipped } = aggregateRows(list, aggregate);
      skippedTotal += skipped;
      return { group, count: list.length, value };
    });
    return withNotes({ totalRows: rows.length, groups: grouped }, skippedTotal);
  }
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  if (!aggregate) return withNotes({ totalRows: rows.length, rows: rows.slice(0, limit) });
  const { value, skipped } = aggregateRows(rows, aggregate);
  if (value === null && rows.length > 0) throw inputError(`Field "${aggregate.field}" has no numbers, so "${aggregate.op}" has no result.`);
  return withNotes({ totalRows: rows.length, aggregate: value, rows: rows.slice(0, limit) }, skipped);
}

export async function callUtilsTool(toolName, args = {}, { defaultTimezone: givenTimezone = 'America/Chicago', now = Date.now() } = {}) {
  const defaultTimezone = validTz(givenTimezone) ? givenTimezone : 'America/Chicago';
  if (toolName === 'time_now') {
    const tz = requireTz(args.timezone, defaultTimezone);
    const primary = formatClockZone(now, tz);
    const extras = Array.isArray(args.convertTo)
      ? args.convertTo.slice(0, 8).map((z) => formatClockZone(now, requireTz(z, null)))
      : [];
    return { ...primary, ...(extras.length ? { conversions: extras } : {}) };
  }

  if (toolName === 'date_math') {
    const tz = requireTz(args.timezone, defaultTimezone);
    if (args.operation === 'convert') {
      // timezone is the target of a convert. An input with no offset is a time in the zone of the
      // workspace: if Loop read it in the target zone, the convert did nothing.
      const source = parseDateArg(args.date, defaultTimezone, now, 'date');
      return {
        ...formatClockZone(source.ms, tz),
        ...(source.zoneAssumed ? { note: `The input has no UTC offset, so Loop read it as a clock time in ${defaultTimezone}.` } : {}),
      };
    }
    const base = parseDateArg(args.date, tz, now, 'date');
    if (args.operation === 'diff') {
      const end = parseDateArg(args.endDate, tz, NaN, 'endDate');
      const startDay = base.dateOnly ? base : localClock(base.ms, tz);
      const endDay = end.dateOnly ? end : localClock(end.ms, tz);
      const calendarDays = dayNumber(endDay) - dayNumber(startDay);
      // Two dates with no time have no clock: the difference is a whole number of days, also when a
      // clock change is between them.
      const wholeDays = base.dateOnly && end.dateOnly;
      const diffMs = wholeDays ? calendarDays * 86_400_000 : end.ms - base.ms;
      const dateText = (c) => `${c.y}-${pad2(c.mo)}-${pad2(c.d)}`;
      return {
        start: wholeDays ? dateText(base) : new Date(base.ms).toISOString(),
        end: wholeDays ? dateText(end) : new Date(end.ms).toISOString(),
        timezone: tz,
        milliseconds: diffMs,
        minutes: Number((diffMs / 60_000).toFixed(4)),
        hours: Number((diffMs / 3_600_000).toFixed(4)),
        days: Number((diffMs / 86_400_000).toFixed(4)),
        calendarDays,
        businessDays: countBusinessDays(startDay, endDay),
      };
    }
    if (args.operation === 'add') {
      const amount = Number(args.amount);
      if (args.amount === undefined || args.amount === null || !Number.isFinite(amount)) throw inputError('amount must be a finite number.');
      const unit = String(args.unit || 'days');
      if (!['minutes', 'hours', 'days', 'weeks', 'months', 'years'].includes(unit)) throw inputError(`Unsupported unit "${unit.slice(0, 40)}". Use minutes, hours, days, weeks, months or years.`);
      const clk = localClock(base.ms, tz);
      let nextMs;
      let note = '';
      if (unit === 'minutes' || unit === 'hours') {
        nextMs = base.ms + amount * (unit === 'hours' ? 3_600_000 : 60_000);
      } else if (!Number.isInteger(amount)) {
        if (unit === 'months' || unit === 'years') throw inputError(`amount must be a whole number for "${unit}".`);
        // A part of a day is elapsed time.
        nextMs = base.ms + amount * (unit === 'weeks' ? 7 : 1) * 86_400_000;
      } else {
        // Whole days, weeks, months and years are calendar units: the clock time in the zone stays.
        const next = addCalendar(clk, unit, amount);
        const withinMinute = ((base.ms % 60_000) + 60_000) % 60_000;
        nextMs = zonedTime(next.y, next.mo, next.d, clk.h, clk.mi, tz) + withinMinute;
        if (next.clamped) note = `Day ${clk.d} is not in the new month, so the result is the last day of that month.`;
      }
      if (!Number.isFinite(nextMs) || Math.abs(nextMs) > 8.64e15) throw inputError('The result is not a date that Loop can show.');
      return {
        base: new Date(base.ms).toISOString(),
        baseLocal: `${clk.date} ${pad2(clk.h)}:${pad2(clk.mi)} ${tz}`,
        result: formatClockZone(nextMs, tz),
        ...(note ? { note } : {}),
      };
    }
    throw inputError(`Unsupported date_math operation "${String(args.operation).slice(0, 40)}". Use add, diff or convert.`);
  }

  if (toolName === 'calc') {
    return { expression: String(args.expression).trim(), ...calcAnswer(evaluateMathExact(args.expression), args.precision) };
  }

  if (toolName === 'query_data') return queryData(args);

  throw new Error(`Unknown built-in utility tool "${toolName}".`);
}
