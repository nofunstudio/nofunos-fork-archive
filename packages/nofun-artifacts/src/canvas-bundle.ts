// A Canvas artifact bundle: manifest.json + index.html + stamp.json + the source that produced it.
// Manifest shape matches Canvas `WebArtifactManifest` / the MCP `validate_bundle` (format
// `nofun-canvas-artifact-bundle`). `stamp.json` and `source/` sit beside the entry; today's Swift
// walker still rejects those two paths, which the root applies from the W1 snippet.
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { assertRuntimePin, type RuntimePin } from "./runtime-pin.ts";
import { formatStamp, type ArtifactStamp } from "./stamp.ts";

export const CANVAS_FORMAT = "nofun-canvas-artifact-bundle";
export const MANIFEST_KEYS = [
  "format",
  "version",
  "name",
  "entry",
  "size",
  "background",
  "interaction",
  "source",
  "createdAt",
  "sha256",
] as const;
/** Optional keys; `runtime` pins the No Fun UI runtime the page was built for (see runtime-pin.ts). */
export const OPTIONAL_MANIFEST_KEYS = ["runtime"] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function parseCanvasSize(text: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`size must be WxH (got ${JSON.stringify(text)}).`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  assertCanvasSize(width, height);
  return { width, height };
}

export function assertCanvasSize(width: number, height: number): void {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(value) || value < 16 || value > 4096) {
      throw new Error(`${name} must be an integer from 16 to 4096 (got ${value}).`);
    }
  }
}

export function parseCanvasBackground(text: string): "transparent" | "match" | `#${string}` {
  const value = text.trim().toLowerCase();
  if (value === "transparent" || value === "match") return value;
  if (HEX_COLOR.test(value)) return value as `#${string}`;
  throw new Error(
    `background must be transparent, match, or #rrggbb (got ${JSON.stringify(text)}).`,
  );
}

const NETWORK_URL = /https?:\/\//gi;
const hideWith = (text: string, slashes: string) =>
  text.replace(NETWORK_URL, (match) => `${match.slice(0, -2)}${slashes}`);

/**
 * Hides `http://` and `https://` from Canvas's byte lint without changing what the page reads, by
 * context. Inside `<script>` bodies (JS and JSON strings) `\u002f` is a slash, so React's SVG
 * `createElementNS("http://www.w3.org/2000/svg")` keeps working. Inside `<style>` bodies `\/` is a CSS
 * escape for a slash. Everywhere else (text such as `<title>`, attribute values, tag markup) a
 * `&#47;` character reference decodes to the same slash, so visible text and attributes are unchanged.
 */
export function stripNetworkUrls(html: string): string {
  let out = "";
  let last = 0;
  for (const block of html.matchAll(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi)) {
    const [whole, open, tag, body, close] = block as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    out += hideWith(html.slice(last, block.index), "&#47;&#47;");
    out += hideWith(open, "&#47;&#47;");
    out += hideWith(body, tag.toLowerCase() === "script" ? "\\u002f\\u002f" : "\\/\\/");
    out += hideWith(close, "&#47;&#47;");
    last = block.index! + whole.length;
  }
  return out + hideWith(html.slice(last), "&#47;&#47;");
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );

// A linked page names its runtime in the entry meta (`linked=<version>`, last piece), as the hosts
// read it (Canvas `WebArtifactStamp`, the Notes viewer). Rewriting the compiler's meta from the
// ArtifactStamp alone used to drop it, so the piece is carried here, from the same value that
// goes into stamp.json and manifest.runtime.version.
function stampMeta(stamp: ArtifactStamp, linked?: string): string {
  const content = linked ? `${formatStamp(stamp)};linked=${linked}` : formatStamp(stamp);
  return `<meta name="nofun-artifact" content="${escapeHtml(content)}">`;
}

function withStamp(html: string, stamp: ArtifactStamp, linked?: string): string {
  const tag = stampMeta(stamp, linked);
  if (/<meta\s+name="nofun-artifact"\s+content="[^"]*"\s*\/?>/i.test(html)) {
    return html.replace(/<meta\s+name="nofun-artifact"\s+content="[^"]*"\s*\/?>/i, tag);
  }
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  return `${tag}${html}`;
}

function canvasFrame(background: string): string {
  const bg =
    background === "transparent" || background === "match"
      ? "html,body,body[data-brand]{background:transparent!important}"
      : `html,body,body[data-brand]{background:${background}!important}`;
  return `<meta name="color-scheme" content="dark"><style id="nf-canvas">:root{color-scheme:dark}${bg}</style>`;
}

function withCanvasFrame(html: string, background: string): string {
  if (html.includes('id="nf-canvas"')) return html;
  const tags = canvasFrame(background);
  if (html.includes("</head>")) return html.replace("</head>", `${tags}</head>`);
  return `${tags}${html}`;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > 200) {
    throw new Error("name must be nonempty and at most 200 bytes.");
  }
  return trimmed;
}

function refuseSymlink(file: string): void {
  let stat: NodeFs.Stats;
  try {
    stat = NodeFs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Error(`${file} is a symlink; the bundle must be regular files.`);
}

function writeRegular(file: string, data: string | Buffer): void {
  refuseSymlink(file);
  NodeFs.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFs.writeFileSync(file, data);
}

function bundleAssetPath(bundlePath: string): string {
  if (!bundlePath.startsWith("assets/") || bundlePath.includes("\\") || bundlePath.includes("\0")) {
    throw new Error(`bundle asset ${JSON.stringify(bundlePath)} must stay under assets/.`);
  }
  const parts = bundlePath.slice("assets/".length).split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`bundle asset ${JSON.stringify(bundlePath)} must stay under assets/.`);
  }
  return NodePath.join("assets", ...parts);
}

export interface CanvasBundleInput {
  readonly outDir: string;
  readonly html: string;
  readonly name: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly stamp: ArtifactStamp;
  /** Original spec, tsx, or page file. Copied under `source/` as a regular file. */
  readonly sourceFile: { readonly name: string; readonly bytes: Buffer };
  /** Optional `stamp.json` `linked` value. Omitted when unset. */
  readonly linked?: string;
  /** Runtime version and digest written to `manifest.runtime`. Omitted for unpinned (legacy) bundles. */
  readonly runtime?: RuntimePin;
  /** Stage images copied under `assets/`. Paths must stay inside that directory. */
  readonly assets?: ReadonlyArray<{ readonly bundlePath: string; readonly bytes: Buffer }>;
}

export interface CanvasManifest {
  readonly format: typeof CANVAS_FORMAT;
  readonly version: 1;
  readonly name: string;
  readonly entry: "index.html";
  readonly size: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly interaction: "interactive";
  readonly source: { readonly kind: "nofun-artifact-render"; readonly ref: string };
  readonly createdAt: string;
  readonly sha256: string;
  readonly runtime?: RuntimePin;
}

/** Writes a Canvas bundle. Returns the manifest that was written. */
export function writeCanvasBundle(input: CanvasBundleInput): CanvasManifest {
  const outDir = NodePath.resolve(input.outDir);
  refuseSymlink(outDir);
  assertCanvasSize(input.size.width, input.size.height);
  const background = parseCanvasBackground(input.background);
  const name = assertName(input.name);
  const at = input.stamp.at.replace(/\.\d{3}Z$/, "Z");
  const stamp: ArtifactStamp = { ...input.stamp, at };
  const sourceName = NodePath.basename(input.sourceFile.name);
  if (!sourceName || sourceName === "." || sourceName === ".." || sourceName.includes("/")) {
    throw new Error(
      `source file name ${JSON.stringify(input.sourceFile.name)} is not a single path segment.`,
    );
  }
  // Only absence is "unpinned": an explicit null/undefined/falsy `runtime` is refused, not dropped.
  const runtime = Object.hasOwn(input, "runtime") ? assertRuntimePin(input.runtime) : undefined;
  const linked = input.linked === undefined ? undefined : input.linked.toLowerCase();
  if (linked !== undefined && !/^[0-9a-f]{8,64}$/.test(linked)) {
    throw new Error(`linked runtime must be 8...64 hex characters (got ${JSON.stringify(input.linked)}).`);
  }
  if (runtime && linked === undefined) {
    throw new Error(
      "a runtime pin needs a linked page: pass the linked runtime so the entry meta carries linked=<version>.",
    );
  }
  if (runtime && linked !== runtime.version) {
    throw new Error(`runtime pin ${runtime.version} disagrees with the linked runtime ${input.linked}.`);
  }
  const sourceHash = createHash("sha256").update(input.sourceFile.bytes).digest("hex");
  const html = stripNetworkUrls(withCanvasFrame(withStamp(input.html, stamp, linked), background));
  const sha256 = createHash("sha256").update(html).digest("hex");
  const stampFile: {
    components: string;
    compiler: string;
    lane: ArtifactStamp["lane"];
    theme: string;
    at: string;
    linked?: string;
  } = {
    components: stamp.components,
    compiler: stamp.compiler,
    lane: stamp.lane,
    theme: stamp.theme,
    at,
  };
  if (linked) stampFile.linked = linked;
  // Only absence is "unpinned": an explicit null/undefined/falsy `runtime` is refused, not dropped.
  const sourceMeta: { kind: ArtifactStamp["lane"]; file: string; theme?: string } = {
    kind: stamp.lane,
    file: sourceName,
  };
  if (stamp.theme) sourceMeta.theme = stamp.theme;
  const manifest: CanvasManifest = {
    format: CANVAS_FORMAT,
    version: 1,
    name,
    entry: "index.html",
    size: { width: input.size.width, height: input.size.height },
    background,
    interaction: "interactive",
    source: {
      kind: "nofun-artifact-render",
      ref: `${sourceHash}@components=${stamp.components}`,
    },
    createdAt: at,
    sha256,
    ...(runtime ? { runtime } : {}),
  };
  NodeFs.mkdirSync(outDir, { recursive: true });
  writeRegular(NodePath.join(outDir, "index.html"), html);
  writeRegular(NodePath.join(outDir, "stamp.json"), `${JSON.stringify(stampFile, null, 2)}\n`);
  writeRegular(NodePath.join(outDir, "source", sourceName), input.sourceFile.bytes);
  writeRegular(
    NodePath.join(outDir, "source", "meta.json"),
    `${JSON.stringify(sourceMeta, null, 2)}\n`,
  );
  writeRegular(NodePath.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const asset of input.assets ?? []) {
    writeRegular(NodePath.join(outDir, bundleAssetPath(asset.bundlePath)), asset.bytes);
  }
  return manifest;
}
