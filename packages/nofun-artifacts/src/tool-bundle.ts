// What `nofun_artifact_render` writes when the caller asks for a bundle: a linked-lane compile (the page
// loads the pinned No Fun UI runtime instead of inlining a copy) packaged as a Canvas bundle directory
// whose manifest pins that runtime's version and sha256. The thread keeps showing the self-contained page.
import { randomBytes } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import {
  parseCanvasBackground,
  parseCanvasSize,
  writeCanvasBundle,
  type CanvasManifest,
} from "./canvas-bundle.ts";
import { compileLinked } from "./linked.ts";
import { componentsCommit, readComponentsPin } from "./live/source.ts";
import { readRuntimePin, type RuntimePin } from "./runtime-pin.ts";
import { compilerVersion, stampInstant, type ArtifactStamp } from "./stamp.ts";

export const DEFAULT_BUNDLE_SIZE = "640x480";

export interface ToolBundleOptions {
  /** `WxH`, 16..4096 each. Defaults to 640x480. */
  readonly size?: string | undefined;
  /** `transparent`, `match` or `#rrggbb`. Defaults to transparent. */
  readonly background?: string | undefined;
  /** Runtime folder name. Defaults to `NOFUN_UI_RUNTIME_VERSION`, else the first 12 hex of components.pin. */
  readonly runtimeVersion?: string | undefined;
}

export interface ToolBundleInput extends ToolBundleOptions {
  readonly spec?: unknown;
  readonly tsx?: string | undefined;
  readonly theme?: string | undefined;
  readonly title: string;
  /** Folder that receives `<slug>-<sha12>/`. */
  readonly outRoot: string;
  /** Runtime folder root; defaults to `NOFUN_UI_RUNTIME_ROOT` or `dist/nofun-ui-runtime` (see runtime-pin.ts). */
  readonly runtimeRoot?: string | undefined;
  /** The build instant. Defaults to the wall clock. */
  readonly now?: Date | undefined;
}

export interface ToolBundle {
  readonly dir: string;
  readonly manifestPath: string;
  readonly manifest: CanvasManifest;
  readonly runtime: RuntimePin;
}

export function defaultRuntimeVersion(): string {
  const fromEnv = process.env.NOFUN_UI_RUNTIME_VERSION?.trim().toLowerCase();
  return fromEnv || readComponentsPin().slice(0, 12);
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "artifact";

/** Compiles the artifact against the pinned runtime and writes the bundle directory. */
export async function emitToolBundle(input: ToolBundleInput): Promise<ToolBundle> {
  const hasSpec = input.spec !== undefined && input.spec !== null;
  const hasTsx = typeof input.tsx === "string" && input.tsx.trim() !== "";
  if (hasSpec === hasTsx) {
    throw new Error("Pass exactly one of `spec` (a catalog spec) or `tsx` (custom React).");
  }
  const size = parseCanvasSize(input.size ?? DEFAULT_BUNDLE_SIZE);
  const background = parseCanvasBackground(input.background ?? "transparent");
  const version = (input.runtimeVersion ?? defaultRuntimeVersion()).trim().toLowerCase();
  const runtime = readRuntimePin(version, input.runtimeRoot);
  const lane = hasSpec ? "spec" : "tsx";
  const sourceText = hasSpec
    ? JSON.stringify(typeof input.spec === "string" ? JSON.parse(input.spec) : input.spec, null, 2)
    : input.tsx!;
  const compiled = await compileLinked({
    lane,
    source: hasSpec ? sourceText : input.tsx!,
    theme: input.theme,
    size,
    runtimeSHA: runtime.version,
    title: input.title,
  });
  const stamp: ArtifactStamp = {
    components: componentsCommit(),
    compiler: compilerVersion(),
    lane: compiled.lane,
    theme: compiled.theme,
    at: stampInstant(input.now),
  };
  const outRoot = NodePath.resolve(input.outRoot);
  NodeFs.mkdirSync(outRoot, { recursive: true });
  const staging = NodePath.join(outRoot, `.staging-${randomBytes(6).toString("hex")}`);
  try {
    const manifest = writeCanvasBundle({
      outDir: staging,
      html: compiled.html,
      name: input.title,
      size,
      background,
      stamp,
      linked: runtime.version,
      runtime,
      sourceFile: {
        name: hasSpec ? "artifact.spec.json" : "artifact.tsx",
        bytes: Buffer.from(sourceText),
      },
    });
    // The id is the entry digest, so a repeat of identical bytes lands on the same folder.
    const dir = NodePath.join(outRoot, `${slug(input.title)}-${manifest.sha256.slice(0, 12)}`);
    NodeFs.rmSync(dir, { recursive: true, force: true });
    NodeFs.renameSync(staging, dir);
    return { dir, manifestPath: NodePath.join(dir, "manifest.json"), manifest, runtime };
  } finally {
    NodeFs.rmSync(staging, { recursive: true, force: true });
  }
}
