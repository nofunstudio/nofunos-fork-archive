import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { bundle } from "../src/live/bundle.ts";
import type { LiveIndex } from "../src/live/registry.ts";

/**
 * The chat-list demo chain: `demo.tsx` imports `./experiment-mrch`, which
 * imports `./experiment-mrch-model` with no extension; only
 * `experiment-mrch-model.mjs` exists. esbuild's default resolver never tries
 * `.mjs`, so without the extensionless fallback the demo fails to bundle and
 * is excluded from the runtime bundle and the compile report.
 */
function fixtureDir(): { dir: string; index: LiveIndex } {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-ext-mjs-"));
  const block = NodePath.join(dir, "blocks", "ai", "chat-list");
  NodeFs.mkdirSync(block, { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(block, "chat-list.tsx"),
    `import * as React from "react";\nexport function ChatList() { return <ul />; }\n`,
  );
  NodeFs.writeFileSync(
    NodePath.join(block, "experiment-mrch.tsx"),
    `import { BASELINE } from "./experiment-mrch-model";\nexport function MrchExperiment() { return <div>{BASELINE}</div>; }\n`,
  );
  NodeFs.writeFileSync(
    NodePath.join(block, "experiment-mrch-model.mjs"),
    `export const BASELINE = "baseline";\nexport const mapExperimentRows = (r) => r;\nexport const resolveArm = () => BASELINE;\n`,
  );
  NodeFs.writeFileSync(
    NodePath.join(block, "demo.tsx"),
    `import { ChatList } from "./chat-list";\nimport { MrchExperiment } from "./experiment-mrch";\nexport function ChatListDemo() { return <div><ChatList /><MrchExperiment /></div>; }\n`,
  );
  NodeFs.symlinkSync(
    NodePath.join(process.cwd(), "node_modules"),
    NodePath.join(dir, "node_modules"),
  );
  const index = {
    dir,
    stamp: "test",
    entries: [],
    byName: new Map(),
    files: new Map([["chat-list", { file: "blocks/ai/chat-list/chat-list.tsx", category: "ai" }]]),
    brands: [],
  } as unknown as LiveIndex;
  return { dir, index };
}

test("extensionless relative import resolves a sibling .mjs file", async () => {
  const { dir, index } = fixtureDir();
  try {
    const built = await bundle(dir, index, {
      entry: `import * as m from "@nofun/ui/chat-list/demo";\n(globalThis).__nf = m;`,
      minify: false,
    });
    assert.match(built.js, /baseline/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Minimal scratch dir for resolver-order tests: plain files plus a
 * node_modules link, with an empty component index since entries import
 * absolute file paths directly (the same shape as the review repros).
 */
function scratchDir(): { dir: string; index: LiveIndex } {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-ext-order-"));
  NodeFs.symlinkSync(
    NodePath.join(process.cwd(), "node_modules"),
    NodePath.join(dir, "node_modules"),
  );
  const index = {
    dir,
    stamp: "test",
    entries: [],
    byName: new Map(),
    files: new Map(),
    brands: [],
  } as unknown as LiveIndex;
  return { dir, index };
}

async function bundleEntry(dir: string, index: LiveIndex, name: string) {
  return bundle(dir, index, {
    entry: `import ${JSON.stringify(NodePath.join(dir, name))};\n`,
    minify: false,
  });
}

test("directory index still wins over a sibling .mjs file", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.mkdirSync(NodePath.join(dir, "foo"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(dir, "foo", "index.ts"), `export default "INDEX";\n`);
    NodeFs.writeFileSync(NodePath.join(dir, "foo.mjs"), `export default "MJS";\n`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo";\n(globalThis as any).__rv = x;\n`,
    );
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.match(built.js, /INDEX/);
    assert.doesNotMatch(built.js, /MJS/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trailing-slash directory import still resolves the index", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.mkdirSync(NodePath.join(dir, "foo"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(dir, "foo", "index.ts"), `export default "INDEX";\n`);
    NodeFs.writeFileSync(NodePath.join(dir, "foo", ".ts"), `export default "HIDDEN";\n`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo/";\n(globalThis as any).__rv = x;\n`,
    );
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.match(built.js, /INDEX/);
    assert.doesNotMatch(built.js, /HIDDEN/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exact extensionless file still wins over a sibling .ts file", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.writeFileSync(NodePath.join(dir, "foo"), `export default "EXACT";\n`);
    NodeFs.writeFileSync(NodePath.join(dir, "foo.ts"), `export default "TS";\n`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo";\n(globalThis as any).__rv = x;\n`,
    );
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.match(built.js, /EXACT/);
    assert.doesNotMatch(built.js, /"TS"/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("side-effect import still resolves the .css target", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.writeFileSync(NodePath.join(dir, "foo.css"), `.foo { color: red; }\n`);
    NodeFs.writeFileSync(NodePath.join(dir, "foo.json"), `{"a": 1}\n`);
    NodeFs.writeFileSync(NodePath.join(dir, "entry.ts"), `import "./foo";\n`);
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.deepEqual(built.cssImports, [NodeFs.realpathSync(NodePath.join(dir, "foo.css"))]);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("symlinked .ts candidate still wins over a sibling .mjs file", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.writeFileSync(NodePath.join(dir, "target.ts"), `export default "TS";\n`);
    NodeFs.symlinkSync(NodePath.join(dir, "target.ts"), NodePath.join(dir, "foo.ts"));
    NodeFs.writeFileSync(NodePath.join(dir, "foo.mjs"), `export default "MJS";\n`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo";\n(globalThis as any).__rv = x;\n`,
    );
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.match(built.js, /"TS"/);
    assert.doesNotMatch(built.js, /"MJS"/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("symlinked .mjs-only target resolves through the fallback", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.writeFileSync(NodePath.join(dir, "target.mjs"), `export default "LINKED-MJS";\n`);
    NodeFs.symlinkSync(NodePath.join(dir, "target.mjs"), NodePath.join(dir, "foo.mjs"));
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo";\n(globalThis as any).__rv = x;\n`,
    );
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.match(built.js, /LINKED-MJS/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json browser:false mapping still disables the module", async () => {
  const { dir, index } = scratchDir();
  try {
    NodeFs.writeFileSync(
      NodePath.join(dir, "package.json"),
      `${JSON.stringify({ browser: { "./foo.ts": false } })}\n`,
    );
    NodeFs.writeFileSync(NodePath.join(dir, "foo.ts"), `export default "SHOULD-BE-DISABLED";\n`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `import x from "./foo";\n(globalThis as any).__rv = x;\n`,
    );
    // esbuild natively resolves ./foo to foo.ts and then applies the
    // browser:false mapping, emitting an empty disabled module. Returning a
    // probed path instead would lose that disabled-module state and fail.
    const built = await bundleEntry(dir, index, "entry.ts");
    assert.doesNotMatch(built.js, /SHOULD-BE-DISABLED/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("50 extensionless imports stay close to explicit-extension time", async () => {
  const { dir, index } = scratchDir();
  try {
    const count = 50;
    for (let i = 0; i < count; i++) {
      NodeFs.writeFileSync(NodePath.join(dir, `f${i}.ts`), `export const n${i} = ${i};\n`);
    }
    const names = Array.from({ length: count }, (_, i) => `n${i}`);
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry.ts"),
      `${names.map((n, i) => `import { ${n} } from "./f${i}";`).join("\n")}\n(globalThis as any).__rv = ${names.join(" + ")};\n`,
    );
    NodeFs.writeFileSync(
      NodePath.join(dir, "entry-explicit.ts"),
      `${names.map((n, i) => `import { ${n} } from "./f${i}.ts";`).join("\n")}\n(globalThis as any).__rv = ${names.join(" + ")};\n`,
    );
    // Warm up the esbuild service so startup cost does not skew either side.
    await bundleEntry(dir, index, "entry-explicit.ts");
    async function medianMs(name: string): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await bundleEntry(dir, index, name);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[1]!;
    }
    const explicit = await medianMs("entry-explicit.ts");
    const extensionless = await medianMs("entry.ts");
    // An extra build.resolve round trip per import made this ~19x slower
    // (about 1.2 s vs 62-78 ms); the sync stat fallback must stay near par.
    assert.ok(
      extensionless <= explicit * 4,
      `extensionless imports took ${extensionless.toFixed(1)} ms vs ${explicit.toFixed(1)} ms explicit`,
    );
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extensionless relative import still prefers the builder's existing targets", async () => {
  const { dir, index } = fixtureDir();
  try {
    // A sibling pair where esbuild already resolves the .ts file: the fallback
    // must not steal it for the .mjs file.
    const block = NodePath.join(dir, "blocks", "ai", "chat-list");
    NodeFs.writeFileSync(NodePath.join(block, "pair.ts"), `export const which = "ts";\n`);
    NodeFs.writeFileSync(NodePath.join(block, "pair.mjs"), `export const which = "mjs";\n`);
    NodeFs.writeFileSync(
      NodePath.join(block, "demo-pair.tsx"),
      `import { which } from "./pair";\nexport const result = which;\n`,
    );
    const built = await bundle(dir, index, {
      entry: `import { result } from "@nofun/ui/chat-list/demo-pair";\n(globalThis).__nf = result;`,
      minify: false,
    });
    assert.match(built.js, /which = "ts"/);
    assert.doesNotMatch(built.js, /which = "mjs"/);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
