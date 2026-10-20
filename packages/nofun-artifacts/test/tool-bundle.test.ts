import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { MANIFEST_KEYS, stripNetworkUrls, writeCanvasBundle } from "../src/canvas-bundle.ts";
import { readRuntimePin, runtimeRoot } from "../src/runtime-pin.ts";
import { componentsDir } from "../src/live/source.ts";
import { runtimeDigest } from "../src/runtime-pin.ts";
import { stampInstant, type ArtifactStamp } from "../src/stamp.ts";
import { emitToolBundle } from "../src/tool-bundle.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SPEC = { root: { component: "Text", props: { variant: "title", text: "Hello" } } };

const tmp = (prefix: string) => NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));

test("emitToolBundle refuses a runtime that is not built, before writing anything", async () => {
  const root = tmp("nf-noruntime-");
  try {
    await assert.rejects(
      emitToolBundle({
        spec: SPEC,
        title: "Hi",
        outRoot: NodePath.join(root, "out"),
        runtimeRoot: root,
        runtimeVersion: "580e64f46a50",
      }),
      /no built runtime at/,
    );
    assert.equal(NodeFs.existsSync(NodePath.join(root, "out")), false);
  } finally {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitToolBundle validates its inputs", async () => {
  const root = tmp("nf-badinput-");
  try {
    await assert.rejects(
      emitToolBundle({ title: "x", outRoot: root, runtimeVersion: "580e64f46a50" }),
      /exactly one of/,
    );
    await assert.rejects(
      emitToolBundle({ spec: SPEC, title: "x", outRoot: root, size: "10x10" }),
      /width must be an integer from 16 to 4096/,
    );
    await assert.rejects(
      emitToolBundle({ spec: SPEC, title: "x", outRoot: root, background: "blue" }),
      /background must be transparent, match, or #rrggbb/,
    );
  } finally {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("compile rejects --build-time without --linked", () => {
  const run = spawnSync(
    process.execPath,
    [
      CLI,
      "compile",
      "--spec",
      "x.json",
      "--theme",
      "kobra",
      "--size",
      "640x480",
      "--out",
      "o",
      "--build-time",
      "now",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--build-time needs --linked/);
});

test("stampInstant drops fractional seconds", () => {
  assert.equal(stampInstant(new Date("2026-10-19T20:31:42.987Z")), "2026-10-19T20:31:42Z");
});

// Needs a real components checkout (NOFUN_COMPONENTS_DIR) and a built runtime (NOFUN_UI_RUNTIME_ROOT
// holding NOFUN_UI_RUNTIME_VERSION/); skipped where they are absent.
const version = process.env.NOFUN_UI_RUNTIME_VERSION;
const canRun =
  version !== undefined &&
  NodeFs.existsSync(NodePath.join(runtimeRoot(), version, "runtime.js")) &&
  NodeFs.existsSync(NodePath.join(componentsDir(), "registry.json"));

test("emitToolBundle writes a pinned bundle with a real timestamp", { skip: !canRun }, async () => {
  const out = tmp("nf-toolbundle-");
  try {
    const before = Date.now();
    const bundle = await emitToolBundle({
      spec: SPEC,
      title: "Hello pulse",
      outRoot: out,
      size: "800x500",
    });
    const dir = bundle.dir;
    const manifest = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), [...MANIFEST_KEYS, "runtime"].sort());
    assert.deepEqual(manifest.runtime, readRuntimePin(version!));
    assert.equal(
      manifest.sha256,
      createHash("sha256")
        .update(NodeFs.readFileSync(NodePath.join(dir, "index.html")))
        .digest("hex"),
    );
    assert.deepEqual(manifest.size, { width: 800, height: 500 });
    assert.ok(Math.abs(Date.parse(manifest.createdAt) - before) < 60_000, manifest.createdAt);
    const stamp = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "stamp.json"), "utf8"));
    assert.equal(stamp.linked, version);
    assert.equal(stamp.at, manifest.createdAt);
    const html = NodeFs.readFileSync(NodePath.join(dir, "index.html"), "utf8");
    assert.equal(/https?:\/\//i.test(html), false);
    assert.ok(html.includes(`nofun-ui://runtime/${version}/runtime.js`));
    assert.ok(NodeFs.existsSync(NodePath.join(dir, "source", "artifact.spec.json")));
  } finally {
    NodeFs.rmSync(out, { recursive: true, force: true });
  }
});

const decodeSlash = (text: string) => text.replaceAll("&#47;", "/");

test("stripNetworkUrls keeps HTML text and attributes readable and escapes only script and style bodies", () => {
  const html =
    '<html><head><title>Docs https://example.test/a</title><link rel="x" href="http://example.test/h"></head>' +
    '<body data-u="https://example.test/b">See HTTP://Example.test here' +
    '<script>const ns="http://www.w3.org/2000/svg";</script>' +
    '<script type="application/json" id="d">{"u":"https://example.test/j"}</script>' +
    "<style>.a{background:url(https://example.test/i.png)}</style></body></html>";
  const out = stripNetworkUrls(html);
  assert.equal(/https?:\/\//i.test(out), false);
  assert.ok(out.includes("<title>Docs https:&#47;&#47;example.test/a</title>"));
  assert.ok(out.includes('href="http:&#47;&#47;example.test/h"'));
  assert.ok(out.includes("See HTTP:&#47;&#47;Example.test here"));
  const script = /<script>([^<]*)<\/script>/.exec(out)![1]!;
  assert.equal(Function(`${script};return ns`)(), "http://www.w3.org/2000/svg");
  const json = /<script type="application\/json" id="d">([^<]*)<\/script>/.exec(out)![1]!;
  assert.equal(JSON.parse(json).u, "https://example.test/j");
  assert.ok(out.includes("url(https:\\/\\/example.test/i.png)"));
  // Decoding the character references gives back the original markup outside script and style.
  assert.equal(
    decodeSlash(out.slice(0, out.indexOf("<script>"))),
    html.slice(0, html.indexOf("<script>")),
  );
});

test("a URL in the artifact title is written to <title> unchanged in meaning, and the manifest still hashes the entry", () => {
  const out = tmp("nf-title-");
  const stamp: ArtifactStamp = {
    components: "8922135e5cdf4d172be6e0eaeffa73009b6a5257",
    compiler: "0.0.0",
    lane: "spec",
    theme: "kobra",
    at: "2026-10-19T20:30:00Z",
  };
  try {
    const manifest = writeCanvasBundle({
      outDir: out,
      html: "<!doctype html><html><head><title>Docs https://example.test</title></head><body></body></html>",
      name: "Docs https://example.test",
      size: { width: 640, height: 480 },
      background: "transparent",
      stamp,
      sourceFile: { name: "a.json", bytes: Buffer.from("{}") },
    });
    const html = NodeFs.readFileSync(NodePath.join(out, "index.html"), "utf8");
    assert.ok(html.includes("<title>Docs https:&#47;&#47;example.test</title>"));
    assert.equal(html.includes("\\u002f"), false);
    assert.equal(manifest.name, "Docs https://example.test");
    assert.equal(manifest.sha256, createHash("sha256").update(html).digest("hex"));
  } finally {
    NodeFs.rmSync(out, { recursive: true, force: true });
  }
});

// The compile must read module and CSS facts from the same runtime root the pin was read from, not from
// package dist. Needs a components checkout for the compiler; the runtime itself is a tiny fake.
const canCompile = NodeFs.existsSync(NodePath.join(componentsDir(), "registry.json"));

test(
  "emitToolBundle validates imports against the pinned root's manifest",
  { skip: !canCompile },
  async () => {
    const root = tmp("nf-root-");
    const out = tmp("nf-root-out-");
    try {
      const version = "0123456789ab";
      const dir = NodePath.join(root, version);
      NodeFs.mkdirSync(dir, { recursive: true });
      NodeFs.writeFileSync(NodePath.join(dir, "runtime.css"), "body{margin:0}\n");
      NodeFs.writeFileSync(NodePath.join(dir, "runtime.js"), "window.NoFunUI={};\n");
      NodeFs.writeFileSync(
        NodePath.join(dir, "manifest.json"),
        JSON.stringify({ modules: ["react", "react/jsx-runtime", "@nofun/ui/present-block"] }),
      );
      const tsx = (name: string) =>
        `import { Block } from "@nofun/ui/${name}"; export default function App(){ return <Block/>; }\n`;
      await assert.rejects(
        emitToolBundle({
          tsx: tsx("absent-block"),
          title: "Absent",
          outRoot: out,
          runtimeRoot: root,
          runtimeVersion: version,
        }),
        /"@nofun\/ui\/absent-block" is not in this runtime/,
      );
      const ok = await emitToolBundle({
        tsx: tsx("present-block"),
        title: "Present",
        outRoot: out,
        runtimeRoot: root,
        runtimeVersion: version,
      });
      assert.equal(ok.runtime.version, version);
      assert.equal(ok.runtime.sha256, runtimeDigest(dir));
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true });
      NodeFs.rmSync(out, { recursive: true, force: true });
    }
  },
);

// The effective theme is `input.theme ?? spec.theme`, as in compileArtifact. A tiny fake runtime is enough.
async function bundleTheme(spec: unknown, theme: string | undefined): Promise<string> {
  const root = tmp("nf-theme-root-");
  const out = tmp("nf-theme-out-");
  try {
    const version = "0123456789ab";
    const dir = NodePath.join(root, version);
    NodeFs.mkdirSync(dir, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(dir, "runtime.css"), "body{margin:0}\n");
    NodeFs.writeFileSync(NodePath.join(dir, "runtime.js"), "window.NoFunUI={};\n");
    NodeFs.writeFileSync(NodePath.join(dir, "manifest.json"), JSON.stringify({ modules: [] }));
    const bundle = await emitToolBundle({
      spec,
      theme,
      title: "Theme parity",
      outRoot: out,
      runtimeRoot: root,
      runtimeVersion: version,
    });
    const stamp = JSON.parse(NodeFs.readFileSync(NodePath.join(bundle.dir, "stamp.json"), "utf8"));
    const html = NodeFs.readFileSync(NodePath.join(bundle.dir, "index.html"), "utf8");
    assert.ok(html.includes(`data-nf-theme="${stamp.theme}"`));
    return stamp.theme;
  } finally {
    NodeFs.rmSync(root, { recursive: true, force: true });
    NodeFs.rmSync(out, { recursive: true, force: true });
  }
}

test(
  "emitToolBundle uses the spec's theme when no top-level theme is given",
  { skip: !canCompile },
  async () => {
    assert.equal(await bundleTheme({ theme: "t3", ...SPEC }, undefined), "t3");
  },
);

test(
  "emitToolBundle lets an explicit top-level theme win over the spec's theme",
  { skip: !canCompile },
  async () => {
    assert.equal(await bundleTheme({ theme: "t3", ...SPEC }, "kobra"), "kobra");
  },
);
