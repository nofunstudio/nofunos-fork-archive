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
  readonly maxObservationAgeMs?: number;
}

/** Below this share left, a window is worth preserving. */
const LOW_PERCENT = 15;

/**
 * Muse quota is observed only during useful work, so a 30-minute budget marks
 * a still-open weekly window stale. Twelve hours is long enough for that
 * passive reading and short of treating yesterday's weekly as current.
 */
const MUSE_OBSERVATION_BUDGET_MS = 12 * 60 * 60_000;

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
function gatingWindows(limits: ServerProviderUsageLimits, model: string | undefined) {
  return limits.windows.filter(
    (window) =>
      window.appliesToModel === undefined ||
      model === undefined ||
      modelScopeApplies(window.appliesToModel, model),
  );
}

/**
 * Muse routing view. A window whose reset passed since the observation is
 * dropped, so a replenished 5-hour pool cannot be treated as still spent or
 * still full. Windows that have not reset keep the reading for
 * {@link MUSE_OBSERVATION_BUDGET_MS}. When every window has reset, the
 * original snapshot is returned so headroom stays unknown.
 */
export function museUsageForRouting(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly maxObservationAgeMs: number;
} {
  if (!limits || limits.unavailable) {
    return { limits, maxObservationAgeMs: MUSE_OBSERVATION_BUDGET_MS };
  }
  const checkedMs = Date.parse(limits.checkedAt);
  const windows = limits.windows.filter((window) => {
    if (!window.resetsAt) return true;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs) || resetMs > nowMs) return true;
    return Number.isFinite(checkedMs) && checkedMs > resetMs;
  });
  if (windows.length === 0) {
    return { limits, maxObservationAgeMs: 30 * 60_000 };
  }
  return {
    limits: windows.length === limits.windows.length ? limits : { ...limits, windows },
    maxObservationAgeMs: MUSE_OBSERVATION_BUDGET_MS,
  };
}

export function usageHeadroom(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
  options?: UsageHeadroomOptions,
): { readonly headroom: UsageHeadroom; readonly summary: string } {
  const model = options?.model;
  const fresh = limits && !limits.unavailable ? limits : undefined;
  if (!fresh) return { headroom: "unknown", summary: "usage not reported" };
  const checkedMs = Date.parse(fresh.checkedAt);
  const maxAge = options?.maxObservationAgeMs ?? 30 * 60_000;
  if (
    !Number.isFinite(checkedMs) ||
    checkedMs > nowMs ||
    !Number.isFinite(maxAge) ||
    maxAge < 0 ||
    nowMs - checkedMs > maxAge
  ) {
    return { headroom: "unknown", summary: "usage observation is stale or unavailable" };
  }
  const windows = gatingWindows(fresh, model);
  if (windows.length === 0) {
    if (fresh.windows.length > 0) {
      return { headroom: "unknown", summary: `no usage windows apply to ${model}` };
    }
    return { headroom: "unknown", summary: "usage not reported" };
  }
  // A reset that passed since the last observation leaves stale numbers: the
  // window may have replenished, or the provider may not have reset it. Read
  // that as stale, never as headroom.
  const stale = windows.some((window) => {
    if (!window.resetsAt) return false;
    const resetMs = Date.parse(window.resetsAt);
    return (
      Number.isFinite(resetMs) &&
      resetMs <= nowMs &&
      !(Number.isFinite(checkedMs) && checkedMs > resetMs)
    );
  });
  if (stale) {
    return { headroom: "unknown", summary: "usage stale (a window reset since the last check)" };
  }
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
