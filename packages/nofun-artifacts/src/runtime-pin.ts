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

/**
 * Strict: a plain object with exactly the own keys `version` and `sha256`, both strings in the
 * contract shape. Numbers, null, arrays, extra keys and empty values are refused, never coerced.
 * Only the ABSENCE of a pin means "unpinned"; callers must not pass a falsy placeholder.
 */
export function assertRuntimePin(value: unknown): RuntimePin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`runtime pin must be an object {version, sha256} (got ${JSON.stringify(value) ?? "undefined"}).`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("runtime pin must be a plain object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "sha256" || keys[1] !== "version") {
    throw new Error(`runtime pin keys must be exactly version and sha256 (got ${JSON.stringify(keys)}).`);
  }
  const { version, sha256 } = value as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`runtime version must be a string of 8...64 lowercase hex (got ${JSON.stringify(version)}).`);
  }
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) {
    throw new Error(`runtime sha256 must be a string of 64 lowercase hex (got ${JSON.stringify(sha256)}).`);
  }
  return { version, sha256 };
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
  const override = process.env.NOFUN_UI_RUNTIME_ROOT?.trim();
  if (override) return override;
  const here = NodePath.dirname(fileURLToPath(import.meta.url));
  const dev = NodePath.join(here, "..", "dist", "nofun-ui-runtime");
  if (NodeFs.existsSync(dev)) return dev;
  // The packaged tool-bundle entry runs one level deeper (src/live/) than this file (src/), so
  // `../dist` lands in `src/dist`; fall back to the staged package-level `dist`.
  return NodePath.join(here, "..", "..", "dist", "nofun-ui-runtime");
}

/** The pin for `version`, read from its runtime folder. Throws when the folder is not there. */
export function readRuntimePin(version: string, root = runtimeRoot()): RuntimePin {
  if (typeof version !== "string") throw new Error("runtime version must be a string.");
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
