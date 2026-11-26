// The dark twin of a Loop color. Light colors stay as designed; dark mode gets a warm espresso
// palette made from them by one rule, so CSS (light-dark()) and canvas drawing agree.
// Page surfaces (very light) become dark surfaces, ink (dark) becomes light ink. Hue stays.

const DARK_CARD_L = 0.245; // white cards and fields: one step above the page

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(c) { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255); }

function toOklch(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function fromOklch(L, C, h) {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076971153 * s),
  ];
}

/** Dark twin of one sRGB color, as [r, g, b]. */
export function darkRgb(r, g, b) {
  const [L, C, h] = toOklch(r, g, b);
  let L2;
  let C2 = C;
  if (L >= 0.995) L2 = DARK_CARD_L;                       // white
  else if (L >= 0.8) L2 = 0.205 + (0.99 - L) * 1.4;       // page, tints, lines
  else L2 = 0.47 + (0.8 - L) * 0.95;                      // ink, text, strong fills
  L2 = Math.min(0.95, Math.max(0.16, L2));
  if (L2 < 0.45) C2 = Math.min(C * 0.75, 0.05);           // dark surfaces stay quiet
  else C2 = Math.min(C * (L2 > 0.8 ? 0.45 : 0.9), 0.15); // light ink stays near neutral
  // Keep a little warmth in pure greys so they sit with the brown palette.
  if (C < 0.004) { C2 = 0.008; return fromOklch(L2, C2, 0.7); }
  return fromOklch(L2, C2, h);
}

const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). Returns [r, g, b, a] or null. */
export function parseColor(text) {
  const s = String(text).trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i);
  if (m) {
    let a = m[4] === undefined ? 1 : Number(m[4]);
    if (m[5]) a /= 100;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

/** Dark twin of a CSS color string, in the same notation family (hex or rgba). */
export function darkOf(text) {
  const c = parseColor(text);
  if (!c) return text;
  const [r, g, b] = darkRgb(c[0], c[1], c[2]);
  if (/^#/.test(String(text).trim()) && c[3] === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${+c[3].toFixed(3)})`;
}

/** True when the page shows the dark palette now. */
export function isDark() {
  if (typeof document === 'undefined') return false;
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

const cache = new Map();
/** The color to draw with now: as given in light mode, its dark twin in dark mode. */
export function tone(text) {
  if (!isDark()) return text;
  let v = cache.get(text);
  if (v === undefined) { v = darkOf(text); cache.set(text, v); }
  return v;
}

/** Colors for a Clerk sign-in form on a surface of color `bg`, in the palette that shows now. */
export function clerkColors(bg = '#FFFFFF') {
  return {
    colorPrimary: tone('#4D3533'),
    colorTextOnPrimaryBackground: tone('#FFFFFF'),
    colorBackground: tone(bg),
    colorText: tone('#3F2C2A'),
    colorTextSecondary: tone('#6F5A57'),
    colorInputBackground: tone('#FFFFFF'),
    colorInputText: tone('#3F2C2A'),
    colorNeutral: tone('#3F2C2A'),
    colorDanger: tone('#A3412F'),
    colorSuccess: tone('#3F7556'),
  };
}
