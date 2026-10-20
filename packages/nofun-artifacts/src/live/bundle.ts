// esbuild straight from the nofun-components checkout. Its own tsconfig resolves `@/` and `@nf/`, its
// node_modules supply React, Recharts, motion, Tabler and the rest, and the plugin below adds:
// - `@nofun/ui/<registry-name>[/<file>]`: an indexed block (or a file beside it, e.g. `/demo`),
// - `@nofun/kobra/<name>`: a Kobra primitive in components/ui,
// - `@nofun/source/<path>`: any checkout file (the runtime uses it for the json-render page catalog),
// - `@nofun/artifacts`: the semantic artifact components (src/runtime),
// - shims for next/image, next/link, next/navigation, next/dynamic, next/font and server-only,
// - CSS side-effect imports collected for Tailwind instead of bundled,
// - bare imports from this package's runtime resolved from the checkout, so there is one React.
// Generated TSX (namespace nf-user) may import only the allowlist in USER_IMPORTS.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { EXCLUDED_CATEGORIES, type LiveIndex } from "./registry.ts";

const LIVE_DIR = NodePath.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_SRC_DIR = NodePath.dirname(LIVE_DIR);
const SHIMS = NodePath.join(LIVE_DIR, "shims");
export const RUNTIME_DIR = NodePath.join(PACKAGE_SRC_DIR, "runtime");

export const JS_TARGET = ["es2022", "chrome111", "safari16.4", "firefox115"];

/**
 * Same sources must emit the same bytes. `production` is always enabled so
 * `NODE_ENV` cannot switch a package's conditional export between runs.
 * `jsxDev` stays off so the runtime does not embed file:line ids. The outfile
 * name is fixed and `write` stays false, so no temp path is created or baked in.
 */
export const REPRODUCIBLE_BUILD = {
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  jsxDev: false,
  treeShaking: true,
  conditions: ["production"],
  outfile: "nf-artifact.js",
} as const satisfies esbuild.BuildOptions;

/** Third-party packages generated TSX may import besides react and the @nofun aliases. */
export const USER_PACKAGES = [
  "react",
  "react/jsx-runtime",
  "@tabler/icons-react",
  "motion",
  "motion/react",
  "recharts",
] as const;

const USER_PREFIXES = ["@nofun/ui/", "@nofun/kobra/", "@nofun/artifacts"];

const NEXT_SHIMS: Record<string, string> = {
  "next/image": "next-image.tsx",
  "next/legacy/image": "next-image.tsx",
  "next/link": "next-link.tsx",
  "next/navigation": "next-navigation.ts",
  "next/dynamic": "next-dynamic.tsx",
  "next/script": "next-null.tsx",
  "next/head": "next-null.tsx",
  "server-only": "empty.ts",
  "client-only": "empty.ts",
};

/**
 * Extra extensions probed only when nothing esbuild itself would try exists.
 * esbuild never tries `.mjs`/`.cjs` for extensionless relative imports
 * (chat-list's `./experiment-mrch-model`), so only these previously
 * unresolvable targets are probed — everything that resolves today keeps
 * its existing target byte-for-byte.
 */
const FALLBACK_PROBES = [".mjs", ".cjs"] as const;

/**
 * esbuild's default `resolveExtensions` when the build sets none (mirrors
 * esbuild's documented default list). Read `build.initialOptions` first so a
 * custom list stays authoritative.
 */
const ESBUILD_DEFAULT_RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"] as const;

/**
 * Whether a specifier may gain a new fallback target. Only extensionless
 * relative file imports (`./x`, `../x`) qualify: absolute paths, directory
 * imports with a trailing slash, specifiers that already carry an extension,
 * and non-file namespaces keep esbuild's default behavior untouched.
 */
function fallbackEligible(args: esbuild.OnResolveArgs): boolean {
  if (args.namespace !== "file") return false;
  const spec = args.path;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
  if (spec.endsWith("/")) return false;
  const base = spec.split("/").pop() ?? "";
  if (base.includes(".")) return false;
  return true;
}

/**
 * Regular-file check that follows symlinks. Missing paths, broken links,
 * and unreadable entries are not files.
 */
function isFile(candidate: string): boolean {
  try {
    return NodeFs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Marker protecting the fallback path's own `build.resolve` probes from
 * re-entering the fallback: marker-tagged resolves skip straight to native
 * handling, so the probes observe exactly what esbuild would do.
 */
const FALLBACK_RESOLVE_MARKER = "nofunExtensionlessFallback";

/**
 * Probe the extra extensions under esbuild's authoritative resolve dir.
 * Returns the fallback specifier and absolute path when a fallback file
 * exists, and undefined otherwise.
 */
function probeFallbackExtensions(
  resolveDir: string,
  spec: string,
): { spec: string; path: string } | undefined {
  for (const ext of FALLBACK_PROBES) {
    const candidate = NodePath.resolve(resolveDir, `${spec}${ext}`);
    if (isFile(candidate)) return { spec: `${spec}${ext}`, path: candidate };
  }
  return undefined;
}

/**
 * Namespace for extensionless-fallback proxy modules. esbuild itself
 * resolves the explicit `./foo.mjs`/`./foo.cjs` specifier inside the
 * proxy, so browser-field mappings keyed at the fallback path (`false`,
 * redirects), `sideEffects`, and resolve conditions all apply natively.
 * Returning the fallback file's own path in the `file` namespace instead
 * (as two earlier revisions did) drops esbuild's internal disabled-module
 * state and bundles `browser:false` targets anyway.
 */
const FALLBACK_PROXY_NAMESPACE = "nofun-ext-fallback";

/**
 * Data carried from the fallback `onResolve` to the proxy `onLoad`.
 * `spec` stays in explicit form (`./foo.mjs`) so the inner import gets
 * full native semantics; `resolveDir` is the original importer's dir.
 */
interface FallbackProxyData {
  readonly spec: string;
  readonly resolveDir: string;
  readonly with?: Record<string, string> | undefined;
}

/**
 * Tiny re-export shim whose inner import esbuild resolves natively.
 * `.mjs` stays ESM: `export *` carries every named export, and the
 * namespace default carries the default export — including the empty
 * disabled module, whose namespace is `{}` with an `undefined` default
 * (JSON-identical to `{}`; see the regression test). A static
 * `export { default } from` is deliberately NOT used: it hard-errors the
 * whole build for targets without a default (disabled modules,
 * named-only modules), even for importers that never touch `default`.
 * `.cjs` keeps CJS semantics via `module.exports = require(...)`,
 * preserving interop. Import attributes of the original import, when any,
 * ride along on both inner statements.
 */
function fallbackProxySource(spec: string, ext: ".mjs" | ".cjs", withClause: string): string {
  if (ext === ".cjs") return `module.exports = require(${JSON.stringify(spec)});\n`;
  const quoted = JSON.stringify(spec);
  return (
    `export * from ${quoted}${withClause};\n` +
    `import * as __nofun_ext_m from ${quoted}${withClause};\n` +
    `export default __nofun_ext_m.default;\n`
  );
}

const ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".png": "dataurl",
  ".jpg": "dataurl",
  ".jpeg": "dataurl",
  ".webp": "dataurl",
  ".gif": "dataurl",
  ".avif": "dataurl",
  ".svg": "dataurl",
  ".woff": "dataurl",
  ".woff2": "dataurl",
  ".mp4": "dataurl",
  ".webm": "dataurl",
  ".glsl": "text",
  ".frag": "text",
  ".vert": "text",
  ".txt": "text",
  ".md": "text",
};

export interface BundleInput {
  /** Source of the entry module (resolved from this package's src dir). */
  readonly entry: string;
  /** Generated TSX, importable from the entry as "nf:user". */
  readonly user?: string | undefined;
  readonly minify?: boolean;
}

export interface BundleResult {
  readonly js: string;
  /** CSS files the bundle imported, for Tailwind to compile. */
  readonly cssImports: ReadonlyArray<string>;
  /** Absolute source files outside node_modules, for Tailwind class candidates. */
  readonly sourceFiles: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<string>;
}

export class BundleError extends Error {
  readonly issues: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<string>;
  constructor(issues: ReadonlyArray<string>, rejected: ReadonlyArray<string>) {
    super(issues[0] ?? "Bundle failed");
    this.issues = issues;
    this.rejected = rejected;
  }
}

const isBare = (path: string) =>
  !path.startsWith(".") && !path.startsWith("/") && !/^[a-z]:/i.test(path);

function userImportAllowed(path: string) {
  return (
    (USER_PACKAGES as ReadonlyArray<string>).includes(path) ||
    USER_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
  );
}

function fontModule(importer: string): string {
  // next/font/* exports one function per family; generate the names this importer asks for.
  let names: string[] = [];
  try {
    const source = NodeFs.readFileSync(importer, "utf8");
    const match = /import\s*\{([^}]*)\}\s*from\s*["']next\/font\/(?:google|local)["']/.exec(source);
    names = (match?.[1] ?? "")
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  } catch {
    names = [];
  }
  const body = names
    .map((name) => `export const ${name} = font(${JSON.stringify(name.replace(/_/g, " "))});`)
    .join("\n");
  return `function font(family) { return (options) => ({ className: "", variable: "", style: { fontFamily: options && options.variable ? "var(" + options.variable + ")" : JSON.stringify(family) } }); }\nexport default font("local");\n${body}`;
}

export async function bundle(
  dir: string,
  index: LiveIndex,
  input: BundleInput,
): Promise<BundleResult> {
  const rejected: string[] = [];
  const cssImports = new Set<string>();
  const plugin: esbuild.Plugin = {
    name: "nofun-live",
    setup(build) {
      const resolveIn = (path: string, resolveDir: string, kind: esbuild.ImportKind) =>
        build.resolve(path, { resolveDir, kind });
      const resolveExtensions = build.initialOptions.resolveExtensions ?? [
        ...ESBUILD_DEFAULT_RESOLVE_EXTENSIONS,
      ];
      // Per-build cache of existence probes: one bundle resolves each
      // specifier once, but the index probes below overlap across imports.
      const statCache = new Map<string, boolean>();
      const cachedIsFile = (candidate: string): boolean => {
        const hit = statCache.get(candidate);
        if (hit !== undefined) return hit;
        const found = isFile(candidate);
        statCache.set(candidate, found);
        return found;
      };
      // Whether esbuild's own resolution would find a target for an
      // extensionless relative specifier: the exact file, `<p><ext>` and
      // `<p>/index<ext>` for each effective resolve extension, or a
      // `<p>/package.json` (whose main/browser fields esbuild reads).
      // Anything esbuild would resolve keeps native handling untouched.
      const nativeTargetExists = (resolveDir: string, spec: string): boolean => {
        const base = NodePath.resolve(resolveDir, spec);
        if (cachedIsFile(base)) return true;
        for (const ext of resolveExtensions) {
          if (cachedIsFile(`${base}${ext}`)) return true;
        }
        for (const ext of resolveExtensions) {
          if (cachedIsFile(NodePath.join(base, `index${ext}`))) return true;
        }
        if (cachedIsFile(NodePath.join(base, "package.json"))) return true;
        return false;
      };

      build.onResolve({ filter: /.*/ }, async (args) => {
        const { path } = args;
        if (path === "nf:user") return { path: "artifact.tsx", namespace: "nf-user" };
        const fromUser = args.namespace === "nf-user";
        if (fromUser && !userImportAllowed(path)) {
          rejected.push(path);
          return {
            errors: [
              {
                text: `Import "${path}" is not allowed. Artifacts may import "react", "@nofun/ui/<component>" (find components with nofun_components_search), "@nofun/kobra/<primitive>", "@nofun/artifacts", ${USER_PACKAGES.filter(
                  (p) => !p.startsWith("react"),
                )
                  .map((p) => `"${p}"`)
                  .join(", ")}. Inline anything else.`,
              },
            ],
          };
        }
        if (path === "@nofun/artifacts") {
          return { path: NodePath.join(RUNTIME_DIR, "index.ts") };
        }
        if (path.startsWith("@nofun/ui/")) {
          const [name, ...rest] = path.slice("@nofun/ui/".length).split("/");
          const item = index.files.get(name!);
          if (!item) {
            rejected.push(path);
            return {
              errors: [
                {
                  text: `No component named "${name}" in nofun-components. Search with nofun_components_search and import "@nofun/ui/<name>".`,
                },
              ],
            };
          }
          if (fromUser && EXCLUDED_CATEGORIES.has(item.category)) {
            rejected.push(path);
            return {
              errors: [
                {
                  text: `"${name}" is a commerce block (${item.category}); commerce blocks are not available in artifacts.`,
                },
              ],
            };
          }
          const main = NodePath.join(dir, item.file);
          if (rest.length === 0) return { path: main };
          const resolved = await resolveIn(
            `./${rest.join("/")}`,
            NodePath.dirname(main),
            args.kind,
          );
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path };
        }
        if (path.startsWith("@nofun/kobra/")) {
          const resolved = await resolveIn(
            `./components/ui/${path.slice("@nofun/kobra/".length)}`,
            dir,
            args.kind,
          );
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path };
        }
        if (path.startsWith("@nofun/source/")) {
          const resolved = await resolveIn(
            `./${path.slice("@nofun/source/".length)}`,
            dir,
            args.kind,
          );
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path };
        }
        if (path.startsWith("next/font/")) {
          return { path: args.importer, namespace: "nf-font" };
        }
        const shim = NEXT_SHIMS[path];
        if (shim) return { path: NodePath.join(SHIMS, shim) };
        // This package's runtime and shims, and generated TSX, take their packages from the checkout.
        if (
          isBare(path) &&
          (fromUser || args.importer.startsWith(PACKAGE_SRC_DIR) || args.namespace === "nf-font")
        ) {
          const resolved = await resolveIn(path, dir, args.kind);
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path };
        }
        // Extensionless relative imports reach esbuild's default resolver,
        // which never tries `.mjs`/`.cjs` (chat-list's
        // `./experiment-mrch-model`). Do a cheap synchronous existence
        // check of exactly what esbuild itself would try; when any of
        // those targets exists, return undefined so esbuild resolves
        // normally — preserving browser-field mappings, plugin
        // namespaces, resolution order, and every other native behavior.
        // Only when none exists, and a sibling `.mjs`/`.cjs` file does,
        // select that previously-unresolvable target as below. No
        // `build.resolve` round trip on this fast path, so ordinary
        // imports pay only cached stat calls.
        if (!isBare(path) && fallbackEligible(args)) {
          if (args.pluginData?.[FALLBACK_RESOLVE_MARKER]) return undefined;
          if (nativeTargetExists(args.resolveDir, path)) return undefined;
          const probed = probeFallbackExtensions(args.resolveDir, path);
          if (!probed) return undefined;
          // A package.json `browser` mapping can resolve the original
          // extensionless specifier even though no file exists at the
          // original path (`{"./foo": false}` disables the module,
          // `{"./foo": "./bar.ts"}` redirects it). The stat check above
          // cannot see mappings, so ask esbuild about the original
          // specifier first; when it resolves, step aside (undefined) so
          // native handling applies the mapping untouched. Only when even
          // esbuild cannot resolve the original is the fallback selected —
          // via the proxy module below, so mappings keyed at the fallback
          // path itself still apply natively. This probe runs solely on
          // this rare path (no native target AND a fallback file exists).
          const markerData = { [FALLBACK_RESOLVE_MARKER]: true };
          const native = await build.resolve(path, {
            resolveDir: args.resolveDir,
            kind: args.kind,
            importer: args.importer,
            pluginData: markerData,
            with: args.with,
          });
          if (native.errors.length === 0) return undefined;
          // No native target and no mapping for the original specifier:
          // hand esbuild a proxy module in a private namespace. The proxy
          // re-exports the explicit `probed.spec`, which esbuild then
          // resolves natively — browser:false/redirect mappings keyed at
          // the fallback path, sideEffects, and conditions included. The
          // visible fields of a `build.resolve` must NOT be returned here:
          // they carry no disabled-module state. This path makes exactly
          // one probe call; the fast path above makes none.
          const proxyData: FallbackProxyData = {
            spec: probed.spec,
            resolveDir: args.resolveDir,
            with: args.with,
          };
          return {
            path: probed.path,
            namespace: FALLBACK_PROXY_NAMESPACE,
            pluginData: proxyData,
          };
        }
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: "nf-user" }, () => ({
        contents: input.user ?? "export default function Empty() { return null; }",
        loader: "tsx",
        resolveDir: dir,
      }));
      build.onLoad({ filter: /.*/, namespace: FALLBACK_PROXY_NAMESPACE }, (args) => {
        const data = args.pluginData as FallbackProxyData;
        const ext = data.spec.endsWith(".cjs") ? ".cjs" : ".mjs";
        const withClause =
          data.with != null && Object.keys(data.with).length > 0
            ? ` with ${JSON.stringify(data.with)}`
            : "";
        return {
          contents: fallbackProxySource(data.spec, ext, withClause),
          loader: "js",
          resolveDir: data.resolveDir,
        };
      });
      build.onLoad({ filter: /.*/, namespace: "nf-font" }, (args) => ({
        contents: fontModule(args.path),
        loader: "js",
        resolveDir: dir,
      }));
      build.onLoad({ filter: /\.css$/ }, (args) => {
        cssImports.add(args.path);
        return { contents: "", loader: "js" };
      });
    },
  };

  let result: esbuild.BuildResult<{ write: false; metafile: true }>;
  try {
    result = await esbuild.build({
      stdin: {
        contents: input.entry,
        loader: "tsx",
        sourcefile: "nf-entry.tsx",
        resolveDir: PACKAGE_SRC_DIR,
      },
      absWorkingDir: dir,
      bundle: true,
      write: false,
      metafile: true,
      format: "iife",
      platform: "browser",
      target: JS_TARGET,
      minify: input.minify ?? true,
      jsx: "automatic",
      logLevel: "silent",
      loader: ASSET_LOADERS,
      define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
      banner: { js: 'var process=globalThis.process||{env:{NODE_ENV:"production"}};' },
      plugins: [plugin],
      ...REPRODUCIBLE_BUILD,
    });
  } catch (error) {
    const failure = error as { errors?: ReadonlyArray<esbuild.Message> };
    throw new BundleError(formatMessages(dir, failure.errors ?? []), rejected);
  }
  const js =
    result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ??
    result.outputFiles[0]?.text ??
    "";
  // onLoad runs as files finish, so Set insertion order is not stable across builds.
  // Sort before the order can reach Tailwind or a content hash.
  const sourceFiles = Object.keys(result.metafile.inputs)
    .filter((input) => !input.includes(":") || /^[a-z]:/i.test(input))
    .map((input) => NodePath.resolve(dir, input))
    .filter((file) => !file.includes(`${NodePath.sep}node_modules${NodePath.sep}`))
    .filter((file) => /\.(tsx|ts|jsx|js|mjs)$/.test(file))
    .sort();
  return { js, cssImports: [...cssImports].sort(), sourceFiles, rejected };
}

export function formatMessages(dir: string, messages: ReadonlyArray<esbuild.Message>) {
  return messages.map((message) => {
    const at = message.location;
    const file = at?.file
      ? at.file.startsWith("nf-user:") || at.file === "artifact.tsx"
        ? "artifact.tsx"
        : NodePath.relative(dir, NodePath.resolve(dir, at.file))
      : "";
    const where = at ? `${file}:${at.line}:${at.column + 1}: ` : "";
    const line = at?.lineText ? ` (\`${at.lineText.trim().slice(0, 120)}\`)` : "";
    return `${where}${message.text}${line}`;
  });
}

const tokenCache = new Map<string, { mtime: number; tokens: string[] }>();

/** Tokens that might be Tailwind classes. Tailwind ignores the ones that are not. */
// Arbitrary values may quote inside their brackets, as in [grid-template-areas:'sep_content'], so
// splitting on quotes alone never yields them; collect bracketed classes whole as well.
const BRACKETED_CLASS = /[\w:!@/.-]*\[[^\]\s]*['"][^\]\s]*\][\w/:.%-]*/g;

export function candidatesOf(source: string): string[] {
  const tokens = source.split(/[\s"'`]+/);
  for (const match of source.matchAll(BRACKETED_CLASS)) tokens.push(match[0]);
  // Minified JS yields bracketed tokens with braces. Tailwind emits them as a rule
  // that swallows the rest of the sheet.
  return tokens.filter((token) => token.length > 0 && token.length < 300 && !/[{}]/.test(token));
}

export function candidatesOfFiles(files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = NodeFs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let cached = tokenCache.get(file);
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, tokens: candidatesOf(NodeFs.readFileSync(file, "utf8")) };
      tokenCache.set(file, cached);
    }
    for (const token of cached.tokens) out.add(token);
  }
  return out;
}
