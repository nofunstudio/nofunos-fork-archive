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
