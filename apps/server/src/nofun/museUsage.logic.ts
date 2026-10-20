/**
 * Pure pieces of Muse subscription usage: the accounts file, sanitized
 * persisted observations, and the per-subscription wire snapshot. The service
 * in `MuseUsage.ts` owns the cache; it never spawns a probe, so every
 * observation here arrived passively (seen during useful work or delivered by
 * a passive reader) and every failure stays sanitized metadata.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous registry binding must match the standalone ACP reader byte for byte.
import * as NodeCrypto from "node:crypto";

import {
  ProviderDriverKind,
  type ServerProviderUsageWindow,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * One Muse Code subscription. Each account has its own launchers and its own
 * config and data roots, so sessions and credentials never share a home; the
 * app never switches accounts by rewriting an auth file.
 */
export const MuseAccount = Schema.Struct({
  /** Stable id stored on every job, e.g. `muse-personal`. */
  id: Schema.String.check(Schema.isMinLength(1)),
  /** Shown in the usage views, e.g. `Muse Personal`. */
  label: Schema.String.check(Schema.isMinLength(1)),
  /** The login this account must resolve to; a different one is refused. */
  expectedEmail: Schema.optional(Schema.String),
  /** Plan as the account center names it, when known. */
  plan: Schema.optional(Schema.String),
  /** `muse` CLI or a per-account launcher that pins its own roots. */
  cliExecutable: Schema.optional(Schema.String),
  /** `muse-worker.sh` or a per-account wrapper accepting the same flags. */
  workerExecutable: Schema.optional(Schema.String),
  /** XDG roots for the owned child process; launchers may pin their own. */
  configHome: Schema.optional(Schema.String),
  dataHome: Schema.optional(Schema.String),
});
export type MuseAccount = typeof MuseAccount.Type;

/**
 * The environment for one account's child process, built from the server's.
 * Account-routing variables are removed so the default lane keeps its
 * Keychain login, and a set META_API_KEY refuses the route outright: these
 * accounts run on the subscription and must never fall back to API billing.
 */
export function museChildEnvironment(
  account: MuseAccount,
  parent: Readonly<Record<string, string | undefined>>,
  dataHomeOverride?: string,
): { readonly env: Record<string, string> } | { readonly refused: string } {
  if (parent.META_API_KEY?.trim()) {
    return { refused: "META_API_KEY is set; Muse subscription routes refuse API billing." };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (key === "MUSE_AUTH_PATH" || key === "TBH_CREDENTIAL_BACKEND" || key === "META_API_KEY")
      continue;
    env[key] = value;
  }
  if (account.configHome) env.XDG_CONFIG_HOME = account.configHome;
  const dataHome = dataHomeOverride ?? account.dataHome;
  if (dataHome) env.XDG_DATA_HOME = dataHome;
  return { env };
}

/**
 * `muse-accounts.json` in the T3 home actually in use. Only the server
 * whose persona matches `persona` reads usage, so one Muse login is
 * probed by one environment.
 */
export const MuseAccountsFile = Schema.Struct({
  persona: Schema.String,
  accounts: Schema.Array(MuseAccount),
});
export type MuseAccountsFile = typeof MuseAccountsFile.Type;

/** What a missing or unreadable accounts file means: Muse usage is off. */
export const NO_MUSE_ACCOUNTS: MuseAccountsFile = { persona: "", accounts: [] };

const EpochMs = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
);
const UsageBlock = Schema.Struct({
  usedPercent: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  resetsAtMs: EpochMs,
  windowDurationMins: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  ),
});

/** The MSP `SubscriptionUsage` payload of `usage/changed` and `usage/read`. */
export const MuseSubscriptionUsage = Schema.Struct({
  window: UsageBlock,
  weekly: UsageBlock,
  tier: Schema.optional(Schema.String),
  observedAtMs: EpochMs,
});
export type MuseSubscriptionUsage = typeof MuseSubscriptionUsage.Type;

/** Muse reports over-quota values above 100; the wire contract caps at 100. */
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

export function museUsageWindows(
  usage: MuseSubscriptionUsage,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour",
      usedPercent: clampPercent(usage.window.usedPercent),
      resetsAt: isoFromMs(usage.window.resetsAtMs),
      ...(usage.window.windowDurationMins
        ? { windowDurationMins: Math.round(usage.window.windowDurationMins) }
        : {}),
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(usage.weekly.usedPercent),
      resetsAt: isoFromMs(usage.weekly.resetsAtMs),
      windowDurationMins: 7 * 24 * 60,
    },
  ];
}

export interface MuseAccountState {
  readonly account: MuseAccount;
  /** The login the last observation reported; null until a read succeeds. */
  readonly signedInAs: string | null;
  readonly usage: MuseSubscriptionUsage | null;
  readonly error: string | null;
  /** When the last observation attempt finished, successful or not, epoch ms. */
  readonly checkedAtMs: number | null;
  /**
   * Last passive-read attempt, epoch ms. Failures update this, never the
   * successful age, so a failed observation keeps the old reading's age.
   */
  readonly lastRefreshAttemptAtMs?: number | null | undefined;
  /** Epoch ms of the stored usage's observation; null until a good read. */
  readonly lastSuccessfulObservationAtMs?: number | null | undefined;
  /** What the stored observation cost. Internal only, never on the wire. */
  readonly observationCost?: MuseObservationCost | undefined;
}

/**
 * How an observation reached the service. Internal bookkeeping only: the
 * wire snapshot never carries it.
 *
 * - `passive`: seen during useful work or delivered by a passive reader.
 * - `model_turn`: cost a model turn to obtain; kept so older stored
 *   observations still decode.
 * - `unknown`: the provenance is unclear.
 */
export const MuseObservationCost = Schema.Literals(["passive", "model_turn", "unknown"]);
export type MuseObservationCost = typeof MuseObservationCost.Type;

/** Stable usage-limit source id for one account: `muse:<account id>`. */
export const museSourceId = (accountId: string): UsageLimitSourceId =>
  `muse:${accountId}` as UsageLimitSourceId;

/**
 * A sanitized observation persisted under `config.stateDir`. It carries the
 * account/source binding and the reading, never launchers, roots, or
 * credentials.
 */
export const MuseStoredObservation = Schema.Struct({
  version: Schema.Literal(1),
  accountId: Schema.String.check(Schema.isMinLength(1)),
  sourceId: Schema.String.check(Schema.isMinLength(1)),
  usage: MuseSubscriptionUsage,
  signedInAs: Schema.optional(Schema.String),
  cost: Schema.optional(MuseObservationCost),
  recordedAtMs: EpochMs,
  accountBinding: Schema.optional(Schema.String),
});
export type MuseStoredObservation = typeof MuseStoredObservation.Type;

/** Must match the ACP bridge's registry binding; roots are expanded before this call. */
export function museAccountBinding(account: MuseAccount): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        account.id,
        account.expectedEmail?.trim().toLowerCase() ?? null,
        ...[
          account.cliExecutable,
          account.workerExecutable,
          account.configHome,
          account.dataHome,
        ].map((value) => value || null),
      ]),
    )
    .digest("hex");
}

export type MuseRestoreRejection =
  | "account_mismatch"
  | "source_mismatch"
  | "identity_mismatch"
  | "config_mismatch";

export type MuseRestoreResult =
  | {
      readonly _tag: "Accepted";
      readonly usage: MuseSubscriptionUsage;
      readonly signedInAs: string | null;
      readonly cost: MuseObservationCost;
    }
  | { readonly _tag: "Rejected"; readonly reason: MuseRestoreRejection };

/**
 * Validate a stored observation against the configured account before it is
 * trusted: the account id and source id must bind to this account, and a
 * configured expected login must still match the stored one. Anything else is
 * rejected and the account keeps whatever it already knew (usually nothing).
 */
export function restoreMuseStoredObservation(
  stored: MuseStoredObservation,
  account: MuseAccount,
): MuseRestoreResult {
  if (stored.accountId !== account.id) {
    return { _tag: "Rejected", reason: "account_mismatch" };
  }
  if (stored.sourceId !== museSourceId(account.id)) {
    return { _tag: "Rejected", reason: "source_mismatch" };
  }
  if (stored.accountBinding && stored.accountBinding !== museAccountBinding(account)) {
    return { _tag: "Rejected", reason: "config_mismatch" };
  }
  const expected = account.expectedEmail?.trim().toLowerCase();
  // Fail closed: a configured expected login must be positively matched. An
  // absent or blank stored login is unknown identity, never a match.
  if (expected && stored.signedInAs?.trim().toLowerCase() !== expected) {
    return { _tag: "Rejected", reason: "identity_mismatch" };
  }
  return {
    _tag: "Accepted",
    usage: stored.usage,
    signedInAs: stored.signedInAs ?? null,
    cost: stored.cost ?? "unknown",
  };
}

/** The one fixed wire/debug message for an uncategorized observation failure. */
export const MUSE_OBSERVATION_FAILED = "The Muse observation failed.";

/**
 * Map any failure cause to fixed categorical metadata. The cause itself is
 * never copied to the wire or debug output: arbitrary error text can carry
 * payloads, paths, or credentials, so every cause collapses to the same
 * fixed message regardless of its content.
 */
export function sanitizeMuseFailure(_cause: unknown): string {
  return MUSE_OBSERVATION_FAILED;
}

/**
 * One usage-limit source per subscription, so each keeps its own error row.
 * The reported age always comes from the last successful observation; a
 * later failed attempt updates the error only, never the age.
 */
export function museSourceSnapshot(state: MuseAccountState): UsageLimitSourceSnapshot {
  const checkedAt = isoFromMs(
    state.usage?.observedAtMs ?? state.lastSuccessfulObservationAtMs ?? state.checkedAtMs ?? 0,
  );
  const base = {
    id: `muse:${state.account.id}` as UsageLimitSourceId,
    kind: "muse" as const,
    label: state.account.label,
    checkedAt,
  };
  if (!state.usage) {
    return { ...base, accounts: [], error: state.error ?? "Not read yet." };
  }
  return {
    ...base,
    accounts: [
      {
        id: state.account.label,
        driver: ProviderDriverKind.make("muse"),
        ...(state.account.plan ? { plan: state.account.plan } : {}),
        usageLimits: { checkedAt, windows: museUsageWindows(state.usage) },
      },
    ],
    ...(state.error ? { error: state.error } : {}),
  };
}
