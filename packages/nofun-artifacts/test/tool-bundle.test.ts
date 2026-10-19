import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { MANIFEST_KEYS } from "../src/canvas-bundle.ts";
import { readRuntimePin, runtimeRoot } from "../src/runtime-pin.ts";
import { componentsDir } from "../src/live/source.ts";
import { stampInstant } from "../src/stamp.ts";
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
