import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { prebuildNofunArtifactsRuntime } from "./nofun-artifacts-runtime.ts";

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

describe("prebuildNofunArtifactsRuntime staged tool-bundle runtime", () => {
  it("stages the pinned UI runtime where the built bundle resolves it", async () => {
    const packageDir = NodePath.join(repoRoot, "packages/nofun-artifacts");
    const pin = NodeFS.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
      .trim()
      .split(/\s+/)[0]!
      .toLowerCase();
    const version = pin.slice(0, 12);
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    const savedEnv = {
      NOFUN_UI_RUNTIME_ROOT: process.env.NOFUN_UI_RUNTIME_ROOT,
      NOFUN_UI_RUNTIME_VERSION: process.env.NOFUN_UI_RUNTIME_VERSION,
      NOFUN_COMPONENTS_DIR: process.env.NOFUN_COMPONENTS_DIR,
    };
    try {
      // A hermetic repo root: the real sources plus a small fixture runtime, so the test
      // never touches the (gitignored, usually absent) dist/ of the working tree.
      const fakePkg = NodePath.join(scratch, "repo", "packages", "nofun-artifacts");
      NodeFS.mkdirSync(fakePkg, { recursive: true });
      for (const name of ["package.json", "components.pin"]) {
        NodeFS.copyFileSync(NodePath.join(packageDir, name), NodePath.join(fakePkg, name));
      }
      for (const name of ["src", "fonts", "generated"]) {
        NodeFS.cpSync(NodePath.join(packageDir, name), NodePath.join(fakePkg, name), {
          recursive: true,
        });
      }
      NodeFS.symlinkSync(
        NodePath.join(packageDir, "node_modules"),
        NodePath.join(fakePkg, "node_modules"),
      );
      const fixtureDir = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", version);
      NodeFS.mkdirSync(NodePath.join(fixtureDir, "brands"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(fixtureDir, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(fixtureDir, "runtime.css"), "body{}\n");
      NodeFS.writeFileSync(
        NodePath.join(fixtureDir, "manifest.json"),
        `${JSON.stringify({ version, sha256: "0".repeat(64), modules: [] })}\n`,
      );
      NodeFS.writeFileSync(NodePath.join(fixtureDir, "brands", "t3.css"), "body{}\n");

      const outDir = NodePath.join(scratch, "staged");
      await prebuildNofunArtifactsRuntime({
        repoRoot: NodePath.join(scratch, "repo"),
        outDir,
      });
      for (const name of ["runtime.js", "runtime.css", "manifest.json"]) {
        assert.isTrue(
          NodeFS.statSync(NodePath.join(outDir, "dist", "nofun-ui-runtime", version, name), {
            throwIfNoEntry: false,
          })?.isFile() === true,
          `staged package must carry dist/nofun-ui-runtime/${version}/${name}`,
        );
      }
      assert.isTrue(
        NodeFS.statSync(
          NodePath.join(outDir, "dist", "nofun-ui-runtime", version, "brands", "t3.css"),
          { throwIfNoEntry: false },
        )?.isFile() === true,
        `staged package must carry dist/nofun-ui-runtime/${version}/brands/t3.css`,
      );

      // The bundle's bare esbuild import resolves like the installed staged package's does.
      NodeFS.symlinkSync(
        NodePath.join(packageDir, "node_modules"),
        NodePath.join(outDir, "node_modules"),
      );
      delete process.env.NOFUN_UI_RUNTIME_ROOT;
      delete process.env.NOFUN_UI_RUNTIME_VERSION;
      process.env.NOFUN_COMPONENTS_DIR = NodePath.join(scratch, "no-checkout");
      const built = (await import(
        NodeURL.pathToFileURL(NodePath.join(outDir, "src", "live", "tool-bundle.mjs")).href
      )) as {
        defaultRuntimeVersion: () => string;
        emitToolBundle: (input: Record<string, unknown>) => Promise<unknown>;
      };
      assert.equal(built.defaultRuntimeVersion(), version);
      // Runtime resolution must succeed from the bundled src/live/ location: with no
      // components checkout the failure has to come from there, not from the runtime.
      const bundleOut = NodePath.join(scratch, "bundles");
      let error: unknown;
      try {
        await built.emitToolBundle({
          title: "Hi",
          outRoot: bundleOut,
          tsx: "export default function Artifact() { return null; }",
          runtimeVersion: version,
        });
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, Error);
      assert.notMatch((error as Error).message, /no built runtime/);
      assert.match((error as Error).message, /nofun-components checkout/);
      assert.isFalse(NodeFS.existsSync(bundleOut));
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
