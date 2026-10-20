/**
 * MuseUsage - five-hour and weekly quota for the No Fun Muse subscriptions.
 *
 * Passive only. Initialization, restart, inventory, and wave status never
 * start a quota-only completion: there is no probe, no refresh timer, and no
 * `muse serve` spawn anywhere in this module. The service restores the last
 * sanitized observation per account from `config.stateDir` and otherwise only
 * records observations delivered through `recordObservation`, the narrow
 * ingestion point for useful work. `current` also ingests account-bound files
 * kept by the ACP native useful-run adapter; it never starts a CLI or model.
 * Until useful work delivers an observation, quota stays unknown.
 *
 * Each account keeps two timestamps: the successful observation's age (what
 * the snapshot reports) and the last attempt (failures update only this plus
 * sanitized error metadata). Only sanitized successful observations are
 * persisted, bound to their account and source ids with no launchers, roots,
 * or credentials; restore and restart reject anything bound otherwise.
 *
 * Accounts come from `muse-accounts.json` in the T3 home actually in use
 * (`NOFUN_MUSE_ACCOUNTS` overrides); without that file usage is off and
 * nothing is read or written.
 *
 * @module MuseUsage
 */
import * as NodeOS from "node:os";

import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import {
  NO_MUSE_ACCOUNTS,
  MuseAccountsFile,
  MuseStoredObservation,
  MuseSubscriptionUsage,
  museSourceId,
  museAccountBinding,
  museSourceSnapshot,
  restoreMuseStoredObservation,
  sanitizeMuseFailure,
  MuseAccount,
  type MuseAccountState,
  type MuseObservationCost,
} from "./museUsage.logic.ts";
import { readNofunPersonaScope } from "./persona.ts";

export class MuseUsage extends Context.Service<
  MuseUsage,
  {
    /** One snapshot per configured subscription; empty on other personas. */
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /**
     * Record one passive observation for a configured account. Never spawns,
     * never fails: a wrong-shaped payload or mismatched login keeps the old
     * reading and lands as sanitized error metadata.
     */
    readonly recordObservation: (input: {
      readonly accountId: string;
      readonly usage: unknown;
      readonly signedInAs?: string | null | undefined;
      readonly cost?: MuseObservationCost | undefined;
    }) => Effect.Effect<void>;
    /** Record a passive-read failure without touching the stored reading. */
    readonly recordObservationFailure: (input: {
      readonly accountId: string;
      readonly cause: unknown;
    }) => Effect.Effect<void>;
  }
>()("t3/nofun/MuseUsage") {}

const decodeAccountsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(MuseAccountsFile));
const decodeUsage = Schema.decodeUnknownOption(MuseSubscriptionUsage);
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(MuseStoredObservation));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(MuseStoredObservation));
const sameAccountConfig = Schema.toEquivalence(MuseAccount);

const expandHome = (value: string) =>
  value === "~" || value.startsWith("~/") ? `${NodeOS.homedir()}${value.slice(1)}` : value;

const UNKNOWN_SHAPE = "Muse reported usage in an unknown shape.";
const UNREADABLE_STORED = "The saved observation could not be read.";
const WRONG_BINDING = "The saved observation is not bound to this account.";
const WRONG_LOGIN = "The saved observation is signed in as a different login.";
const WRONG_LOGIN_LIVE = "The Muse observation is signed in as a different login.";
const UNKNOWN_IDENTITY = "The Muse observation did not report a signed-in login.";
const STALE_OBSERVATION = "The Muse observation is older than the latest reading.";
const FUTURE_OBSERVATION = "The Muse observation is dated in the future.";
const PERSIST_FAILED = "The Muse observation could not be saved.";

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  // The registry lives in the T3 home actually in use (`config.baseDir`),
  // never a hardcoded home: machines with a relocated home (M1) keep their
  // own registry and observations beside it. The kept native observations
  // directory below derives from this path, so it follows automatically.
  const accountsPath =
    process.env.NOFUN_MUSE_ACCOUNTS?.trim() || path.join(config.baseDir, "muse-accounts.json");
  const personaId = readNofunPersonaScope()?.info.id ?? "nofun";
  const observationsDir = path.join(config.stateDir, "nofun", "muse-usage");

  const statesRef = yield* Ref.make<ReadonlyArray<MuseAccountState>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );
  /** Accounts for this persona with `~` expanded, re-read each pass so edits need no restart. */
  const loadAccounts = fileSystem.readFileString(accountsPath).pipe(
    Effect.flatMap(decodeAccountsFile),
    Effect.catch(() => Effect.succeed(NO_MUSE_ACCOUNTS)),
    Effect.map((file) =>
      file.persona === personaId
        ? file.accounts.map((account) => ({
            ...account,
            ...(account.cliExecutable ? { cliExecutable: expandHome(account.cliExecutable) } : {}),
            ...(account.workerExecutable
              ? { workerExecutable: expandHome(account.workerExecutable) }
              : {}),
            ...(account.configHome ? { configHome: expandHome(account.configHome) } : {}),
            ...(account.dataHome ? { dataHome: expandHome(account.dataHome) } : {}),
          }))
        : [],
    ),
  );

  const storedPath = (accountId: string) =>
    path.join(observationsDir, `${accountId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  const blank = (account: MuseAccount, error: string | null): MuseAccountState => ({
    account,
    signedInAs: null,
    usage: null,
    error,
    checkedAtMs: null,
    lastRefreshAttemptAtMs: null,
    lastSuccessfulObservationAtMs: null,
    observationCost: "unknown",
  });

  /** Restore one account's sanitized observation; rejects stay sanitized. */
  const restoreAccount = (account: MuseAccount) =>
    Effect.gen(function* () {
      const text = yield* fileSystem.readFileString(storedPath(account.id)).pipe(Effect.option);
      if (Option.isNone(text)) return blank(account, null);
      const decoded = yield* decodeStored(text.value).pipe(Effect.option);
      if (Option.isNone(decoded)) return blank(account, UNREADABLE_STORED);
      const now = yield* Clock.currentTimeMillis;
      if (
        decoded.value.usage.observedAtMs > now ||
        decoded.value.usage.observedAtMs > decoded.value.recordedAtMs
      ) {
        return blank(account, FUTURE_OBSERVATION);
      }
      const restored = restoreMuseStoredObservation(decoded.value, account);
      if (restored._tag === "Rejected") {
        return blank(
          account,
          restored.reason === "identity_mismatch" ? WRONG_LOGIN : WRONG_BINDING,
        );
      }
      return {
        account,
        signedInAs: restored.signedInAs,
        usage: restored.usage,
        error: null,
        checkedAtMs: null,
        lastRefreshAttemptAtMs: null,
        lastSuccessfulObservationAtMs: restored.usage.observedAtMs,
        observationCost: restored.cost,
      } satisfies MuseAccountState;
    });

  const publish = (next: ReadonlyArray<MuseAccountState>) =>
    Ref.set(statesRef, next).pipe(
      Effect.andThen(PubSub.publish(changes, next.map(museSourceSnapshot))),
      Effect.asVoid,
    );

  // Every observation mutation (and the account reconciliation it depends
  // on) runs under one permit, so concurrent accounts or failures can never
  // read-modify-write the shared state list and lose each other's update.
  const mutationLock = yield* Semaphore.make(1);

  /**
   * Re-read the accounts file and reconcile cached state with it: removed
   * accounts drop out, new accounts restore, and any account whose config
   * changed is blanked instead of relabeling its cached reading under new
   * identity or root bindings. Caller must hold `mutationLock`.
   */
  const reconcileUnlocked: Effect.Effect<ReadonlyArray<MuseAccount>> = Effect.gen(function* () {
    const accounts = yield* loadAccounts;
    const previous = yield* Ref.get(statesRef);
    const next: MuseAccountState[] = [];
    let changed = false;
    for (const account of accounts) {
      const prior = previous.find((state) => state.account.id === account.id);
      if (!prior) {
        next.push(yield* restoreAccount(account));
        changed = true;
      } else if (!sameAccountConfig(prior.account, account)) {
        next.push(blank(account, null));
        changed = true;
      } else {
        next.push(prior);
      }
    }
    if (previous.some((state) => !accounts.some((a) => a.id === state.account.id))) {
      changed = true;
    }
    if (changed) yield* publish(next);
    return accounts;
  });

  const cachedSnapshots: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>> =
    mutationLock.withPermits(1)(
      reconcileUnlocked.pipe(
        Effect.andThen(Ref.get(statesRef)),
        Effect.map((states) => states.map(museSourceSnapshot)),
      ),
    );

  const withAccount = (
    accountId: string,
    update: (
      account: MuseAccount,
      prior: MuseAccountState | undefined,
      now: number,
    ) => Effect.Effect<MuseAccountState, never, never>,
  ): Effect.Effect<void> =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const accounts = yield* reconcileUnlocked;
        const account = accounts.find((entry) => entry.id === accountId);
        // Unknown data remains unknown: nothing configured, nothing recorded.
        if (!account) return;
        const previous = yield* Ref.get(statesRef);
        const now = yield* Clock.currentTimeMillis;
        const prior = previous.find((state) => state.account.id === account.id);
        const next = yield* update(account, prior, now);
        if (next === prior) return;
        const rest = previous.filter((state) => state.account.id !== account.id);
        yield* publish([...rest, next]);
      }),
    );

  /** Persist one sanitized success atomically; false means unpersisted. */
  const persist = (stored: MuseStoredObservation, account: MuseAccount) =>
    encodeStored(stored).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: storedPath(account.id),
          contents,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.catch(() =>
        Effect.logDebug("Muse observation could not be persisted.", {
          account: account.id,
        }).pipe(Effect.as(false)),
      ),
    );

  const acceptObservation =
    (input: Parameters<MuseUsage["Service"]["recordObservation"]>[0]) =>
    (account: MuseAccount, prior: MuseAccountState | undefined, now: number) =>
      Effect.gen(function* () {
        // Every rejected attempt advances only the attempt timestamp; the
        // last successful reading and its age stay exactly as they were.
        const rejected = (error: string): MuseAccountState => ({
          account,
          signedInAs: prior?.signedInAs ?? null,
          usage: prior?.usage ?? null,
          error,
          checkedAtMs: now,
          lastRefreshAttemptAtMs: now,
          lastSuccessfulObservationAtMs: prior?.lastSuccessfulObservationAtMs ?? null,
          observationCost: prior?.observationCost ?? "unknown",
        });
        const decoded = decodeUsage(input.usage);
        if (Option.isNone(decoded)) return rejected(UNKNOWN_SHAPE);
        const usage = decoded.value;
        // Identity is fail-closed: with an expected login configured, only
        // a positively matching reported login is trusted. An absent login
        // is unknown identity and never inherits the prior login.
        const expected = account.expectedEmail?.trim().toLowerCase();
        const reported = input.signedInAs?.trim() ? input.signedInAs : null;
        if (expected) {
          if (!reported) return rejected(UNKNOWN_IDENTITY);
          if (reported.trim().toLowerCase() !== expected) return rejected(WRONG_LOGIN_LIVE);
        }
        const signedInAs = reported ?? prior?.signedInAs ?? null;
        // A future or older reading never replaces a fresher known success.
        if (usage.observedAtMs > now) return rejected(FUTURE_OBSERVATION);
        const priorSuccessAt =
          prior?.lastSuccessfulObservationAtMs ?? prior?.usage?.observedAtMs ?? null;
        if (priorSuccessAt !== null && usage.observedAtMs <= priorSuccessAt) {
          return rejected(STALE_OBSERVATION);
        }
        // Cost is unknown unless the caller supplies provenance evidence;
        // being delivered to this ingestion point proves nothing by itself.
        const cost = input.cost ?? "unknown";
        const persisted = yield* persist(
          {
            version: 1,
            accountId: account.id,
            sourceId: museSourceId(account.id),
            usage,
            ...(signedInAs ? { signedInAs } : {}),
            cost,
            recordedAtMs: now,
            accountBinding: museAccountBinding(account),
          },
          account,
        );
        return {
          account,
          signedInAs,
          usage,
          // An unpersisted reading stays visible in memory but is visibly
          // classified as unsaved, so a restart will not present it as kept.
          error: persisted ? null : PERSIST_FAILED,
          checkedAtMs: now,
          lastRefreshAttemptAtMs: now,
          lastSuccessfulObservationAtMs: usage.observedAtMs,
          observationCost: cost,
        } satisfies MuseAccountState;
      });

  const recordObservation: MuseUsage["Service"]["recordObservation"] = (input) =>
    withAccount(input.accountId, acceptObservation(input));

  // File-only ingestion: the ACP adapter keeps sanitized native observations
  // beside its accounts registry, independent of any one server's lifetime.
  // Revalidate under the mutation lock so a registry edit cannot relabel usage.
  const readUsefulWork = Effect.gen(function* () {
    const accounts = yield* loadAccounts;
    for (const account of accounts) {
      const keptDir = path.join(path.dirname(accountsPath), "muse-usage-observations");
      const prefix = `${account.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.`;
      const names = yield* fileSystem.readDirectory(keptDir).pipe(Effect.orElseSucceed(() => []));
      const candidates = names
        .filter(
          (name) =>
            name.startsWith(prefix) && /^\d+\.[a-f0-9-]{36}\.json$/.test(name.slice(prefix.length)),
        )
        .sort(
          (a, b) =>
            Number(b.slice(prefix.length).split(".")[0]) -
              Number(a.slice(prefix.length).split(".")[0]) || b.localeCompare(a),
        )
        .slice(0, 8);
      for (const name of candidates) {
        const kept = yield* fileSystem
          .readFileString(path.join(keptDir, name))
          .pipe(Effect.flatMap(decodeStored), Effect.option);
        if (Option.isNone(kept)) continue;
        const stored = kept.value;
        yield* withAccount(account.id, (actual, prior, now) => {
          if (
            !stored.accountBinding ||
            stored.accountBinding !== museAccountBinding(actual) ||
            restoreMuseStoredObservation(stored, actual)._tag === "Rejected" ||
            stored.recordedAtMs > now ||
            stored.usage.observedAtMs > stored.recordedAtMs ||
            stored.cost !== "passive" ||
            !stored.signedInAs?.trim() ||
            stored.usage.observedAtMs <= (prior?.usage?.observedAtMs ?? -1)
          ) {
            return Effect.succeed(prior ?? blank(actual, null));
          }
          return acceptObservation({
            accountId: actual.id,
            usage: stored.usage,
            signedInAs: stored.signedInAs,
            cost: "passive",
          })(actual, prior, now);
        });
      }
    }
  });
  const currentSnapshots = readUsefulWork.pipe(Effect.andThen(cachedSnapshots));

  const recordObservationFailure: MuseUsage["Service"]["recordObservationFailure"] = (input) =>
    withAccount(input.accountId, (account, prior, now) =>
      Effect.succeed({
        account,
        signedInAs: prior?.signedInAs ?? null,
        usage: prior?.usage ?? null,
        error: sanitizeMuseFailure(input.cause),
        checkedAtMs: now,
        lastRefreshAttemptAtMs: now,
        lastSuccessfulObservationAtMs: prior?.lastSuccessfulObservationAtMs ?? null,
        observationCost: prior?.observationCost ?? "unknown",
      } satisfies MuseAccountState),
    );

  // One passive restore at boot, before any client holds a lease. Restoring
  // never spawns: it only reads sanitized files under `config.stateDir`.
  const accounts = yield* loadAccounts;
  const restored: MuseAccountState[] = [];
  for (const account of accounts) {
    restored.push(yield* restoreAccount(account));
  }
  yield* Ref.set(statesRef, restored);

  return {
    current: currentSnapshots,
    recordObservation,
    recordObservationFailure,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* currentSnapshots;
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
        }),
      );
    },
  } satisfies MuseUsage["Service"];
});

export const layer = Layer.effect(MuseUsage, make);
