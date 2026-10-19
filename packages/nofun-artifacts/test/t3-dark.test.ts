import { test } from "node:test";
import assert from "node:assert/strict";

import { htmlTag } from "../src/linked.ts";
import { NO_BLUE_T3_CSS, PRESETS } from "../src/presets.ts";

// A17-CARDCONTRAST-nos: a dark t3 linked page must be self-sufficient in the opaque entry frame.
// The t3 theme points its tokens at host-injected variables, but the sandboxed iframe never
// receives a host sheet or a `.dark` class, so without its own marker dark tokens never engage
// and text renders near-black on dark. The marker goes on `<html>` because the runtime's
// `theme()` clears the body's classes and theme attributes on every load.

test("htmlTag marks dark t3 pages on <html> and leaves everything else bare", () => {
  assert.equal(htmlTag("t3", "dark"), `<!doctype html><html lang="en" class="dark">`);
  // A bare t3 page stays light: only an explicit dark scheme (e.g. the canvas-t3 preset) marks it.
  assert.equal(htmlTag("t3", undefined), `<!doctype html><html lang="en">`);
  assert.equal(htmlTag("t3", "light"), `<!doctype html><html lang="en">`);
  // Branded themes own their marker through bodyFor + theme(brand, {scheme}).
  assert.equal(htmlTag("kobra", "dark"), `<!doctype html><html lang="en">`);
  assert.equal(htmlTag("kobra", undefined), `<!doctype html><html lang="en">`);
});

test("canvas-t3 frame padding survives the runtime's attribute clearing", () => {
  const css = PRESETS["canvas-t3"].css;
  assert.ok(css.includes("body{padding:16px}"), css);
  assert.doesNotMatch(css, /body\[data-/);
});

test("canvas-t3 no-blue rules hang off html.dark so they match after theme() runs", () => {
  assert.ok(PRESETS["canvas-t3"].css.includes(NO_BLUE_T3_CSS));
  assert.ok(NO_BLUE_T3_CSS.startsWith("html.dark body{"), NO_BLUE_T3_CSS);
  assert.doesNotMatch(NO_BLUE_T3_CSS, /body\[data-/);
  for (const name of ["--primary", "--primary-foreground", "--ring", "--nf-focus", "--info"]) {
    assert.match(NO_BLUE_T3_CSS, new RegExp(`${name}:var\\(--`));
  }
  assert.doesNotMatch(NO_BLUE_T3_CSS, /#[0-9a-f]{3,6}|blue/i);
});
