import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import {
  MISSION_RUNTIMES,
  MISSION_RUNTIME_VERSIONS,
  missionRuntimeDigest,
  prebuildNofunArtifactsRuntime,
} from "./nofun-artifacts-runtime.ts";

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

/** A small canonical-source fixture: the full directory a publisher would ship. */
const writeMissionFixture = (root: string, version: string, js: string, css: string): string => {
  const dir = NodePath.join(root, version);
  NodeFS.mkdirSync(NodePath.join(dir, "brands"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "runtime.js"), js);
  NodeFS.writeFileSync(NodePath.join(dir, "runtime.css"), css);
  NodeFS.writeFileSync(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify({ version, sha256: "0".repeat(64), modules: [] })}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(dir, "brands", "t3.css"), "body{}\n");
  return dir;
};

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
      // Mission runtimes come from the canonical source, never the local dist build.
      const missionRoot = NodePath.join(scratch, "mission");
      const missionPins = MISSION_RUNTIME_VERSIONS.map((staged) => {
        const dir = writeMissionFixture(missionRoot, staged, "window.NoFunUI={};\n", "body{}\n");
        return { version: staged, sha256: missionRuntimeDigest(dir) };
      });

      const outDir = NodePath.join(scratch, "staged");
      await prebuildNofunArtifactsRuntime({
        repoRoot: NodePath.join(scratch, "repo"),
        outDir,
        missionRuntimes: missionPins,
        missionRuntimeRoot: missionRoot,
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

  it("stages the mission pin runtime(s) beside the components.pin one", async () => {
    assert.isNotEmpty(MISSION_RUNTIME_VERSIONS);
    const packageDir = NodePath.join(repoRoot, "packages/nofun-artifacts");
    const pin = NodeFS.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
      .trim()
      .split(/\s+/)[0]!
      .toLowerCase();
    const versions = [pin.slice(0, 12), ...MISSION_RUNTIME_VERSIONS];
    assert.isTrue(new Set(versions).size === versions.length, "mission pins must add versions");
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    const savedEnv = {
      NOFUN_UI_RUNTIME_ROOT: process.env.NOFUN_UI_RUNTIME_ROOT,
      NOFUN_UI_RUNTIME_VERSION: process.env.NOFUN_UI_RUNTIME_VERSION,
      NOFUN_COMPONENTS_DIR: process.env.NOFUN_COMPONENTS_DIR,
    };
    try {
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
      const pinFixtureDir = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", versions[0]!);
      NodeFS.mkdirSync(NodePath.join(pinFixtureDir, "brands"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(pinFixtureDir, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(pinFixtureDir, "runtime.css"), "body{}\n");
      NodeFS.writeFileSync(
        NodePath.join(pinFixtureDir, "manifest.json"),
        `${JSON.stringify({ version: versions[0], sha256: "0".repeat(64), modules: [] })}\n`,
      );
      NodeFS.writeFileSync(NodePath.join(pinFixtureDir, "brands", "t3.css"), "body{}\n");
      // A dist copy of a mission version must NOT satisfy staging: only the canonical
      // source counts, so the stale local rebuild planted here stays unused.
      for (const version of MISSION_RUNTIME_VERSIONS) {
        const stale = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", version);
        NodeFS.mkdirSync(NodePath.join(stale, "brands"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(stale, "runtime.js"), "window.NoFunUI={stale:true};\n");
        NodeFS.writeFileSync(NodePath.join(stale, "runtime.css"), "body{stale:true}\n");
      }
      const missionRoot = NodePath.join(scratch, "mission");
      const missionPins = MISSION_RUNTIME_VERSIONS.map((staged) => {
        const dir = writeMissionFixture(missionRoot, staged, "window.NoFunUI={};\n", "body{}\n");
        return { version: staged, sha256: missionRuntimeDigest(dir) };
      });

      const outDir = NodePath.join(scratch, "staged");
      await prebuildNofunArtifactsRuntime({
        repoRoot: NodePath.join(scratch, "repo"),
        outDir,
        missionRuntimes: missionPins,
        missionRuntimeRoot: missionRoot,
      });
      for (const version of versions) {
        for (const name of ["runtime.js", "runtime.css", "manifest.json"]) {
          assert.isTrue(
            NodeFS.statSync(NodePath.join(outDir, "dist", "nofun-ui-runtime", version, name), {
              throwIfNoEntry: false,
            })?.isFile() === true,
            `staged package must carry dist/nofun-ui-runtime/${version}/${name}`,
          );
        }
      }
      // Mission bytes come from the canonical source byte-for-byte, not the stale dist copy.
      for (const version of MISSION_RUNTIME_VERSIONS) {
        for (const name of ["runtime.js", "runtime.css", "manifest.json", "brands/t3.css"]) {
          const staged = NodeFS.readFileSync(
            NodePath.join(outDir, "dist", "nofun-ui-runtime", version, name),
          );
          const canonical = NodeFS.readFileSync(NodePath.join(missionRoot, version, name));
          assert.isTrue(
            staged.equals(canonical),
            `staged ${version}/${name} must equal the canonical source bytes`,
          );
        }
        assert.notInclude(
          NodeFS.readFileSync(
            NodePath.join(outDir, "dist", "nofun-ui-runtime", version, "runtime.js"),
            "utf8",
          ),
          "stale",
        );
      }

      // The staged bundle resolves the mission pin with no NOFUN_UI_RUNTIME_ROOT set: with no
      // components checkout the failure has to come from there, not from the runtime lookup.
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
        emitToolBundle: (input: Record<string, unknown>) => Promise<unknown>;
      };
      for (const version of MISSION_RUNTIME_VERSIONS) {
        const bundleOut = NodePath.join(scratch, `bundles-${version}`);
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
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails closed naming the missing canonical source when a mission pin is absent", async () => {
    const packageDir = NodePath.join(repoRoot, "packages/nofun-artifacts");
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    try {
      const fakePkg = NodePath.join(scratch, "repo", "packages", "nofun-artifacts");
      NodeFS.mkdirSync(fakePkg, { recursive: true });
      for (const name of ["package.json", "components.pin"]) {
        NodeFS.copyFileSync(NodePath.join(packageDir, name), NodePath.join(fakePkg, name));
      }
      for (const name of ["src", "fonts", "generated"]) {
        NodeFS.mkdirSync(NodePath.join(fakePkg, name), { recursive: true });
      }
      // The components.pin runtime is built; only the mission canonical source is missing.
      // A dist copy of the mission version must NOT satisfy staging on its own.
      const pin = NodeFS.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
        .trim()
        .split(/\s+/)[0]!
        .toLowerCase()
        .slice(0, 12);
      const present = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", pin);
      NodeFS.mkdirSync(present, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(present, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(present, "runtime.css"), "body{}\n");
      const missionVersion = MISSION_RUNTIME_VERSIONS[0]!;
      const distMission = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", missionVersion);
      NodeFS.mkdirSync(distMission, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(distMission, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(distMission, "runtime.css"), "body{}\n");
      let error: unknown;
      try {
        await prebuildNofunArtifactsRuntime({
          repoRoot: NodePath.join(scratch, "repo"),
          outDir: NodePath.join(scratch, "staged"),
          missionRuntimeRoot: NodePath.join(scratch, "empty-mission"),
        });
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, Error);
      assert.include((error as Error).message, `no canonical mission runtime at `);
      assert.include((error as Error).message, missionVersion);
      assert.include((error as Error).message, "NOFUN_MISSION_RUNTIME_ROOT");
      assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "staged", "package.json")));
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("prebuildNofunArtifactsRuntime mission digest gate", () => {
  it("pins the canonical mission runtime the hosts admit", () => {
    assert.deepEqual(
      [...MISSION_RUNTIMES],
      [
        {
          version: "580e64f46a50",
          sha256: "8c0394e7bf16e136dae5109cb16d5effd39a2bea2bd6a77769a8296004c0d5db",
        },
      ],
    );
    assert.deepEqual([...MISSION_RUNTIME_VERSIONS], ["580e64f46a50"]);
  });

  it("uses the same digest rule as the artifact package runtime pin", async () => {
    // Mirrors packages/nofun-artifacts/src/runtime-pin.ts:48-60 without importing across
    // the scripts project boundary: sha256 over the css and js file digests. Dynamic import
    // keeps the scripts project's node-builtin import posture exactly as it was.
    const { createHash } = await import("node:crypto");
    const contractDigest = (dir: string): string => {
      const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
      const parts = ["runtime.css", "runtime.js"].map(
        (name) => `${name}:${hex(NodeFS.readFileSync(NodePath.join(dir, name)))}\n`,
      );
      return hex(parts.join(""));
    };
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    try {
      const dir = writeMissionFixture(
        scratch,
        "abcdef123456",
        "window.NoFunUI={fixture:true};\n",
        "body{color:red}\n",
      );
      assert.equal(missionRuntimeDigest(dir), contractDigest(dir));
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("stages a mission pair whose digest matches and copies it byte-for-byte", async () => {
    const packageDir = NodePath.join(repoRoot, "packages/nofun-artifacts");
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    try {
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
      const pin = NodeFS.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
        .trim()
        .split(/\s+/)[0]!
        .toLowerCase()
        .slice(0, 12);
      const pinDir = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", pin);
      NodeFS.mkdirSync(pinDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(pinDir, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(pinDir, "runtime.css"), "body{}\n");
      // Small fixture whose digest is computed in the test, like the canonical check.
      const missionRoot = NodePath.join(scratch, "mission");
      const missionVersion = "580e64f46a50";
      const sourceDir = writeMissionFixture(
        missionRoot,
        missionVersion,
        "window.NoFunUI={canonical:true};\n",
        "body{color:green}\n",
      );
      const expected = missionRuntimeDigest(sourceDir);
      const outDir = NodePath.join(scratch, "staged");
      await prebuildNofunArtifactsRuntime({
        repoRoot: NodePath.join(scratch, "repo"),
        outDir,
        missionRuntimes: [{ version: missionVersion, sha256: expected }],
        missionRuntimeRoot: missionRoot,
      });
      for (const name of ["runtime.js", "runtime.css", "manifest.json", "brands/t3.css"]) {
        assert.isTrue(
          NodeFS.readFileSync(
            NodePath.join(outDir, "dist", "nofun-ui-runtime", missionVersion, name),
          ).equals(NodeFS.readFileSync(NodePath.join(sourceDir, name))),
          `staged ${missionVersion}/${name} must equal the validated source bytes`,
        );
      }
      assert.equal(
        missionRuntimeDigest(NodePath.join(outDir, "dist", "nofun-ui-runtime", missionVersion)),
        expected,
      );
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a mission pair with drifted bytes, failing closed before copying", async () => {
    const packageDir = NodePath.join(repoRoot, "packages/nofun-artifacts");
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nofun-runtime-test-"));
    try {
      const fakePkg = NodePath.join(scratch, "repo", "packages", "nofun-artifacts");
      NodeFS.mkdirSync(fakePkg, { recursive: true });
      for (const name of ["package.json", "components.pin"]) {
        NodeFS.copyFileSync(NodePath.join(packageDir, name), NodePath.join(fakePkg, name));
      }
      for (const name of ["src", "fonts", "generated"]) {
        NodeFS.mkdirSync(NodePath.join(fakePkg, name), { recursive: true });
      }
      const pin = NodeFS.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
        .trim()
        .split(/\s+/)[0]!
        .toLowerCase()
        .slice(0, 12);
      const pinDir = NodePath.join(fakePkg, "dist", "nofun-ui-runtime", pin);
      NodeFS.mkdirSync(pinDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(pinDir, "runtime.js"), "window.NoFunUI={};\n");
      NodeFS.writeFileSync(NodePath.join(pinDir, "runtime.css"), "body{}\n");
      // A local rebuild drifts by even one byte from the canonical pair it claims to be.
      const missionRoot = NodePath.join(scratch, "mission");
      const missionVersion = "580e64f46a50";
      const sourceDir = writeMissionFixture(
        missionRoot,
        missionVersion,
        "window.NoFunUI={canonical:true};\n",
        "body{color:green}\n",
      );
      const canonical = missionRuntimeDigest(sourceDir);
      NodeFS.appendFileSync(NodePath.join(sourceDir, "runtime.js"), "// rebuilt\n");
      const drifted = missionRuntimeDigest(sourceDir);
      assert.notEqual(drifted, canonical);
      let error: unknown;
      try {
        await prebuildNofunArtifactsRuntime({
          repoRoot: NodePath.join(scratch, "repo"),
          outDir: NodePath.join(scratch, "staged"),
          missionRuntimes: [{ version: missionVersion, sha256: canonical }],
          missionRuntimeRoot: missionRoot,
        });
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, Error);
      assert.include((error as Error).message, missionVersion);
      assert.include((error as Error).message, drifted);
      assert.include((error as Error).message, canonical);
      assert.match((error as Error).message, /refusing to stage non-canonical bytes/);
      assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "staged", "package.json")));
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
