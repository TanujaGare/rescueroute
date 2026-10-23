import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static WCAG 2.1 checks on the shipped markup, styles and client script.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('document declares language, title, viewport and description', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>[^<]{3,}<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<meta name="description" content="[^"]{20,}">/);
});

test('landmarks and skip link exist (WCAG 2.4.1 bypass blocks)', () => {
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<header/);
  assert.match(html, /<nav[^>]*aria-label="Sections"/);
  assert.match(html, /<footer/);
});

test('every form control has an associated label (WCAG 1.3.1, 4.1.2)', () => {
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2]);
  assert.ok(controls.length >= 10, 'form controls found');
  for (const id of controls) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `label for #${id}`);
  }
  const unlabeled = [...html.matchAll(/<(input|select|textarea)\b(?![^>]*\bid=)[^>]*>/g)];
  assert.equal(unlabeled.length, 0, 'no control without an id/label pairing');
});

test('every button has an accessible name and an explicit type', () => {
  for (const [tag] of html.matchAll(/<button\b[^>]*>/g)) {
    assert.match(tag, /type="(button|submit)"/, tag);
  }
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    assert.ok(m[1].replace(/<[^>]+>/g, '').trim().length > 0 || /aria-label=/.test(m[0]), m[0]);
  }
});

test('dynamic status messages are announced to screen readers (WCAG 4.1.3)', () => {
  const live = html.match(/role="(status|alert)"/g) ?? [];
  assert.ok(live.length >= 4, `found ${live.length} live regions`);
});

test('tables have captions and header scope', () => {
  const tables = html.match(/<table\b/g) ?? [];
  const captions = html.match(/<caption/g) ?? [];
  assert.equal(captions.length, tables.length);
  assert.match(js, /el\('th', \{ scope: 'col'/);
});

test('decorative icons are hidden and the map has a text alternative', () => {
  assert.match(html, /<svg class="brand-mark"[^>]*aria-hidden="true"/);
  assert.match(js, /setAttribute\('role', 'img'\)/);
  assert.match(js, /setAttribute\('aria-label', `Map of/);
});

test('styles support keyboard focus, reduced motion, dark mode and hidden state', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(css, /min-height: 4[04]px/, 'touch targets of at least 40px');
});

test('no positive tabindex and no inline handlers or styles (CSP-safe)', () => {
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.doesNotMatch(html, /\son[a-z]+="/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
});
