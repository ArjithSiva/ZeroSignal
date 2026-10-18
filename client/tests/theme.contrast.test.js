import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/index.css', 'utf8');

/** Collect `--color-x: #hex` pairs from a block that starts at `marker`. */
const block = (marker) => {
  const i = css.indexOf(marker);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
};
const dark = { ...block('@theme static') };
const light = { ...dark, ...block('[data-theme="light"] {') };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, t] of [['dark', dark], ['light', light]]) {
  describe(`${name} theme contrast (WCAG AA)`, () => {
    for (const bg of ['canvas', 'surface', 'raised']) {
      for (const fg of ['ink', 'muted', 'faint', 'primary', 'accent', 'success', 'warning', 'critical', 'tier-480', 'tier-240', 'tier-text']) {
        it(`${fg} on ${bg} ≥ 4.5`, () => expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
      }
    }
    it('button text on primary ≥ 4.5', () => expect(ratio(t['on-primary'], t.primary)).toBeGreaterThanOrEqual(4.5));
    it('white text on critical-fill ≥ 4.5', () => expect(ratio('#ffffff', t['critical-fill'])).toBeGreaterThanOrEqual(4.5));
    it('white text on success-fill ≥ 4.5', () => expect(ratio('#ffffff', t['success-fill'])).toBeGreaterThanOrEqual(4.5));
  });
}
