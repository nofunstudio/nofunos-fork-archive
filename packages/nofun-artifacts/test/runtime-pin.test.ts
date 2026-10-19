import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { OPTIONAL_MANIFEST_KEYS, MANIFEST_KEYS, writeCanvasBundle } from "../src/canvas-bundle.ts";
import { NO_BLUE_T3_CSS, PRESETS } from "../src/presets.ts";
import {
  assertRuntimePin,
  findRuntimePin,
  readRuntimePin,
  runtimeDigest,
} from "../src/runtime-pin.ts";
import type { ArtifactStamp } from "../src/stamp.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const VERSION = "580e64f46a50";
const STAMP: ArtifactStamp = {
  components: `${VERSION}${"0".repeat(28)}`,
  compiler: "0.0.0",
  lane: "tsx",
  theme: "kobra",
  at: "2026-10-19T00:00:00Z",
};

function runtimeRoot(js = "window.NoFunUI={}", css = "body{}"): { root: string; dir: string } {
  const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "a1-runtime-"));
  const dir = NodePath.join(root, VERSION);
  NodeFs.mkdirSync(dir, { recursive: true });
  NodeFs.writeFileSync(NodePath.join(dir, "runtime.js"), js);
  NodeFs.writeFileSync(NodePath.join(dir, "runtime.css"), css);
  return { root, dir };
}

function bundle(extra: Partial<Parameters<typeof writeCanvasBundle>[0]> = {}) {
  const out = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "a1-bundle-"));
  const manifest = writeCanvasBundle({
    outDir: out,
    html: "<!doctype html><html><head></head><body>x</body></html>",
    name: "Pinned",
    size: { width: 640, height: 440 },
    background: "transparent",
    stamp: STAMP,
    sourceFile: { name: "a.tsx", bytes: Buffer.from("export default () => null;") },
    ...extra,
  });
  const written = JSON.parse(NodeFs.readFileSync(NodePath.join(out, "manifest.json"), "utf8"));
  return { out, manifest, written };
}

test("runtime digest follows the contract: sha256 over the css and js digests", () => {
  const { dir } = runtimeRoot("JS", "CSS");
  const expected = sha(`runtime.css:${sha("CSS")}\nruntime.js:${sha("JS")}\n`);
  assert.equal(runtimeDigest(dir), expected);
});

test("the Canvas-installed runtime digest in the contract is reproduced by the rule", () => {
  // Reference value published in CONTRACT.md for nofun-canvas runtime 580e64f46a50.
  const css = "36ea8b4efaa31ea5fb8f2c80b88890cef097e566d8b65f8d5303a99c933b5f3d";
  const js = "37a7ca9b8cb29ef5a10e9c9d30d390e3c6c47709a88246156ff66957f17788f9";
  assert.equal(
    sha(`runtime.css:${css}\nruntime.js:${js}\n`),
    "8c0394e7bf16e136dae5109cb16d5effd39a2bea2bd6a77769a8296004c0d5db",
  );
});

test("a changed runtime byte changes the digest", () => {
  const a = runtimeRoot("JS", "CSS");
  const b = runtimeRoot("JS2", "CSS");
  assert.notEqual(runtimeDigest(a.dir), runtimeDigest(b.dir));
});

test("readRuntimePin refuses a missing runtime; findRuntimePin returns undefined", () => {
  const { root } = runtimeRoot();
  assert.throws(() => readRuntimePin("1234567890ab", root), /no built runtime/);
  assert.equal(findRuntimePin("1234567890ab", root), undefined);
  assert.deepEqual(findRuntimePin(VERSION, root), readRuntimePin(VERSION, root));
});

test("assertRuntimePin refuses uppercase, short and non-hex values", () => {
  assert.throws(() => assertRuntimePin({ version: "ABCDEF12", sha256: "a".repeat(64) }), /version/);
  assert.throws(() => assertRuntimePin({ version: "abc", sha256: "a".repeat(64) }), /version/);
  assert.throws(() => assertRuntimePin({ version: VERSION, sha256: "A".repeat(64) }), /sha256/);
  assert.throws(() => assertRuntimePin({ version: VERSION, sha256: "ab" }), /sha256/);
});

test("manifest carries runtime {version, sha256} when pinned, and nothing else changes", () => {
  const { root } = runtimeRoot();
  const pin = readRuntimePin(VERSION, root);
  const pinned = bundle({ runtime: pin, linked: VERSION });
  assert.deepEqual(pinned.written.runtime, { version: VERSION, sha256: pin.sha256 });
  assert.deepEqual(
    Object.keys(pinned.written).sort(),
    [...MANIFEST_KEYS, ...OPTIONAL_MANIFEST_KEYS].sort(),
  );
  const html = NodeFs.readFileSync(NodePath.join(pinned.out, "index.html"));
  assert.equal(pinned.written.sha256, sha(html));
  const plain = bundle();
  assert.equal("runtime" in plain.written, false);
  assert.deepEqual(Object.keys(plain.written).sort(), [...MANIFEST_KEYS].sort());
});

test("a runtime pin that disagrees with the linked runtime is refused", () => {
  const { root } = runtimeRoot();
  assert.throws(
    () => bundle({ runtime: readRuntimePin(VERSION, root), linked: "1234567890ab" }),
    /disagrees with the linked runtime/,
  );
});

test("a malformed pin never reaches the manifest", () => {
  assert.throws(
    () => bundle({ runtime: { version: "NOPE", sha256: "a".repeat(64) } }),
    /runtime version/,
  );
});

test("canvas-t3 preset neutralises T3's blue primary, ring, focus and info tone", () => {
  assert.ok(PRESETS["canvas-t3"].css.includes(NO_BLUE_T3_CSS));
  for (const name of ["--primary", "--ring", "--nf-focus", "--info"]) {
    assert.match(NO_BLUE_T3_CSS, new RegExp(`${name}:var\\(--`));
  }
  assert.doesNotMatch(NO_BLUE_T3_CSS, /#[0-9a-f]{3,6}|blue/i);
});
