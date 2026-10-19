#!/usr/bin/env node
// `nofun-artifacts compile` writes a Canvas bundle directory from a spec, tsx, or page file.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { parseCanvasBackground, parseCanvasSize, writeCanvasBundle } from "./canvas-bundle.ts";
import { compileArtifact, compilePage } from "./compiler.ts";
import { compileLinked } from "./linked.ts";
import { inlineStageAssets, stageAssets } from "./live/assets.ts";
import { closeProbe } from "./live/probe.ts";
import { componentsCommit } from "./live/source.ts";
import { findRuntimePin, readRuntimePin, type RuntimePin } from "./runtime-pin.ts";
import { canvasPreset, withPresetCss, withPresetDefaults } from "./presets.ts";
import {
  compilerVersion,
  deterministicStampInstant,
  readStamp,
  type ArtifactStamp,
} from "./stamp.ts";

const USAGE =
  "nofun-artifacts compile (--spec <file> | --tsx <file> | --page <file>) (--preset <id> | --theme <id> --size WxH) [--background transparent|match|#rrggbb] [--name <name>] [--asset-dir <dir>] [--linked --runtime-sha <sha>] --out <dir>";

interface Flags {
  preset?: string;
  spec?: string;
  tsx?: string;
  page?: string;
  theme?: string;
  size?: string;
  background?: string;
  name?: string;
  assetDir?: string;
  out?: string;
  linked?: boolean;
  runtimeSha?: string;
}

function specTitle(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { title?: unknown };
    return typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = (name: Exclude<keyof Flags, "linked">) => {
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      if (flags[name]) throw new Error(`${flag} was passed twice.`);
      flags[name] = value;
      i += 1;
    };
    switch (flag) {
      case "--preset":
        take("preset");
        break;
      case "--spec":
        take("spec");
        break;
      case "--tsx":
        take("tsx");
        break;
      case "--page":
        take("page");
        break;
      case "--theme":
        take("theme");
        break;
      case "--size":
        take("size");
        break;
      case "--background":
        take("background");
        break;
      case "--name":
        take("name");
        break;
      case "--asset-dir":
        take("assetDir");
        break;
      case "--out":
        take("out");
        break;
      case "--linked":
        if (flags.linked) throw new Error("--linked was passed twice.");
        flags.linked = true;
        break;
      case "--runtime-sha":
        take("runtimeSha");
        break;
      default:
        throw new Error(`Unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
    }
  }
  return flags;
}

function requireBundleIndex(outDir: string): void {
  const indexHtml = NodePath.join(NodePath.resolve(outDir), "index.html");
  let stat: NodeFs.Stats | undefined;
  try {
    stat = NodeFs.lstatSync(indexHtml);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!stat?.isFile()) {
    throw new Error(`compile produced no bundle/index.html at ${indexHtml}.`);
  }
}

async function compile(argv: readonly string[]): Promise<void> {
  const flags = withPresetDefaults(parseFlags(argv));
  const preset = flags.preset ? canvasPreset(flags.preset) : undefined;
  const chosen = [flags.spec, flags.tsx, flags.page].filter((file) => file !== undefined);
  if (chosen.length !== 1)
    throw new Error(`Pass exactly one of --spec, --tsx, or --page. ${USAGE}`);
  if (!flags.theme) throw new Error(`--theme is required. ${USAGE}`);
  if (!flags.size) throw new Error(`--size is required. ${USAGE}`);
  if (!flags.out) throw new Error(`--out is required. ${USAGE}`);
  if (flags.linked && !flags.runtimeSha) {
    throw new Error(`--linked needs --runtime-sha <sha>. ${USAGE}`);
  }
  if (flags.runtimeSha && !flags.linked) {
    throw new Error(`--runtime-sha needs --linked. ${USAGE}`);
  }
  // Tests set this to force the missing-bundle exit without a components checkout.
  if (process.env.NOFUN_ARTIFACTS_FORCE_NO_OUTPUT === "1") {
    requireBundleIndex(flags.out);
    return;
  }
  const file = chosen[0]!;
  const lane = flags.spec ? "spec" : flags.tsx ? "tsx" : "page";
  if (flags.linked && lane === "page") {
    throw new Error(`--linked supports --spec and --tsx, not --page. ${USAGE}`);
  }
  const bytes = NodeFs.readFileSync(file);
  const text = bytes.toString("utf8");
  const staged = flags.assetDir ? stageAssets(flags.assetDir, text) : undefined;
  const sourceText = staged?.text ?? text;
  const theme = flags.theme;
  const title = flags.name?.trim() || (lane === "spec" ? specTitle(text) : undefined);
  const size = parseCanvasSize(flags.size);
  const background = parseCanvasBackground(flags.background ?? "transparent");
  const compiled = flags.linked
    ? await compileLinked({
        lane: lane === "tsx" ? "tsx" : "spec",
        source: sourceText,
        theme,
        size,
        runtimeSHA: flags.runtimeSha!,
        ...(title ? { title } : {}),
        ...(preset ? { scheme: preset.scheme } : {}),
      })
    : lane === "page"
      ? await compilePage({
          spec: sourceText,
          brand: theme,
          ...(title ? { title } : {}),
          ...(preset ? { scheme: preset.scheme } : {}),
        })
      : await compileArtifact(
          lane === "tsx"
            ? { tsx: sourceText, theme, ...(title ? { title } : {}) }
            : { spec: sourceText, theme, ...(title ? { title } : {}) },
        );
  const stamp: ArtifactStamp | undefined = flags.linked
    ? {
        components: componentsCommit(),
        compiler: compilerVersion(),
        lane: compiled.lane,
        theme: compiled.theme,
        at: deterministicStampInstant(bytes, componentsCommit()),
      }
    : readStamp(compiled.html);
  if (!stamp) throw new Error("Compiled HTML is missing the nofun-artifact stamp.");
  let html = preset ? withPresetCss(compiled.html, preset) : compiled.html;
  if (staged) html = inlineStageAssets(html, staged.files);
  // A-G1: the manifest pins the runtime. A linked page names its runtime folder and must find it;
  // an inline page carries its own copy of the code, so it pins the runtime of its components
  // revision when that runtime is built, and says so when it is not.
  let runtime: RuntimePin | undefined;
  if (flags.linked) {
    runtime = readRuntimePin(flags.runtimeSha!);
  } else {
    runtime = findRuntimePin(stamp.components.slice(0, 12));
    if (!runtime) {
      console.warn(
        `no built runtime for components ${stamp.components.slice(0, 12)}; the manifest carries no runtime pin`,
      );
    }
  }
  const manifest = writeCanvasBundle({
    outDir: flags.out,
    html,
    name: "title" in compiled ? compiled.title : title || "No Fun artifact",
    size,
    background,
    stamp,
    ...(flags.runtimeSha ? { linked: flags.runtimeSha } : {}),
    ...(runtime ? { runtime } : {}),
    ...(staged && staged.files.length > 0 ? { assets: staged.files } : {}),
    sourceFile: { name: NodePath.basename(file), bytes },
  });
  requireBundleIndex(flags.out);
  console.log(
    `${manifest.name} ${compiled.lane} ${(compiled.bytes / 1024).toFixed(0)} KiB → ${NodePath.resolve(flags.out)}`,
  );
  if ("skippedAssets" in compiled && compiled.skippedAssets.length > 0) {
    console.warn(`left out ${compiled.skippedAssets.length} images over the page cap`);
  }
  if (staged && staged.skippedInline.length > 0) {
    console.warn(
      `left ${staged.skippedInline.length} stage images as files; they did not fit in #nf-assets`,
    );
  }
  await closeProbe();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new Error(USAGE);
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (argv[0] !== "compile")
    throw new Error(`Unknown command ${JSON.stringify(argv[0])}. ${USAGE}`);
  await compile(argv.slice(1));
}

// Node realpaths the module URL (macOS /tmp -> /private/tmp, and
// --experimental-strip-types does the same) while argv keeps the path it was
// given. Compare real paths. A mismatch used to fall off the end and exit 0.
function directInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      NodeFs.realpathSync(NodePath.resolve(entry)) ===
      NodeFs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (directInvocation()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
} else {
  const entry = process.argv[1] ? NodePath.resolve(process.argv[1]) : "(missing argv[1])";
  let here = fileURLToPath(import.meta.url);
  try {
    here = NodeFs.realpathSync(here);
  } catch {
    // The module path can be missing in a torn checkout; report it as-is.
  }
  console.error(`nofun-artifacts did not run: ${entry} is not this CLI (${here}) after realpath.`);
  process.exit(2);
}
