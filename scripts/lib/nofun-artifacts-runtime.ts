// @effect-diagnostics nodeBuiltinImport:off - a plain build step; it only copies files and runs esbuild.
/**
 * Prebuilds @t3tools/nofun-artifacts into a self-contained runtime copy for the packaged desktop app.
 *
 * The workspace package exports raw .ts sources. That works in dev, where Node strips types, but not
 * in the packaged app: the server runs under Electron's Node from inside app.asar, and Node refuses
 * to strip types below node_modules. The copy keeps the original layout (the compiler reads its own
 * src/runtime and src/live/shims at compile time, by path, through esbuild) and adds JS entry points
 * beside the sources in src/live, so the `import.meta.url` arithmetic in live/bundle.ts and
 * live/report.ts resolves to the same directories it does in dev.
 *
 * esbuild's Go binary cannot read app.asar, so the package and @esbuild/* are asar-unpacked by the
 * desktop build config, and the entries rewrite their own location (and esbuild's binary path) from
 * app.asar to app.asar.unpacked before anything reads them.
 */
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

export const NOFUN_ARTIFACTS_PACKAGE = "@t3tools/nofun-artifacts";

export interface MissionRuntimePin {
  readonly version: string;
  readonly sha256: string;
}

/**
 * Mission No Fun UI runtimes the packaged app must carry next to the components.pin one, as
 * (version, digest) pairs. Source of truth is the Canvas contract (nofun-canvas deps.lock
 * `runtime`; the same pair the `runtime-pin.test.ts` contract test asserts as its reference).
 * No pin file for it exists in this repo, so this table is the single copy; the staging test
 * imports it from here and asserts the exact canonical entry.
 */
export const MISSION_RUNTIMES: readonly MissionRuntimePin[] = [
  {
    version: "580e64f46a50",
    sha256: "8c0394e7bf16e136dae5109cb16d5effd39a2bea2bd6a77769a8296004c0d5db",
  },
];

/** Mission runtime versions, derived from the pin table above. */
export const MISSION_RUNTIME_VERSIONS: readonly string[] = MISSION_RUNTIMES.map(
  (pin) => pin.version,
);

const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The mission-pair digest: the same rule as `runtimeDigest` in
 * packages/nofun-artifacts/src/runtime-pin.ts — sha256 of
 * `runtime.css:<sha256 of runtime.css>\nruntime.js:<sha256 of runtime.js>\n`.
 * Kept local (node:crypto only) so the build step never imports the compiled package.
 */
export function missionRuntimeDigest(runtimeDir: string): string {
  const parts = ["runtime.css", "runtime.js"].map((name) => {
    const file = NodePath.join(runtimeDir, name);
    if (NodeFs.lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`runtime folder ${runtimeDir} has no regular file ${name}.`);
    }
    return `${name}:${sha256Hex(NodeFs.readFileSync(file))}\n`;
  });
  return sha256Hex(parts.join(""));
}

/**
 * Where the canonical mission runtime `<version>/` directory comes from. A local
 * `runtime:build` is NOT a source: rebuilds of the same components commit drift from the
 * canonical bytes both pinned hosts admit. Either set NOFUN_MISSION_RUNTIME_ROOT to a directory
 * containing `<version>/` folders copied byte-for-byte from the canonical publisher
 * (nofun-components `canvas-web/nofun-ui-runtime/<version>/`; equivalently nofun-canvas
 * `Sources/CanvasMac/Runtime/nofun-ui-runtime/<version>/`), or set NOFUN_COMPONENTS_DIR at a
 * checkout that publishes `canvas-web/nofun-ui-runtime/<version>/`.
 */
export function missionRuntimeSourceDir(version: string, repoRoot: string): string {
  const override = process.env.NOFUN_MISSION_RUNTIME_ROOT?.trim();
  if (override) return NodePath.join(override, version);
  const componentsDir = process.env.NOFUN_COMPONENTS_DIR?.trim();
  if (componentsDir) {
    return NodePath.join(componentsDir, "canvas-web", "nofun-ui-runtime", version);
  }
  throw new Error(
    `no canonical source for mission runtime ${version}: set NOFUN_MISSION_RUNTIME_ROOT to a ` +
      `directory holding byte-for-byte canonical <version>/ folders, or set NOFUN_COMPONENTS_DIR ` +
      `at a checkout publishing canvas-web/nofun-ui-runtime/${version}/ (repo root ${repoRoot} ` +
      `has no canonical copy; never stage a local runtime:build output for a mission version).`,
  );
}

/** Packages the prebuilt entries leave external; everything else the compiler imports is inlined. */
const RUNTIME_DEPENDENCIES = ["esbuild", "playwright-core"] as const;

// Banner text is not subject to `define`, so it still sees the real module URL.
const UNPACKED_URL_BANNER = [
  "const __nofunRealUrl = import.meta.url;",
  `const __nofunModuleUrl = __nofunRealUrl.replace(/\\.asar([\\\\/])/, ".asar.unpacked$1");`,
].join("\n");

// Imported (statically) instead of "esbuild" so ESBUILD_BINARY_PATH is set before esbuild's module
// body captures it. Outside an asar it is a no-op.
const ESBUILD_SHIM = `
import { createRequire } from "node:module";
const nofunRequire = createRequire(__nofunRealUrl);
if (!process.env.ESBUILD_BINARY_PATH) {
  try {
    const esbuildMain = nofunRequire.resolve("esbuild");
    if (/\\.asar[\\\\/]/.test(esbuildMain)) {
      const binary = createRequire(esbuildMain).resolve(
        "@esbuild/" + process.platform + "-" + process.arch + "/bin/esbuild",
      );
      process.env.ESBUILD_BINARY_PATH = binary.replace(/\\.asar([\\\\/])/, ".asar.unpacked$1");
    }
  } catch {}
}
// A non-literal specifier keeps the bundler's esbuild -> shim alias off this import.
const esbuildSpecifier = "esbuild";
const esbuild = await import(esbuildSpecifier);
export const build = esbuild.build;
export const transform = esbuild.transform;
export const context = esbuild.context;
export default esbuild;
`;

/** Writes the runtime copy, with a package.json pinning the runtime dependencies, to `outDir`. */
export async function prebuildNofunArtifactsRuntime(input: {
  readonly repoRoot: string;
  readonly outDir: string;
  /** Mission pin table under test; defaults to the canonical MISSION_RUNTIMES above. */
  readonly missionRuntimes?: readonly MissionRuntimePin[];
  /** Canonical mission root under test; defaults to the NOFUN_* env resolution above. */
  readonly missionRuntimeRoot?: string;
}): Promise<void> {
  const packageDir = NodePath.join(input.repoRoot, "packages/nofun-artifacts");
  const sourcePackage = JSON.parse(
    NodeFs.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const versions = { ...sourcePackage.devDependencies, ...sourcePackage.dependencies };
  const dependencies = Object.fromEntries(
    RUNTIME_DEPENDENCIES.map((name) => {
      const version = versions[name];
      if (!version || !/^\d/.test(version)) {
        throw new Error(`${NOFUN_ARTIFACTS_PACKAGE} must pin ${name} to an exact version.`);
      }
      return [name, version];
    }),
  );

  NodeFs.rmSync(input.outDir, { recursive: true, force: true });
  NodeFs.mkdirSync(input.outDir, { recursive: true });
  NodeFs.cpSync(NodePath.join(packageDir, "src"), NodePath.join(input.outDir, "src"), {
    recursive: true,
  });
  // next/font output is absent in the desktop package; keep the compiler's vendored fallback.
  NodeFs.cpSync(NodePath.join(packageDir, "fonts"), NodePath.join(input.outDir, "fonts"), {
    recursive: true,
  });
  const generatedDir = NodePath.join(packageDir, "generated");
  NodeFs.mkdirSync(NodePath.join(input.outDir, "generated"), { recursive: true });
  if (NodeFs.existsSync(generatedDir)) {
    NodeFs.cpSync(generatedDir, NodePath.join(input.outDir, "generated"), { recursive: true });
  }
  // The compiler reads the nofun-components sha from here at server startup.
  NodeFs.copyFileSync(
    NodePath.join(packageDir, "components.pin"),
    NodePath.join(input.outDir, "components.pin"),
  );
  // emitToolBundle defaults to the pinned UI runtime and the packaged server never sets
  // runtimeRoot, so stage it with the same relative layout the source package uses. The mission
  // pin (emitToolBundle({ runtimeVersion: '580e64f46a50' })) must resolve the same way, so every
  // version below has to be present before anything is copied: fail early, not mid-package.
  const runtimeSrcDir = NodePath.join(packageDir, "dist", "nofun-ui-runtime");
  const pinHead =
    NodeFs.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  const pinVersion = pinHead.slice(0, 12);
  const pinDir = NodePath.join(runtimeSrcDir, pinVersion);
  const pinStats = NodeFs.lstatSync(pinDir, { throwIfNoEntry: false });
  const pinHasFiles =
    pinStats?.isDirectory() === true &&
    NodeFs.lstatSync(NodePath.join(pinDir, "runtime.js"), {
      throwIfNoEntry: false,
    })?.isFile() === true &&
    NodeFs.lstatSync(NodePath.join(pinDir, "runtime.css"), {
      throwIfNoEntry: false,
    })?.isFile() === true;
  if (!pinHead || !pinHasFiles) {
    throw new Error(
      `no built runtime at ${pinDir} for version ${pinVersion}; run \`pnpm runtime:build\` ` +
        `in packages/nofun-artifacts with NOFUN_COMPONENTS_DIR at a clean ${pinVersion} checkout ` +
        `(NOFUN_COMPONENTS_ALLOW_DIRTY=1 when its HEAD is not components.pin) first.`,
    );
  }
  // Mission runtimes are never staged from a local runtime:build: their bytes must equal the
  // canonical pair both pinned hosts admit, so copy them from the canonical source and fail
  // closed when the digest disagrees.
  const missionRuntimes = input.missionRuntimes ?? MISSION_RUNTIMES;
  const missionSources = new Map<string, string>();
  for (const pin of missionRuntimes) {
    const sourceDir =
      input.missionRuntimeRoot != null
        ? NodePath.join(input.missionRuntimeRoot, pin.version)
        : missionRuntimeSourceDir(pin.version, input.repoRoot);
    let actual: string;
    try {
      actual = missionRuntimeDigest(sourceDir);
    } catch (error) {
      throw new Error(
        `no canonical mission runtime at ${sourceDir} for version ${pin.version}; copy it ` +
          `byte-for-byte from canvas-web/nofun-ui-runtime/${pin.version}/ (or set ` +
          `NOFUN_MISSION_RUNTIME_ROOT at such a root) instead of rebuilding it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (actual !== pin.sha256) {
      throw new Error(
        `mission runtime ${pin.version} at ${sourceDir} has sha256 ${actual}, expected ` +
          `${pin.sha256}; refusing to stage non-canonical bytes the pinned hosts reject.`,
      );
    }
    missionSources.set(pin.version, sourceDir);
  }
  const stagedRuntimeDir = NodePath.join(input.outDir, "dist", "nofun-ui-runtime");
  NodeFs.mkdirSync(stagedRuntimeDir, { recursive: true });
  NodeFs.cpSync(pinDir, NodePath.join(stagedRuntimeDir, pinVersion), { recursive: true });
  for (const [version, sourceDir] of missionSources) {
    if (version === pinVersion) {
      // The staged bytes come from the local build here, so they still face the pin.
      const staged = missionRuntimeDigest(NodePath.join(stagedRuntimeDir, pinVersion));
      const expected = missionRuntimes.find((pin) => pin.version === version)?.sha256;
      if (staged !== expected) {
        throw new Error(
          `mission runtime ${version} built locally has sha256 ${staged}, expected ` +
            `${expected}; refusing to stage non-canonical bytes the pinned hosts reject.`,
        );
      }
      continue;
    }
    NodeFs.cpSync(sourceDir, NodePath.join(stagedRuntimeDir, version), { recursive: true });
  }
  const shimPath = NodePath.join(input.outDir, "esbuild-shim.mjs");
  NodeFs.writeFileSync(shimPath, ESBUILD_SHIM);

  // esbuild is the artifact package's dependency, not the scripts package's; load it from there.
  const esbuild = (await import(
    createRequire(NodePath.join(packageDir, "package.json")).resolve("esbuild")
  )) as {
    build: (options: Record<string, unknown>) => Promise<unknown>;
  };
  await esbuild.build({
    entryPoints: {
      compiler: NodePath.join(packageDir, "src/compiler.ts"),
      catalog: NodePath.join(packageDir, "src/catalog.ts"),
      "tool-bundle": NodePath.join(packageDir, "src/tool-bundle.ts"),
    },
    outdir: NodePath.join(input.outDir, "src/live"),
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: [...RUNTIME_DEPENDENCIES],
    alias: { esbuild: shimPath },
    define: { "import.meta.url": "__nofunModuleUrl" },
    banner: { js: UNPACKED_URL_BANNER },
    logLevel: "warning",
  });
  // The shim was inlined into each entry; it does not ship on its own.
  NodeFs.rmSync(shimPath);

  const runtimePackage = {
    name: NOFUN_ARTIFACTS_PACKAGE,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: {
      "./compiler": "./src/live/compiler.mjs",
      "./catalog": "./src/live/catalog.mjs",
      "./tool-bundle": "./src/live/tool-bundle.mjs",
    },
    dependencies,
  };
  NodeFs.writeFileSync(
    NodePath.join(input.outDir, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
  );
}
