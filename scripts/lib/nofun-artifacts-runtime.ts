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
import * as NodeFs from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

export const NOFUN_ARTIFACTS_PACKAGE = "@t3tools/nofun-artifacts";

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
  // runtimeRoot, so stage it with the same relative layout the source package uses.
  const runtimeSrcDir = NodePath.join(packageDir, "dist", "nofun-ui-runtime");
  const pinHead =
    NodeFs.readFileSync(NodePath.join(packageDir, "components.pin"), "utf8")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  const pinnedRuntimeDir = NodePath.join(runtimeSrcDir, pinHead.slice(0, 12));
  if (!pinHead || !NodeFs.lstatSync(pinnedRuntimeDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `no built runtime at ${pinnedRuntimeDir}; run \`pnpm runtime:build\` in packages/nofun-artifacts first.`,
    );
  }
  NodeFs.cpSync(runtimeSrcDir, NodePath.join(input.outDir, "dist", "nofun-ui-runtime"), {
    recursive: true,
  });
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
