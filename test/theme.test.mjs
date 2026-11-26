// Light and dark Look: colors in CSS are light-dark() pairs made by public/core/tone.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { darkOf, parseColor } from '../public/core/tone.js';

const lum = (c) => {
  const [r, g, b] = parseColor(c).slice(0, 3).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('dark twins turn the page dark and the ink light, with readable text', () => {
  const bg = darkOf('#FDFCFB');
  assert.ok(lum(bg) < 0.02, `page ${bg} is dark`);
  for (const text of ['#3F2C2A', '#4D3533', '#6F5A57', '#7E6865', '#3F7556', '#8E5B22', '#A3412F', '#4B5E86']) {
    const dark = darkOf(text);
    assert.ok(contrast(dark, bg) >= 4.5, `${text} -> ${dark} reads on ${bg}`);
    assert.ok(contrast(dark, darkOf('#FFFFFF')) >= 4.5, `${text} -> ${dark} reads on a card`);
  }
  assert.match(darkOf('rgba(77, 53, 51, .14)'), /^rgba\(\d+, \d+, \d+, 0\.14\)$/);
});

// Parts that keep one color in both looks: app logos on white, the dark bottom bar, code boxes.
const SAME_IN_BOTH = /^\s*(\.nav\b|\.conn-logo > img|\.sys-icon|\.ap-code|\.ap-copy|\.cp-tool-out)/;

test('app.css writes every fixed color as a light-dark() pair', () => {
  const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  const loose = [];
  css.split('\n').forEach((line, i) => {
    if (SAME_IN_BOTH.test(line) || /^\s*\/?\*/.test(line)) return;
    const rest = line
      .replace(/light-dark\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, '')
      .replace(/(-webkit-)?mask(-image)?\s*:[^;]*;?/g, '')
      .replace(/(box-shadow|shadow)\s*:[^;]*rgb\(0 0 0[^;]*;?/g, '')
      .replace(/^\s*(-webkit-)?mask-image:.*$/, '');
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rest)) loose.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  assert.deepEqual(loose, [], 'Write new colors as light-dark(light, dark); core/tone.js darkOf() gives the dark one.');
});

test('every page loads the Look script before it paints', () => {
  for (const page of ['index', 'landing', 'invite', 'join', 'people-join', 'agent-link']) {
    const html = fs.readFileSync(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<script src="\.?\/theme-boot\.js"><\/script>/, page);
    assert.ok(html.indexOf('theme-boot.js') < html.indexOf('</head>'), `${page}: in the head`);
    assert.match(html, /<meta name="color-scheme" content="light dark">/, page);
  }
});
