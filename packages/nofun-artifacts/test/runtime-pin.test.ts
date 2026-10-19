import { spawnSync } from "node:child_process";
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
import { readStamp, type ArtifactStamp } from "../src/stamp.ts";
import { fileURLToPath } from "node:url";

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

const GOOD = { version: VERSION, sha256: "a".repeat(64) };

test("assertRuntimePin is strict: exact keys, string types, no coercion", () => {
  assert.deepEqual(assertRuntimePin(GOOD), GOOD);
  const bad: unknown[] = [
    null,
    undefined,
    "580e64f46a50",
    12345678,
    [],
    [GOOD.version, GOOD.sha256],
    {},
    { version: VERSION },
    { sha256: GOOD.sha256 },
    { ...GOOD, extra: 1 },
    { ...GOOD, extra: undefined },
    { version: 12345678, sha256: GOOD.sha256 },
    { version: 0, sha256: GOOD.sha256 },
    { version: "", sha256: GOOD.sha256 },
    { version: null, sha256: GOOD.sha256 },
    { version: ["580e64f46a50"], sha256: GOOD.sha256 },
    { version: new String(VERSION), sha256: GOOD.sha256 },
    { version: VERSION, sha256: null },
    { version: VERSION, sha256: 0 },
    { version: VERSION, sha256: "" },
    { version: VERSION, sha256: GOOD.sha256.toUpperCase() },
    { version: VERSION.toUpperCase(), sha256: GOOD.sha256 },
    Object.assign(Object.create({ inherited: 1 }), GOOD),
    new Map([["version", VERSION]]),
  ];
  for (const value of bad) {
    assert.throws(() => assertRuntimePin(value), /runtime/, JSON.stringify(value) ?? String(value));
  }
});

test("only the absence of runtime is unpinned: explicit null, undefined and falsy values are refused", () => {
  for (const value of [null, undefined, 0, "", false, NaN, {}]) {
    assert.throws(
      () => bundle({ runtime: value as never }),
      /runtime/,
      `runtime: ${String(value)}`,
    );
  }
  const { written } = bundle();
  assert.equal("runtime" in written, false);
});

test("a numeric version never reaches a manifest", () => {
  assert.throws(
    () => bundle({ runtime: { version: 12345678, sha256: "a".repeat(64) } as never }),
    /version must be a string/,
  );
});

test("canvas-t3 preset neutralises T3's blue primary, ring, focus and info tone", () => {
  assert.ok(PRESETS["canvas-t3"].css.includes(NO_BLUE_T3_CSS));
  for (const name of ["--primary", "--ring", "--nf-focus", "--info"]) {
    assert.match(NO_BLUE_T3_CSS, new RegExp(`${name}:var\\(--`));
  }
  assert.doesNotMatch(NO_BLUE_T3_CSS, /#[0-9a-f]{3,6}|blue/i);
});

// The entry meta, stamp.json and manifest.runtime must name the same runtime version: the hosts read
// `linked=<version>` from the entry meta (Canvas WebArtifactStamp, the Notes viewer) and refuse a
// pinned bundle whose meta lacks it.
function linkedPieces(out: string) {
  const html = NodeFs.readFileSync(NodePath.join(out, "index.html"), "utf8");
  const meta = /<meta name="nofun-artifact" content="([^"]*)">/.exec(html)?.[1] ?? "";
  const pieces = meta.split(";").filter((piece) => piece.startsWith("linked="));
  const stampJson = JSON.parse(NodeFs.readFileSync(NodePath.join(out, "stamp.json"), "utf8"));
  const manifest = JSON.parse(NodeFs.readFileSync(NodePath.join(out, "manifest.json"), "utf8"));
  return { meta, pieces, stampJson, manifest };
}

// The compiler's own linked page: a meta that already has linked= (what linked.ts emits).
const LINKED_PAGE = `<!doctype html><html><head><meta name="nofun-artifact" content="components=${VERSION};lane=spec;theme=t3;size=640x440;at=2026-10-19T00:00:00Z;linked=${VERSION}"></head><body>x</body></html>`;

test("a pinned bundle's entry meta carries linked=<version>, equal to stamp.json and manifest.runtime", () => {
  const { root } = runtimeRoot();
  const pin = readRuntimePin(VERSION, root);
  const { out, manifest } = bundle({ html: LINKED_PAGE, runtime: pin, linked: VERSION });
  const { meta, pieces, stampJson, manifest: written } = linkedPieces(out);
  assert.deepEqual(pieces, [`linked=${VERSION}`], meta);
  assert.equal(stampJson.linked, VERSION);
  assert.equal(written.runtime.version, VERSION);
  assert.equal(manifest.runtime?.version, VERSION);
  // The page still parses as a stamp and the entry digest covers the final bytes.
  assert.equal(readStamp(NodeFs.readFileSync(NodePath.join(out, "index.html"), "utf8"))?.components, STAMP.components);
  assert.equal(written.sha256, sha(NodeFs.readFileSync(NodePath.join(out, "index.html"))));
});

test("a linked bundle gets the meta piece even when the page had no stamp or an unlinked one", () => {
  for (const html of [
    "<!doctype html><html><head></head><body>x</body></html>",
    `<!doctype html><html><head><meta name="nofun-artifact" content="components=${VERSION};lane=spec;theme=t3;at=2026-10-19T00:00:00Z"></head><body>x</body></html>`,
  ]) {
    const { root } = runtimeRoot();
    const { out } = bundle({ html, runtime: readRuntimePin(VERSION, root), linked: VERSION.toUpperCase() });
    assert.deepEqual(linkedPieces(out).pieces, [`linked=${VERSION}`]);
  }
});

test("an unlinked bundle has no linked piece, and a runtime pin without a linked page is refused", () => {
  const plain = bundle();
  assert.deepEqual(linkedPieces(plain.out).pieces, []);
  assert.equal("linked" in linkedPieces(plain.out).stampJson, false);
  const { root } = runtimeRoot();
  assert.throws(() => bundle({ runtime: readRuntimePin(VERSION, root) }), /needs a linked page/);
  assert.throws(() => bundle({ linked: "" }), /linked runtime/);
  assert.throws(() => bundle({ linked: "not hex!" }), /linked runtime/);
});

// End to end through the CLI: needs a clean nofun-components checkout at the pinned revision
// (NOFUN_COMPONENTS_DIR), which CI does not have, so it only runs where one is provided.
test(
  "compile --linked on a spec card: entry meta, stamp.json and manifest.runtime agree",
  { skip: process.env.NOFUN_COMPONENTS_DIR ? false : "set NOFUN_COMPONENTS_DIR to a pinned components checkout" },
  () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { root } = runtimeRoot("window.NoFunUI={}", "body{}");
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "a16-spec-"));
    const spec = NodePath.join(dir, "card.spec.json");
    NodeFs.writeFileSync(
      spec,
      JSON.stringify({
        title: "Gate progress",
        root: { component: "Text", props: { text: "5/16 gates", variant: "title" } },
      }),
    );
    const out = NodePath.join(dir, "out");
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "compile", "--spec", spec, "--preset", "canvas-t3",
        "--linked", "--runtime-sha", VERSION, "--out", out],
      { encoding: "utf8", env: { ...process.env, NOFUN_UI_RUNTIME_ROOT: root } },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { meta, pieces, stampJson, manifest } = linkedPieces(out);
    assert.deepEqual(pieces, [`linked=${VERSION}`], meta);
    assert.equal(stampJson.linked, VERSION);
    assert.equal(manifest.runtime.version, VERSION);
    assert.equal(manifest.runtime.sha256, readRuntimePin(VERSION, root).sha256);
    assert.equal(manifest.sha256, sha(NodeFs.readFileSync(NodePath.join(out, "index.html"))));
  },
);
