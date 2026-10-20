/**
 * The main sidebar is split by team: No Fun on top, CATCHES below. These are the
 * pure rules for that split, the "latest chat first" pick, and the per-thread
 * work counts. Presentational only; the server owns persona scope.
 */
import type { EnvironmentId, NofunPersonaInfo } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export interface SidebarTeam {
  readonly id: string;
  readonly label: string;
}

const NOFUN_TEAM_ID = "nofun";

export function personaIdOf(persona: NofunPersonaInfo | undefined): string {
  return persona?.id ?? NOFUN_TEAM_ID;
}

/** Teams among connected environments: No Fun first, then the rest by label. */
export function sidebarTeams(
  environments: Iterable<{ readonly persona?: NofunPersonaInfo | undefined }>,
): ReadonlyArray<SidebarTeam> {
  const teams = new Map<string, SidebarTeam>();
  for (const { persona } of environments) {
    const id = personaIdOf(persona);
    if (!teams.has(id)) teams.set(id, { id, label: persona?.label ?? "No Fun" });
  }
  return [...teams.values()].toSorted((left, right) =>
    left.id === NOFUN_TEAM_ID
      ? -1
      : right.id === NOFUN_TEAM_ID
        ? 1
        : left.label.localeCompare(right.label),
  );
}

/** Threads whose environment belongs to `teamId`; `null` keeps every thread. */
export function threadsOfTeam<T extends Pick<EnvironmentThreadShell, "environmentId">>(
  threads: ReadonlyArray<T>,
  teamId: string | null,
  teamByEnvironment: ReadonlyMap<EnvironmentId, string>,
): ReadonlyArray<T> {
  if (teamId === null) return threads;
  return threads.filter(
    (thread) => (teamByEnvironment.get(thread.environmentId) ?? NOFUN_TEAM_ID) === teamId,
  );
}

function parseMs(value: string | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * When the user or the agent last did something in the thread: the later of the
 * latest user message and the latest run activity, else when it was created.
 * Not `updatedAt`, which settling, pinning and renaming also move.
 */
export function threadActivityMs(
  thread: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestRun" | "createdAt">,
): number {
  const run = thread.latestRun;
  const latest = Math.max(
    parseMs(thread.latestUserMessageAt),
    parseMs(run?.completedAt),
    parseMs(run?.startedAt),
    parseMs(run?.requestedAt),
  );
  return Number.isFinite(latest) ? latest : parseMs(thread.createdAt);
}

export interface PickLatestThreadSubagents<
  T extends Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestRun" | "createdAt">,
> {
  readonly getKey: (thread: T) => string;
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<T>>;
}

/**
 * The most recently active thread; ties keep the earlier entry. A parent's
 * most recent subagent child activity counts as the parent's own, so work
 * that runs entirely in delegated children still surfaces the parent first.
 */
export function pickLatestThread<
  T extends Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestRun" | "createdAt">,
>(threads: ReadonlyArray<T>, subagents?: PickLatestThreadSubagents<T>): T | null {
  let best: T | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    let ms = threadActivityMs(thread);
    const children =
      subagents === undefined
        ? undefined
        : subagents.childrenByParentKey.get(subagents.getKey(thread));
    if (children !== undefined) {
      for (const child of children) ms = Math.max(ms, threadActivityMs(child));
    }
    if (best === null || ms > bestMs) {
      best = thread;
      bestMs = ms;
    }
  }
  return best;
}

export interface ThreadWorkCounts {
  readonly subagents: number;
  readonly background: number;
}

/** Running subagents and background tasks; servers that predate the fields read as none. */
export function threadWorkCounts(
  thread: Pick<EnvironmentThreadShell, "activeSubagentCount" | "activeBackgroundTaskCount">,
): ThreadWorkCounts {
  return {
    subagents: thread.activeSubagentCount ?? 0,
    background: thread.activeBackgroundTaskCount ?? 0,
  };
}
