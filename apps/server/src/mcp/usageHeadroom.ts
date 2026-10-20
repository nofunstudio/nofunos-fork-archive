/**
 * Usage headroom for delegation routing: one verdict per provider instance
 * from its live quota windows, so an orchestrating agent can route around a
 * pool that is nearly spent and leave it for work only it can do.
 *
 * Classification is deliberately pessimistic: a spent window stays spent and
 * a low window stays low no matter how soon it resets, and numbers observed
 * before a reset that has since passed read as stale rather than
 * replenished. Anything less would admit unattended fan-out onto a pool
 * that may already be empty.
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

export type UsageHeadroom = "ok" | "low" | "exhausted" | "unknown";

export interface UsageHeadroomOptions {
  /**
   * Model slug or display name the routed work would run on. Model-scoped
   * windows for other models do not gate it; windows without a scope gate
   * every model, and without a selected model every window gates.
   */
  readonly model?: string;
  /** Admission may use a stricter observation budget; this never refreshes usage. */
  readonly maxObservationAgeMs?: number | undefined;
  /**
   * Passive-only sources (Muse) record observations only during useful work,
   * so an idle account goes stale by the clock while its quota window has
   * not reset. When true, an observation older than `maxObservationAgeMs`
   * is still classified from its observed numbers while no gating window
   * has reset since the observation; after a reset it reports a bounded
   * stale-but-likely-fresh headroom (from the weekly window when that one
   * has not reset, else `ok` only inside `PASSIVE_POST_RESET_GRACE_MS`)
   * instead of unknown. Observed low/exhausted numbers stay low/exhausted
   * either way. Default false: every other source keeps the pessimistic
   * clock rule. This never refreshes usage.
   */
  readonly trustUnresetWindow?: boolean | undefined;
}

/**
 * Post-reset grace for passive-only sources (Muse): once every gating
 * window has reset since the observation, the old healthy reading stays
 * admissible for at most one weekly quota period past the observation, and
 * never past the next weekly reset after the observed weekly reset (the
 * observed weekly `resetsAt` plus one weekly period). Past that bound the
 * current weekly quota may already be spent by intervening work outside
 * this observation stream, so the verdict is `unknown` and admission falls
 * back to the bounded unknown-usage exception.
 */
const PASSIVE_POST_RESET_GRACE_MS = 7 * 24 * 60 * 60_000;

/** Below this share left, a window is worth preserving. */
const LOW_PERCENT = 15;

const WINDOW_NAME: Record<ServerProviderUsageWindow["kind"], string> = {
  session: "5h",
  weekly: "weekly",
  monthly: "monthly",
  other: "window",
};

function formatIn(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Display names and slugs to one comparable form (`Fable` matches `fable`). */
function normalizeModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function modelScopeApplies(scope: string, selected: string): boolean {
  const family = (value: string) => {
    const normalized = normalizeModel(value).replace(/^claude_/, "");
    return normalized.replace(/_\d.*$/, "");
  };
  const scopedFamily = family(scope);
  const selectedFamily = family(selected);
  if (normalizeModel(scope) === normalizeModel(selected) || scopedFamily === selectedFamily)
    return true;
  // The producer currently names Claude families. An unknown family relation
  // remains applicable until a typed adapter mapping can prove it irrelevant.
  const claudeFamilies = new Set(["fable", "opus", "sonnet", "haiku"]);
  return !(claudeFamilies.has(scopedFamily) && claudeFamilies.has(selectedFamily));
}

/**
 * The windows that gate routing for the selected model. Applicability is
 * typed (`appliesToModel`): unscoped windows gate every model, and without
 * a selected model every window gates. Labels are never inspected.
 */
function gatingWindows(
  limits: ServerProviderUsageLimits,
  model: string | undefined,
  nowMs: number,
  maxAge?: number,
  trustUnresetWindow?: boolean,
) {
  let windows = limits.windows.filter(
    (window) =>
      window.appliesToModel === undefined ||
      model === undefined ||
      modelScopeApplies(window.appliesToModel, model),
  );
  if (!windows.some((window) => window.routingPool !== undefined)) return windows;
  // Cursor's overall percentage is a display aggregate, not a third limit.
  windows = windows.filter((window) => window.routingPool !== "aggregate");
  if (model === undefined) return windows;
  const selected = normalizeModel(model);
  const hasCursorFallback = /^(?:grok|composer)(?:_|$)/.test(selected);
  const apiOnly = /^(?:claude|gpt|gemini|o[134])(?:_|$)/.test(selected);
  const unpooled = windows.filter((window) => window.routingPool === undefined);
  if (apiOnly) return [...unpooled, ...windows.filter((window) => window.routingPool === "api")];
  // Auto and unrecognized model routes can draw either pool. Keep both
  // applicable rather than guessing which allowance the provider will charge.
  if (!hasCursorFallback) return windows;
  const primary = windows.filter((window) => window.routingPool === "cursor");
  const verdict = usageHeadroom(
    { ...limits, windows: primary.map(({ routingPool: _pool, ...row }) => row) },
    nowMs,
    { maxObservationAgeMs: maxAge, trustUnresetWindow },
  );
  // Grok/Composer consume Cursor Models first, then Other Models. A low or
  // unknown primary cannot become healthy just because the fallback has room.
  return [
    ...unpooled,
    ...(verdict.headroom === "exhausted"
      ? windows.filter((window) => window.routingPool === "api")
      : primary),
  ];
}

/**
 * Classify already-validated gating windows from their observed numbers.
 * Shared by the strict path and the passive lenient path below.
 */
function classifyWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  nowMs: number,
): { readonly headroom: UsageHeadroom; readonly summary: string } {
  let headroom: UsageHeadroom = "ok";
  const parts = windows.map((window) => {
    // Classify on the exact share: 99.6% used is low with ~0% displayed,
    // never exhausted; only a truly spent window reads as exhausted.
    const leftExact = 100 - window.usedPercent;
    const left = Math.max(0, Math.round(leftExact));
    if (leftExact <= 0) headroom = "exhausted";
    else if (leftExact < LOW_PERCENT && headroom !== "exhausted") headroom = "low";
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) - nowMs : null;
    const reset = resetMs !== null && resetMs > 0 ? ` (resets in ${formatIn(resetMs)})` : "";
    // Session and account-wide weekly read best as 5h/weekly; scoped
    // windows and other kinds keep their own label so repeated pools (Cursor
    // has three monthly ones, Claude names its model weeklies) stay distinct.
    const name =
      window.appliesToModel !== undefined || (window.kind !== "session" && window.kind !== "weekly")
        ? window.label
        : WINDOW_NAME[window.kind];
    return `${name} ${left}% left${reset}`;
  });
  return { headroom, summary: parts.join(" · ") };
}

/** True when a window reset passed since the observation without a newer read. */
function resetSinceObservation(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  checkedMs: number,
  nowMs: number,
): boolean {
  return windows.some((window) => {
    if (!window.resetsAt) return false;
    const resetMs = Date.parse(window.resetsAt);
    return (
      Number.isFinite(resetMs) &&
      resetMs <= nowMs &&
      !(Number.isFinite(checkedMs) && checkedMs > resetMs)
    );
  });
}

export function usageHeadroom(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
  options?: UsageHeadroomOptions,
): { readonly headroom: UsageHeadroom; readonly summary: string } {
  const model = options?.model;
  const trustUnresetWindow = options?.trustUnresetWindow ?? false;
  const fresh = limits && !limits.unavailable ? limits : undefined;
  if (!fresh) return { headroom: "unknown", summary: "usage not reported" };
  const checkedMs = Date.parse(fresh.checkedAt);
  const maxAge = options?.maxObservationAgeMs ?? 30 * 60_000;
  if (!Number.isFinite(checkedMs) || checkedMs > nowMs || !Number.isFinite(maxAge) || maxAge < 0) {
    return { headroom: "unknown", summary: "usage observation is stale or unavailable" };
  }
  const overAge = nowMs - checkedMs > maxAge;
  const windows = gatingWindows(fresh, model, nowMs, maxAge, trustUnresetWindow);
  if (windows.length === 0) {
    if (fresh.windows.length > 0) {
      return { headroom: "unknown", summary: `no usage windows apply to ${model}` };
    }
    return { headroom: "unknown", summary: "usage not reported" };
  }
  if (
    windows.some(
      (window) =>
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100 ||
        (window.resetsAt !== undefined && !Number.isFinite(Date.parse(window.resetsAt))),
    )
  ) {
    return { headroom: "unknown", summary: "usage window is malformed" };
  }
  // A reset that passed since the last observation leaves stale numbers: the
  // window may have replenished, or the provider may not have reset it. Read
  // that as stale, never as headroom.
  const stale = resetSinceObservation(windows, checkedMs, nowMs);
  if (!trustUnresetWindow) {
    if (overAge) {
      return { headroom: "unknown", summary: "usage observation is stale or unavailable" };
    }
    if (stale) {
      return { headroom: "unknown", summary: "usage stale (a window reset since the last check)" };
    }
    return classifyWindows(windows, nowMs);
  }
  return stalePassiveHeadroom(windows, checkedMs, nowMs);
}

/**
 * Passive-only verdict for an observation past its clock budget. Observed
 * low/exhausted numbers stay low/exhausted: a reset may not have
 * replenished them. Healthy numbers are trusted while no gating window has
 * reset since the observation; after a reset the verdict falls back to the
 * windows that have not reset (the weekly quota), and only when every
 * window reset does it report a bounded stale-but-likely-fresh ok inside
 * `PASSIVE_POST_RESET_GRACE_MS` (unknown past the grace).
 */
function stalePassiveHeadroom(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  checkedMs: number,
  nowMs: number,
): { readonly headroom: UsageHeadroom; readonly summary: string } {
  const ageNote = `(observed ${formatIn(nowMs - checkedMs)} ago)`;
  const observed = classifyWindows(windows, nowMs);
  if (observed.headroom === "low" || observed.headroom === "exhausted") {
    return { headroom: observed.headroom, summary: `${observed.summary} ${ageNote}` };
  }
  if (!resetSinceObservation(windows, checkedMs, nowMs)) {
    return { headroom: "ok", summary: `${observed.summary} ${ageNote}` };
  }
  const unreset = windows.filter((window) => !resetSinceObservation([window], checkedMs, nowMs));
  if (unreset.length > 0) {
    const fallback = classifyWindows(unreset, nowMs);
    if (fallback.headroom === "low" || fallback.headroom === "exhausted") {
      return { headroom: fallback.headroom, summary: `${fallback.summary} ${ageNote}` };
    }
    return {
      headroom: "ok",
      summary: `${fallback.summary} (stale observation; a window reset since the last check) ${ageNote}`,
    };
  }
  // Every window reset since the observation: the numbers no longer bound
  // any live quota. Allow only the bounded post-reset grace, then read the
  // observation as stale so admission requires the bounded unknown-usage
  // exception instead of admitting on a previous period's healthy reading.
  const weeklyResets = windows
    .filter((window) => window.kind === "weekly" && window.resetsAt !== undefined)
    .map((window) => Date.parse(window.resetsAt as string))
    .filter((resetMs) => Number.isFinite(resetMs));
  const graceEndMs = Math.min(
    checkedMs + PASSIVE_POST_RESET_GRACE_MS,
    ...weeklyResets.map((resetMs) => resetMs + PASSIVE_POST_RESET_GRACE_MS),
  );
  if (nowMs > graceEndMs) {
    return {
      headroom: "unknown",
      summary: `usage observation is stale or unavailable (post-reset grace expired) ${ageNote}`,
    };
  }
  return {
    headroom: "ok",
    summary: `usage stale but likely fresh ${ageNote}`,
  };
}

/** A passive read of the real windows, with their original successful timestamp. */
export function usageHeadroomObservation(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
  options?: UsageHeadroomOptions,
) {
  const observed = limits && !limits.unavailable ? Date.parse(limits.checkedAt) : NaN;
  return {
    ...usageHeadroom(limits, nowMs, options),
    observedAt: Number.isFinite(observed) ? limits!.checkedAt : null,
    ageMs: Number.isFinite(observed) && observed <= nowMs ? nowMs - observed : null,
    windows: limits
      ? gatingWindows(
          limits,
          options?.model,
          nowMs,
          options?.maxObservationAgeMs,
          options?.trustUnresetWindow,
        )
      : [],
    readCost: "passive" as const,
  };
}
