// Linked artifacts: a small HTML page that loads the shared No Fun UI runtime (runtime-bundle/build.ts)
// from `nofun-ui://runtime/<sha>/` and carries only its own code. The tsx lane bundles the user module
// with every allowed import pointed at `window.NoFunUI.require`, plus the Tailwind utilities its own
// classes need on top of runtime.css; the spec lane carries only the spec JSON. Canvas serves the
// runtime folder; `runtimeBase` swaps the scheme for relative paths in a plain browser check.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as esbuild from "esbuild";

import { validateArtifactSpec } from "./catalog.ts";
import {
  ASSET_SCRIPT,
  STORAGE_SCRIPT,
  findAssetPaths,
  inlineAssets,
  type AssetMap,
} from "./live/assets.ts";
import {
  JS_TARGET,
  PACKAGE_SRC_DIR,
  REPRODUCIBLE_BUILD,
  USER_PACKAGES,
  candidatesOf,
  formatMessages,
} from "./live/bundle.ts";
import { buildCss } from "./live/css.ts";
import { brandScheme } from "./live/registry.ts";
import { assertComponentsDir } from "./live/source.ts";
import { deterministicStampInstant } from "./stamp.ts";
import { DEFAULT_ARTIFACT_THEME, T3_THEME, artifactThemeIds, isArtifactTheme } from "./themes.ts";

export interface LinkedCompileInput {
  readonly lane: "tsx" | "spec";
  /** TSX with a default-exported component, or a catalog spec (object or JSON text). */
  readonly source: unknown;
  readonly theme?: string | undefined;
  readonly size?: { readonly width: number; readonly height: number } | undefined;
  /** Runtime folder name, `dist/nofun-ui-runtime/<sha>` (the nofun-components revision it was built from). */
  readonly runtimeSHA: string;
  /** Where runtime.js lives; defaults to `nofun-ui://runtime/<sha>/`. */
  readonly runtimeBase?: string | undefined;
  /** The runtime's manifest.json, to reject imports the runtime does not carry; defaults to dist/. */
  readonly runtimeManifest?: string | undefined;
  readonly title?: string | undefined;
  /** Pins a two-scheme brand; otherwise the page follows the system appearance. */
  readonly scheme?: "light" | "dark" | undefined;
}

export interface LinkedArtifact {
  readonly html: string;
  readonly bytes: number;
  readonly lane: "tsx" | "spec";
  readonly theme: string;
  readonly runtimeSHA: string;
}

export class LinkedCompileError extends Error {
  readonly issues: ReadonlyArray<string>;
  constructor(message: string, issues: ReadonlyArray<string> = []) {
    super(issues.length === 0 ? message : `${message}\n- ${issues.slice(0, 20).join("\n- ")}`);
    this.issues = issues;
  }
}

const RUNTIME_PREFIXES = ["@nofun/ui/", "@nofun/kobra/"];
const FRAME_CSS = `body[data-brand]{padding:16px;border-radius:14px;background:var(--nf-canvas,var(--background));color:var(--nf-ink,var(--foreground))}`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
const escapeScript = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1");

/** The local copy of the runtime (manifest module list and runtime.css), when it is on disk. */
function localRuntime(input: LinkedCompileInput) {
  const manifest =
    input.runtimeManifest ??
    NodePath.join(
      PACKAGE_SRC_DIR,
      "..",
      "dist",
      "nofun-ui-runtime",
      input.runtimeSHA,
      "manifest.json",
    );
  const read = (file: string) => {
    try {
      return NodeFs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const json = read(manifest);
  return {
    modules: json ? new Set((JSON.parse(json) as { modules: string[] }).modules) : undefined,
    css: read(NodePath.join(NodePath.dirname(manifest), "runtime.css")),
  };
}

/** CSS.escape, as Tailwind escapes class names in selectors. */
function cssEscape(name: string) {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    const code = c.charCodeAt(0);
    if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (i === 0 && /\d/.test(c)) ||
      (i === 1 && /\d/.test(c) && name[0] === "-")
    ) {
      out += `\\${code.toString(16)} `;
    } else if (code >= 128 || /[\w-]/.test(c)) out += c;
    else out += `\\${c}`;
  }
  return out;
}

/** Whether runtime.css already has a rule for this class. */
const runtimeHasClass = (css: string, name: string) =>
  new RegExp(`\\.${cssEscape(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w\\\\-])`).test(
    css,
  );

function importIssue(path: string, modules: ReadonlySet<string> | undefined): string | undefined {
  const known =
    (USER_PACKAGES as ReadonlyArray<string>).includes(path) ||
    path === "@nofun/artifacts" ||
    RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!known) {
    return `Import "${path}" is not allowed. Linked artifacts may import "react", "@nofun/ui/<component>", "@nofun/kobra/<primitive>", "@nofun/artifacts", ${USER_PACKAGES.filter(
      (p) => !p.startsWith("react"),
    )
      .map((p) => `"${p}"`)
      .join(", ")}.`;
  }
  const [name, ...rest] = path.startsWith("@nofun/ui/")
    ? path.slice("@nofun/ui/".length).split("/")
    : [];
  if (rest.length > 0 && rest.join("/") !== "demo") {
    return `"${path}" is inside a block; linked artifacts import a block ("@nofun/ui/${name}") or its demo ("@nofun/ui/${name}/demo"). Inline anything else.`;
  }
  if (modules && !modules.has(path)) return `"${path}" is not in this runtime.`;
  return undefined;
}

/** The user module as an IIFE that mounts itself, every import resolved through window.NoFunUI. */
async function userChunk(tsx: string, modules: ReadonlySet<string> | undefined): Promise<string> {
  const issues: string[] = [];
  const plugin: esbuild.Plugin = {
    name: "nofun-linked",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "nf:user") return { path: "artifact.tsx", namespace: "nf-user" };
        const issue = importIssue(args.path, modules);
        if (issue) {
          issues.push(issue);
          return { errors: [{ text: issue }] };
        }
        return { path: args.path, namespace: "nf-runtime" };
      });
      build.onLoad({ filter: /.*/, namespace: "nf-user" }, () => ({
        contents: tsx,
        loader: "tsx",
      }));
      build.onLoad({ filter: /.*/, namespace: "nf-runtime" }, (args) => ({
        contents: `module.exports = window.NoFunUI.require(${JSON.stringify(args.path)});`,
        loader: "js",
      }));
    },
  };
  try {
    const result = await esbuild.build({
      stdin: {
        contents: `import * as M from "nf:user"; window.NoFunUI.mount(document.getElementById("nf-root"), M);`,
        loader: "js",
        sourcefile: "nf-linked.js",
      },
      absWorkingDir: PACKAGE_SRC_DIR,
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: JS_TARGET,
      minify: true,
      jsx: "automatic",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [plugin],
      ...REPRODUCIBLE_BUILD,
    });
    return result.outputFiles[0]?.text ?? "";
  } catch (error) {
    const messages = (error as { errors?: ReadonlyArray<esbuild.Message> }).errors ?? [];
    const noDefault = messages.some((m) => m.text.includes('for import "default"'));
    throw new LinkedCompileError(
      noDefault
        ? "The custom TSX must `export default` a React component."
        : "The custom TSX did not compile.",
      issues.length > 0 ? issues : formatMessages(PACKAGE_SRC_DIR, messages),
    );
  }
}

/** Top-level CSS statements, split on braces at depth 0 (quotes respected). */
function topLevel(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      out.push(css.slice(start, i + 1));
      start = i + 1;
    } else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  return out;
}

/**
 * The theme variables, utilities and @property/@keyframes of the user's classes that runtime.css lacks.
 * Classes runtime.css has stay out: re-emitted later in the same layer they would beat its variants.
 */
async function userCss(dir: string, tsx: string, runtimeCss: string | undefined): Promise<string> {
  const candidates = candidatesOf(tsx).filter(
    (token) => !(runtimeCss && runtimeHasClass(runtimeCss, token)),
  );
  if (candidates.length === 0) return "";
  const css = await buildCss(dir, { brand: null, candidates, cssImports: [] });
  return topLevel(css)
    .filter((rule) =>
      /^@(?:layer (?:theme|utilities|properties)\{|property |keyframes )/.test(rule),
    )
    .join("");
}

/**
 * The `<html>` tag for a linked page. A dark t3 page must carry `.dark` itself: the t3 theme
 * points its tokens at host-injected variables, but the opaque sandboxed entry frame never
 * receives a host sheet or a `.dark` class, so dark tokens never engage and text renders
 * near-black on dark. The marker goes on `<html>` because the runtime's `theme()` clears the
 * body's classes and theme attributes on every load. Branded themes own their marker through
 * `bodyFor` + `theme(brand, {scheme})` and are untouched.
 */
export function htmlTag(theme: string, scheme: "light" | "dark" | undefined): string {
  if (theme === T3_THEME && scheme === "dark") return `<!doctype html><html lang="en" class="dark">`;
  return `<!doctype html><html lang="en">`;
}

function bodyFor(dir: string, theme: string) {
  if (theme === T3_THEME) return ` data-nf-theme="${T3_THEME}"`;
  const { schemes } = brandScheme(dir, theme);
  const only = schemes.length === 1 ? schemes[0] : undefined;
  return ` data-nf-theme="${theme}" data-brand="${theme}"${only ? ` data-nf-scheme="${only}"` : ""}${only === "dark" ? ' class="dark" data-theme="dark"' : ""}`;
}

/** Compiles a linked artifact: HTML that mounts its code on the shared runtime `runtimeSHA`. */
export async function compileLinked(input: LinkedCompileInput): Promise<LinkedArtifact> {
  const dir = assertComponentsDir();
  if (!/^[\w.-]+$/.test(input.runtimeSHA)) {
    throw new LinkedCompileError(`"${input.runtimeSHA}" is not a runtime folder name.`);
  }
  const theme = input.theme ?? DEFAULT_ARTIFACT_THEME;
  if (!isArtifactTheme(theme)) {
    throw new LinkedCompileError(
      `Unknown theme "${theme}". Use one of ${artifactThemeIds().join(", ")}.`,
    );
  }
  const brand = theme === T3_THEME ? null : theme;
  const base = input.runtimeBase ?? `nofun-ui://runtime/${input.runtimeSHA}/`;
  const title = (input.title ?? "No Fun artifact").trim().slice(0, 200) || "No Fun artifact";

  let data = "";
  let code: string;
  let css = "";
  let texts: string[];
  if (input.lane === "tsx") {
    if (typeof input.source !== "string" || input.source.trim() === "") {
      throw new LinkedCompileError("The tsx lane needs TSX source text.");
    }
    const runtime = localRuntime(input);
    [code, css] = await Promise.all([
      userChunk(input.source, runtime.modules),
      userCss(dir, input.source, runtime.css),
    ]);
    texts = [input.source];
  } else {
    let raw = input.source;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (error) {
        throw new LinkedCompileError(`The spec is not valid JSON: ${(error as Error).message}`);
      }
    }
    const spec = validateArtifactSpec(raw);
    const json = jsonScript({ root: spec.root });
    data = `<script type="application/json" id="nf-spec">${json}</script>`;
    code = `window.NoFunUI.mount(document.getElementById("nf-root"),JSON.parse(document.getElementById("nf-spec").textContent));`;
    texts = [json];
  }
  const assets: AssetMap = inlineAssets(dir, findAssetPaths(dir, texts, brand), brand);
  const hasAssets = Object.keys(assets.map).length > 0;
  const size = input.size ? `;size=${input.size.width}x${input.size.height}` : "";
  const sourceBytes =
    typeof input.source === "string" ? input.source : JSON.stringify(input.source);
  const at = deterministicStampInstant(sourceBytes, input.runtimeSHA);
  const stamp = `components=${input.runtimeSHA};lane=${input.lane};theme=${theme}${size};at=${at};linked=${input.runtimeSHA}`;
  const html = [
    `${htmlTag(theme, input.scheme)}<head>`,
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="nofun-artifact" content="${escapeHtml(stamp)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${escapeHtml(base)}runtime.css">`,
    brand
      ? `<link rel="stylesheet" href="${escapeHtml(base)}brands/${brand}.css" data-nf-brand="${brand}">`
      : "",
    `<style>${(FRAME_CSS + css).replace(/<\/(style)/gi, "<\\/$1")}</style>`,
    `</head><body${bodyFor(dir, theme)}>`,
    `<script>${STORAGE_SCRIPT}</script>`,
    hasAssets
      ? `<script type="application/json" id="nf-assets">${jsonScript(assets.map)}</script><script>${ASSET_SCRIPT}</script>`
      : "",
    `<div id="nf-root"></div>`,
    data,
    `<script src="${escapeHtml(base)}runtime.js"></script>`,
    `<script>window.NoFunUI.theme(${JSON.stringify(brand)}${input.scheme ? `,{scheme:${JSON.stringify(input.scheme)}}` : ""});</script>`,
    `<script>${escapeScript(code)}</script>`,
    `</body></html>`,
  ].join("");
  return {
    html,
    bytes: Buffer.byteLength(html),
    lane: input.lane,
    theme,
    runtimeSHA: input.runtimeSHA,
  };
}
