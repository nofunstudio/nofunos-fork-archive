// The runtime pin written into every Canvas bundle manifest (`manifest.runtime`): which No Fun UI
// runtime (`nofun-ui-runtime/<version>/`, built by runtime-bundle/build.ts) the page was made for,
// and a digest of that runtime's files. Hosts compare it to the one runtime they ship and refuse a
// mismatch. Contract: nofun-canvas deps.lock `runtime` + the A1 CONTRACT.md.
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePin {
  /** The runtime folder name: 8...64 lowercase hex, the `linked=` value of a linked page. */
  readonly version: string;
  /** 64 lowercase hex, `runtimeDigest` of the runtime folder. */
  readonly sha256: string;
}

const VERSION = /^[0-9a-f]{8,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function assertRuntimePin(pin: RuntimePin): RuntimePin {
  if (!VERSION.test(pin.version)) {
    throw new Error(`runtime version must be 8...64 lowercase hex (got ${JSON.stringify(pin.version)}).`);
  }
  if (!DIGEST.test(pin.sha256)) {
    throw new Error(`runtime sha256 must be 64 lowercase hex (got ${JSON.stringify(pin.sha256)}).`);
  }
  return { version: pin.version, sha256: pin.sha256 };
}

const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The runtime digest: sha256 of `runtime.css:<sha256 of runtime.css>\nruntime.js:<sha256 of
 * runtime.js>\n`. Same bytes the host installs, so a host can recompute it from its own folder.
 */
export function runtimeDigest(runtimeDir: string): string {
  const parts = ["runtime.css", "runtime.js"].map((name) => {
    const file = NodePath.join(runtimeDir, name);
    if (NodeFs.lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`runtime folder ${runtimeDir} has no regular file ${name}.`);
    }
    return `${name}:${sha256Hex(NodeFs.readFileSync(file))}\n`;
  });
  return sha256Hex(parts.join(""));
}

/** Where built runtimes live: `NOFUN_UI_RUNTIME_ROOT`, else this package's `dist/nofun-ui-runtime`. */
export function runtimeRoot(): string {
  return (
    process.env.NOFUN_UI_RUNTIME_ROOT ?? NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "..", "dist", "nofun-ui-runtime")
  );
}

/** The pin for `version`, read from its runtime folder. Throws when the folder is not there. */
export function readRuntimePin(version: string, root = runtimeRoot()): RuntimePin {
  const lowered = version.toLowerCase();
  if (!VERSION.test(lowered)) throw new Error(`runtime version ${JSON.stringify(version)} is not lowercase hex.`);
  const dir = NodePath.join(root, lowered);
  if (NodeFs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`no built runtime at ${dir}; run \`pnpm run runtime:build\` for that components revision.`);
  }
  return assertRuntimePin({ version: lowered, sha256: runtimeDigest(dir) });
}

/** Like `readRuntimePin`, but undefined when the folder is absent (inline lanes warn instead of failing). */
export function findRuntimePin(version: string, root = runtimeRoot()): RuntimePin | undefined {
  try {
    return readRuntimePin(version, root);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no built runtime")) return undefined;
    throw error;
  }
}
