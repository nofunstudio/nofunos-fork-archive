/**
 * Server build identity: the SHA (and version, when known) of the server
 * executable that is currently running.
 *
 * Mechanism: resolved at runtime from the build environment, first wins:
 * - `NOFUN_SERVER_BUILD_SHA`: full git SHA of the built source.
 * - `NOFUN_SERVER_BUILD_VERSION`: package version stamped at build time
 *   (for example the `@t3tools` server package version).
 *
 * Blank or absent values resolve to `null` (unknown). There is deliberately
 * no generated build-info file to read: that would need pack-system changes,
 * and env injection at install/start is the smallest robust source. The
 * single PM build must export both variables before starting the server;
 * `orchestrator_capabilities` reports them verbatim so root can record the
 * packaged version/SHA per the J01 runbook.
 *
 * SHA is the build identity; version is only an ordering diagnostic for the
 * admission refusal message ("older" vs "not equal"). Admission engages only
 * when the mission pins a required build, and refuses an unknown running
 * build in that case (fail closed where a pin exists, legacy pass where it
 * does not).
 *
 * @module ServerBuildIdentity
 */

/** SHA and version of one server build; `null` members mean unknown. */
export interface ServerBuild {
  readonly sha: string | null;
  readonly version: string | null;
}

/** Minimal env surface, so tests pass a record and production passes `process.env`. */
export interface ServerBuildEnv {
  readonly NOFUN_SERVER_BUILD_SHA?: string | undefined;
  readonly NOFUN_SERVER_BUILD_VERSION?: string | undefined;
}

const clean = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** Resolve the running server build from the build environment. */
export const readServerBuild = (env: ServerBuildEnv): ServerBuild => ({
  sha: clean(env.NOFUN_SERVER_BUILD_SHA),
  version: clean(env.NOFUN_SERVER_BUILD_VERSION),
});

/** Resolve the running server build from `process.env`. */
export const resolveServerBuild = (): ServerBuild => readServerBuild(process.env);

/** True only when both SHAs are known and equal. Version never decides identity. */
export const isSameBuild = (running: ServerBuild, required: ServerBuild): boolean =>
  running.sha !== null && running.sha === required.sha;

const numericSegments = (version: string): Array<number> | null => {
  const core = version.split("+", 1)[0]!.split("-", 1)[0]!;
  const parts = core.split(".");
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.map(Number);
};

/**
 * Order two versions: -1/0/1, or `null` when either side is missing or not a
 * numeric dot-separated version. Pre-release/build metadata is ignored.
 */
export const compareBuildVersions = (
  running: string | null,
  required: string | null,
): -1 | 0 | 1 | null => {
  if (running === null || required === null) return null;
  const left = numericSegments(running);
  const right = numericSegments(required);
  if (left === null || right === null) return null;
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
};

export type BuildCurrency =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown-running" | "older" | "not-equal" };

/**
 * Assess the running build against the build the mission requires.
 * A `null` requirement means the mission pins no build: pass (legacy).
 * Otherwise refuse an unknown running build or a SHA mismatch; report
 * "older" only when both versions order the running build below required.
 */
export const assessBuildCurrency = (
  running: ServerBuild,
  required: ServerBuild | null,
): BuildCurrency => {
  if (required === null) return { ok: true };
  if (running.sha === null) return { ok: false, reason: "unknown-running" };
  if (running.sha === required.sha) return { ok: true };
  return compareBuildVersions(running.version, required.version) === -1
    ? { ok: false, reason: "older" }
    : { ok: false, reason: "not-equal" };
};
