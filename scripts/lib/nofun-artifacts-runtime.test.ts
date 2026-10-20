import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const runtimeSource = NodeFS.readFileSync(
  NodePath.join(repoRoot, "scripts/lib/nofun-artifacts-runtime.ts"),
  "utf8",
);

const isSourceFile = (fileName: string): boolean =>
  !fileName.includes(".test.") && !fileName.includes(".spec.");

/** Every `@t3tools/nofun-artifacts/<subpath>` imported outside test/spec files. */
const findImportedSubpaths = (directory: string): Set<string> => {
  const found = new Set<string>();
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const subpath of findImportedSubpaths(fullPath)) {
        found.add(subpath);
      }
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      const content = NodeFS.readFileSync(fullPath, "utf8");
      for (const match of content.matchAll(/@t3tools\/nofun-artifacts\/([A-Za-z0-9_-]+)/g)) {
        found.add(match[1]);
      }
    }
  }
  return found;
};

describe("prebuildNofunArtifactsRuntime exports", () => {
  it("prebuilds and exports the tool-bundle entry used by the packaged server", () => {
    assert.include(runtimeSource, '"tool-bundle": NodePath.join(packageDir, "src/tool-bundle.ts")');
    assert.include(runtimeSource, '"./tool-bundle": "./src/live/tool-bundle.mjs"');
  });

  it("covers every nofun-artifacts subpath imported by the packaged server/desktop", () => {
    const imported = new Set<string>();
    for (const appDir of ["apps/server/src", "apps/desktop/src"]) {
      for (const subpath of findImportedSubpaths(NodePath.join(repoRoot, appDir))) {
        imported.add(subpath);
      }
    }
    assert.isNotEmpty([...imported]);
    for (const subpath of [...imported].sort()) {
      assert.include(
        runtimeSource,
        `"./${subpath}": "./src/live/${subpath}.mjs"`,
        `packaged runtime must export @t3tools/nofun-artifacts/${subpath}`,
      );
    }
  });
});
