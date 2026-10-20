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
 * Probe order for extensionless relative imports (`./model` beside
 * `model.mjs`). esbuild's default resolver tries tsx/ts/jsx/js/json and never
 * `.mjs`; `.mjs` trails the list so every specifier that resolves today keeps
 * its existing target and only previously-unresolvable `.mjs` files start
 * resolving.
 */
const EXTENSIONLESS_PROBES = [".tsx", ".ts", ".jsx", ".js", ".json", ".mjs"] as const;

/**
 * Resolve an extensionless relative specifier (`./x`, `../x`) to a sibling
 * file the builder supports. Returns undefined when the specifier already has
 * an extension or no probed file exists, so the default resolver keeps
 * handling everything else byte-for-byte as before.
 */
function probeExtensionlessRelative(args: esbuild.OnResolveArgs): string | undefined {
  const base = args.path.split("/").pop() ?? "";
  if (base.includes(".")) return undefined;
  const fromDir =
    args.importer && NodePath.isAbsolute(args.importer)
      ? NodePath.dirname(args.importer)
      : args.resolveDir;
  for (const ext of EXTENSIONLESS_PROBES) {
    const candidate = NodePath.resolve(fromDir, `${args.path}${ext}`);
    if (NodeFs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
      return candidate;
    }
  }
  return undefined;
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
        // which never tries `.mjs` (chat-list's `./experiment-mrch-model`).
        // Probe the builder's supported extensions first; anything already
        // resolving keeps its target because `.mjs` trails esbuild's order.
        if (!isBare(path)) {
          const probed = probeExtensionlessRelative(args);
          if (probed) return { path: probed };
        }
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: "nf-user" }, () => ({
        contents: input.user ?? "export default function Empty() { return null; }",
        loader: "tsx",
        resolveDir: dir,
      }));
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
