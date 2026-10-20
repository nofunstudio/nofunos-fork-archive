// @effect-diagnostics nodeBuiltinImport:off -- random event ids keep concurrent reservations from colliding on the unique event-log key.
import * as NodeCrypto from "node:crypto";
import { CommandId, EventId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionAdmissionReservedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  MAX_MISSION_EXECUTION_ADMISSIONS,
  MAX_MISSION_EXECUTION_CONSUMED_EXCEPTIONS,
  MAX_MISSION_EXECUTION_REJECTED_ROUTES,
  MAX_MISSION_EXECUTION_WRITER_CLAIMS,
  emptyMissionExecution,
  type MissionExecution,
  type MissionExecutionAdmission,
} from "../../../../packages/contracts/src/missionExecution.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import {
  decideMissionAdmission,
  dispatchKeyFor,
  MissionAdmissionRejection,
  type MissionAdmissionFacts,
  type MissionAdmissionLeaseFacts,
  type MissionAdmissionReceipt,
  type MissionAdmissionRequest,
} from "./MissionAdmission.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderCapacityReader } from "./ProviderCapacity.ts";
import { readExecutionCapacity, withExecutionCapacity } from "./ExecutionCapacity.ts";
import { MissionAuthority } from "./MissionService.ts";

/**
 * Dormant internal admission store. Reserves mission dispatch admission
 * durably in the SAME canonical mission event log / projection / command
 * receipt transaction and never authorizes a second launch on replay.
 *
 * A fresh reservation returns dispatchAuthorized:true; an exact replay
 * returns the SAME committed receipt with dispatchAuthorized:false and
 * performs no writes. Nothing here dispatches providers, prepares
 * worktrees, or touches the network: there is no outbox or dispatcher
 * wiring in this slice, so reservations persist with no launch. Root wires
 * canonical result state later.
 */
export class MissionAdmissionStoreError extends Schema.TaggedError<MissionAdmissionStoreError>()(
  "MissionAdmissionStoreError",
  {
    operation: Schema.Literals(["reserve"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission admission reserve failed (${this.category}).`;
  }
}

/**
 * Trusted server facts port. Supplies account/host/repository/usage
 * observations; never worker proposals. Prior receipts, prior-attempt lease
 * state, and active writer claims are NOT trusted from here: the store
 * re-derives them from canonical execution snapshots inside the transaction.
 */
export interface MissionAdmissionTrustedFacts {
  readonly taskNecessary: boolean;
  readonly nowMs: number;
  readonly teamId: string;
  readonly environmentId: string;
  readonly deliveryThreadId: string;
  readonly deliveryEpoch: number;
  readonly account: MissionAdmissionFacts["account"];
  readonly route: MissionAdmissionFacts["route"];
  readonly usageLimits: MissionAdmissionFacts["usageLimits"];
  readonly usageMaxObservationAgeMs: number;
  readonly usageSource?: MissionAdmissionFacts["usageSource"];
  readonly maxFactAgeMs?: number | undefined;
  readonly unknownUsageException?: MissionAdmissionFacts["unknownUsageException"];
  readonly host: MissionAdmissionFacts["host"];
  readonly repository: MissionAdmissionFacts["repository"];
  readonly writerScope: string;
  readonly sharedManifestScopes: ReadonlyArray<string>;
  readonly guiScopes: ReadonlyArray<string>;
  readonly dependencyReceipts: MissionAdmissionFacts["dependencyReceipts"];
}

export class MissionAdmissionFactsPort extends Context.Service<
  MissionAdmissionFactsPort,
  {
    readonly readFacts: (
      request: MissionAdmissionRequest,
    ) => Effect.Effect<MissionAdmissionTrustedFacts, MissionAdmissionStoreError>;
  }
>()("t3/orchestration-v2/MissionAdmissionStore/MissionAdmissionFactsPort") {}

export interface MissionAdmissionReservation {
  readonly receipt: MissionAdmissionReceipt;
  readonly recovered: boolean;
  /** True only for a newly committed reservation; never for a replay. */
  readonly dispatchAuthorized: boolean;
  readonly exceptionConsumptionRef: string | null;
  /** No outbox/dispatcher wiring exists in this slice. */
  readonly dispatcherStatus: "unregistered";
}

export type MissionAdmissionReserveResult = Result.Result<
  MissionAdmissionReservation,
  MissionAdmissionRejection
>;

const preparedAdmission: unique symbol = Symbol("PreparedMissionAdmission");

/**
 * Produced only by prepare, with trusted observations already captured. The
 * bound effect performs canonical checks and reservation using only sqlClient;
 * it never reads the facts port, dispatches, or prepares a worktree. EventSink
 * may run it as a savepoint within that SAME client's owning transaction.
 */
export interface PreparedMissionAdmission {
  readonly [preparedAdmission]: true;
  readonly sqlClient: SqlClient.SqlClient;
  readonly commandHashes: Readonly<{ promptHash: string; optionsHash: string }>;
  readonly reserve: Effect.Effect<MissionAdmissionReserveResult, MissionAdmissionStoreError>;
}

export class MissionAdmissionStore extends Context.Service<
  MissionAdmissionStore,
  {
    readonly prepare: (
      request: MissionAdmissionRequest,
    ) => Effect.Effect<PreparedMissionAdmission, MissionAdmissionStoreError>;
    readonly reserve: (
      request: MissionAdmissionRequest,
    ) => Effect.Effect<MissionAdmissionReserveResult, MissionAdmissionStoreError>;
  }
>()("t3/orchestration-v2/MissionAdmissionStore") {}

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const isStoreError = Schema.is(MissionAdmissionStoreError);

/**
 * Normalize a server writer scope to an absolute realpath form. Rejects
 * empty, non-absolute, and path-segment-traversal scopes.
 */
export const normalizeScopeClaim = (scope: string): string | null => {
  if (typeof scope !== "string" || scope.length === 0 || !scope.startsWith("/")) return null;
  if (scope.includes("\0")) return null;
  const parts: Array<string> = [];
  for (const part of scope.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return `/${parts.join("/")}`;
};

const sameStringArray = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const sameBindings = (a: Mission["bindings"], b: Mission["bindings"]): boolean =>
  a.length === b.length &&
  a.every(
    (binding, index) =>
      binding.projectId === b[index]!.projectId &&
      binding.workspaceRoot === b[index]!.workspaceRoot &&
      binding.baseCommit === b[index]!.baseCommit &&
      sameStringArray(binding.ancestry, b[index]!.ancestry),
  );

const toReceipt = (record: MissionExecutionAdmission): MissionAdmissionReceipt => ({
  dispatchKey: record.dispatchKey,
  teamId: record.teamId,
  environmentId: record.environmentId,
  missionId: record.missionId,
  taskId: record.taskId,
  attemptNumber: record.attemptNumber,
  operation: record.operation,
  requestDigest: record.requestDigest,
  admittedAtMs: record.admittedAtMs,
  chosenRoute: { ...record.chosenRoute },
  rejectedRoutes: record.rejectedRoutes.map((route) => ({ ...route })),
  evidenceTimestamps: {
    accountVerifiedAtMs: record.accountVerifiedAtMs,
    hostObservedAtMs: record.hostObservedAtMs,
    repositoryObservedAtMs: record.repositoryObservedAtMs,
  },
  unknownUsageException: record.unknownUsageException,
  unknownUsageExceptionId: record.unknownUsageExceptionId,
  exceptionConsumptionRef: record.exceptionConsumptionRef,
  accountBudget: { accountId: record.accountId, billingMode: record.billingMode },
  hostSlot: {
    hostId: record.hostId,
    bootId: record.bootId,
    threadId: record.hostThreadId,
    epoch: record.hostEpoch,
  },
});

const toRecord = (receipt: MissionAdmissionReceipt): MissionExecutionAdmission => ({
  dispatchKey: receipt.dispatchKey,
  teamId: receipt.teamId,
  environmentId: receipt.environmentId,
  missionId: receipt.missionId,
  taskId: receipt.taskId,
  attemptNumber: receipt.attemptNumber,
  operation: receipt.operation,
  requestDigest: receipt.requestDigest,
  admittedAtMs: receipt.admittedAtMs,
  chosenRoute: { ...receipt.chosenRoute },
  rejectedRoutes: receipt.rejectedRoutes.map((route) => ({ ...route })),
  accountVerifiedAtMs: receipt.evidenceTimestamps.accountVerifiedAtMs,
  hostObservedAtMs: receipt.evidenceTimestamps.hostObservedAtMs,
  repositoryObservedAtMs: receipt.evidenceTimestamps.repositoryObservedAtMs,
  accountId: receipt.accountBudget.accountId,
  billingMode: receipt.accountBudget.billingMode,
  hostId: receipt.hostSlot.hostId,
  bootId: receipt.hostSlot.bootId,
  hostThreadId: receipt.hostSlot.threadId,
  hostEpoch: receipt.hostSlot.epoch,
  unknownUsageException: receipt.unknownUsageException,
  unknownUsageExceptionId: receipt.unknownUsageExceptionId,
  exceptionConsumptionRef: receipt.exceptionConsumptionRef,
});

const reject = (
  code: MissionAdmissionRejection["code"],
  message: string,
): MissionAdmissionReserveResult => Result.fail(new MissionAdmissionRejection({ code, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const factsPort = yield* MissionAdmissionFactsPort;
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const readProviderCapacity = yield* makeProviderCapacityReader;

  const toStoreError = (cause: unknown): MissionAdmissionStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionAdmissionStoreError({ operation: "reserve", category: "persistence", cause });

  const reserveTransaction = Effect.fn("MissionAdmissionStore.reserveTransaction")(function* (
    trusted: MissionAdmissionTrustedFacts,
    request: MissionAdmissionRequest,
  ) {
    // Canonical reread scoped by the authenticated team/env precedes every
    // receipt lookup, including replay of completed work.
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${request.mission.id}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (rows[0] === undefined) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    }
    const canonical = yield* decodeMission(rows[0].snapshot_json);
    if (rows[0].revision !== canonical.revision) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "persistence",
      });
    }
    if (trusted.teamId !== authority.teamId || trusted.environmentId !== authority.environmentId) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    }
    // Latest role/epoch is revalidated even for replay, before any lookup.
    const delivery = canonical.managers.delivery;
    if (
      delivery?.threadId !== authority.controllerThreadId ||
      delivery.epoch === undefined ||
      delivery.epoch !== trusted.deliveryEpoch ||
      trusted.deliveryThreadId !== authority.controllerThreadId
    ) {
      return reject(
        "thread_epoch_mismatch",
        "Mission delivery thread or epoch is not current; re-read the mission first.",
      );
    }
    // Scope denials precede receipt lookup.
    const normalizedWriter = normalizeScopeClaim(trusted.writerScope);
    if (request.attempt.operation === "write" && normalizedWriter === null) {
      return reject(
        "scope_conflict",
        "Write attempt has no normalized absolute server writer scope.",
      );
    }
    if (request.rejectedRoutes.length > MAX_MISSION_EXECUTION_REJECTED_ROUTES) {
      return reject(
        "attempt_invalid",
        "Proposal carries more rejected routes than the bounded receipt can persist.",
      );
    }

    const scopedRows = yield* sql<{ snapshot_json: string }>`
      SELECT snapshot_json FROM projection_missions
      WHERE team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    const scoped = yield* Effect.forEach(scopedRows, (row) => decodeMission(row.snapshot_json));

    const dispatchKey = dispatchKeyFor({
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      missionId: canonical.id,
      taskId: request.taskId,
      attemptNumber: request.attempt.attemptNumber,
      operation: request.attempt.operation,
    });
    const execution = canonical.execution ?? emptyMissionExecution();
    const prior = execution.admissions.find((admission) => admission.dispatchKey === dispatchKey);

    // Canonical claims across ALL missions of this scope, excluding the
    // replaying admission's own claim so replay never self-conflicts.
    const canonicalWriterScopes: Array<string> = [];
    for (const snapshot of scoped) {
      for (const claim of snapshot.execution?.writerClaims ?? []) {
        if (claim.dispatchKey === dispatchKey) continue;
        const normalized = normalizeScopeClaim(claim.scope);
        if (normalized === null)
          return yield* new MissionAdmissionStoreError({
            operation: "reserve",
            category: "persistence",
          });
        canonicalWriterScopes.push(normalized);
      }
    }
    if (prior !== undefined && request.attempt.operation === "write") {
      const owned = execution.writerClaims.filter((claim) => claim.dispatchKey === dispatchKey);
      if (owned.length !== 1 || normalizeScopeClaim(owned[0]!.scope) !== normalizedWriter) {
        return reject(
          "digest_conflict",
          "Replay writer scope differs from its canonical reservation.",
        );
      }
    }

    // An existing unsettled reservation for this task stays uncertain until
    // separate reconciliation; a novel attempt counter or operation cannot
    // bypass it. Only the exact same dispatch key may recover.
    const unsettled = execution.admissions.filter(
      (admission) => admission.taskId === request.taskId && admission.dispatchKey !== dispatchKey,
    );
    const priorAttempt: MissionAdmissionLeaseFacts =
      unsettled.length > 0
        ? {
            state: "uncertain",
            attemptNumber: unsettled[0]!.attemptNumber,
            cancelRequested: false,
            leaseExpired: false,
          }
        : { state: "none", attemptNumber: null, cancelRequested: false, leaseExpired: false };

    if (prior === undefined && unsettled.length > 0) {
      return reject(
        "lease_uncertain",
        "A canonical unsettled reservation blocks another operation or attempt.",
      );
    }

    const facts: MissionAdmissionFacts = {
      taskNecessary: trusted.taskNecessary,
      nowMs: trusted.nowMs,
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      deliveryThreadId: trusted.deliveryThreadId,
      deliveryEpoch: trusted.deliveryEpoch,
      account: trusted.account,
      route: trusted.route,
      usageLimits: trusted.usageLimits,
      usageMaxObservationAgeMs: trusted.usageMaxObservationAgeMs,
      ...(trusted.maxFactAgeMs === undefined ? {} : { maxFactAgeMs: trusted.maxFactAgeMs }),
      ...(trusted.unknownUsageException === undefined
        ? {}
        : { unknownUsageException: trusted.unknownUsageException }),
      host: trusted.host,
      repository: trusted.repository,
      scopes: {
        writerScope: normalizedWriter ?? trusted.writerScope,
        sharedManifestScopes: trusted.sharedManifestScopes,
        guiScopes: trusted.guiScopes,
        activeWriterScopes: canonicalWriterScopes,
      },
      priorAttempt,
      dependencyReceipts: trusted.dependencyReceipts,
      priorReceipts: execution.admissions.map(toReceipt),
    };

    // A fresh reservation must propose the current canonical snapshot;
    // replay skips the revision check because the reservation itself
    // advanced the revision.
    if (prior === undefined) {
      if (request.mission.revision !== canonical.revision) {
        return reject(
          "hash_mismatch",
          `Proposal revision ${request.mission.revision} does not match canonical revision ${canonical.revision}; re-read the mission first.`,
        );
      }
      if (!sameBindings(request.mission.bindings, canonical.bindings)) {
        return reject(
          "ancestry_mismatch",
          "Proposal bindings do not match the canonical mission; re-read the mission first.",
        );
      }
      const canonicalTask = canonical.tasks.find((task) => task.id === request.taskId);
      if (canonicalTask !== undefined) {
        const proposedTask = request.mission.tasks.find((task) => task.id === request.taskId);
        if (
          proposedTask === undefined ||
          proposedTask.projectId !== canonicalTask.projectId ||
          proposedTask.specHash !== canonicalTask.specHash ||
          !sameStringArray(proposedTask.dependencyHashes, canonicalTask.dependencyHashes) ||
          !sameStringArray(proposedTask.dependencies, canonicalTask.dependencies) ||
          !sameStringArray(proposedTask.acceptanceIds, canonicalTask.acceptanceIds)
        ) {
          return reject(
            "hash_mismatch",
            `Task '${request.taskId}' proposal does not match the canonical spec snapshot; re-plan first.`,
          );
        }
      }
    }

    const decided = decideMissionAdmission({ ...request, mission: canonical }, facts);
    if (Result.isFailure(decided)) return Result.fail(decided.failure);
    const admitted = decided.success;
    if (admitted.recovered) {
      // No new event, revision, or exception consumption on replay, and a
      // recovered receipt never permits a launch.
      return Result.succeed({
        ...admitted,
        dispatcherStatus: "unregistered" as const,
      });
    }

    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    if (execution.admissions.length >= MAX_MISSION_EXECUTION_ADMISSIONS) {
      return reject(
        "attempt_invalid",
        "Mission execution admission bound reached; history is preserved and no further admissions are accepted.",
      );
    }
    let writerClaims = execution.writerClaims;
    let consumedExceptionIds = execution.consumedExceptionIds;
    if (request.attempt.operation === "write" && normalizedWriter !== null) {
      if (writerClaims.length >= MAX_MISSION_EXECUTION_WRITER_CLAIMS) {
        return reject(
          "attempt_invalid",
          "Mission execution writer-claim bound reached; history is preserved and no further admissions are accepted.",
        );
      }
      writerClaims = [
        ...writerClaims,
        {
          scope: normalizedWriter,
          dispatchKey,
          missionId: canonical.id,
          taskId: request.taskId,
          attemptNumber: request.attempt.attemptNumber,
          operation: request.attempt.operation,
        },
      ];
    }
    if (admitted.exceptionConsumptionRef !== null) {
      // Authorized in trusted facts, but unused/remaining capacity is
      // checked atomically against canonical consumed IDs across all
      // missions of this scope.
      const exceptionId = admitted.receipt.unknownUsageExceptionId;
      if (exceptionId === null) {
        return yield* new MissionAdmissionStoreError({
          operation: "reserve",
          category: "persistence",
        });
      }
      const authorized = trusted.unknownUsageException;
      const allowed = authorized?.remainingAssignments ?? (authorized?.unused === true ? 1 : 0);
      let used = 0;
      for (const snapshot of scoped) {
        for (const consumed of snapshot.execution?.consumedExceptionIds ?? []) {
          if (consumed === exceptionId) used += 1;
        }
      }
      if (allowed !== 1 || used >= 1) {
        return reject(
          "usage_unknown",
          `Unknown-usage exception '${exceptionId}' is already consumed (${used} of ${allowed}); no scoped live assignment remains.`,
        );
      }
      if (consumedExceptionIds.length >= MAX_MISSION_EXECUTION_CONSUMED_EXCEPTIONS) {
        return reject(
          "attempt_invalid",
          "Mission execution consumed-exception bound reached; history is preserved and no further admissions are accepted.",
        );
      }
      consumedExceptionIds = [...consumedExceptionIds, exceptionId];
    }

    const nextExecution: MissionExecution = {
      ...execution,
      admissions: [...execution.admissions, toRecord(admitted.receipt)],
      writerClaims,
      consumedExceptionIds,
    };
    const updated: Mission = {
      ...canonical,
      revision: canonical.revision + 1,
      execution: nextExecution,
      updatedAt: now,
    };
    const commandId = CommandId.make(`mission-admission:${dispatchKey}`);
    const event: MissionAdmissionReservedEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId,
      metadata: {},
      type: "mission.admission-reserved",
      payload: {
        mission: updated,
        dispatchKey,
        requestDigest: admitted.receipt.requestDigest,
      },
    };
    const stored = yield* events.appendMissionEvent(event);
    const snapshot = yield* encodeMission(updated);
    const cas = yield* sql<{ mission_id: string }>`
      UPDATE projection_missions
      SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now}
      WHERE mission_id = ${canonical.id} AND revision = ${canonical.revision}
      RETURNING mission_id
    `;
    if (cas.length === 0) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "request_conflict",
      });
    }
    const reserved = yield* receipts.insertIfAbsent({
      commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: "mission.admission-reserve",
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash: admitted.receipt.requestDigest,
    });
    if (!reserved) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "request_conflict",
      });
    }
    return Result.succeed({
      receipt: admitted.receipt,
      recovered: false,
      dispatchAuthorized: true,
      exceptionConsumptionRef: admitted.exceptionConsumptionRef,
      dispatcherStatus: "unregistered" as const,
    });
  });

  const prepare = Effect.fn("MissionAdmissionStore.prepare")(function* (
    request: MissionAdmissionRequest,
  ): Effect.fn.Return<PreparedMissionAdmission, MissionAdmissionStoreError> {
    // Preparation can probe external facts, so it must precede any transaction.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "persistence",
      });
    }
    // The authenticated runtime scope wins; request payloads cannot widen it.
    if (
      request.mission.teamId !== authority.teamId ||
      request.mission.authorityEnvironmentId !== authority.environmentId
    ) {
      return yield* new MissionAdmissionStoreError({
        operation: "reserve",
        category: "scope_denied",
      });
    }
    // Trusted observations are read before the transaction; no provider
    // dispatch, worktree preparation, or network happens inside it.
    // Bind snapshots rather than retaining mutable caller/port objects. Start
    // the clock before observations so slow preparation cannot extend freshness.
    const preparedAtMs = yield* Clock.currentTimeMillis;
    const boundRequest = structuredClone(request);
    let trusted = structuredClone(yield* factsPort.readFacts(boundRequest));
    // Live admission owns local capacity observations; the authority port still
    // owns account identity, source ancestry and build/toolchain qualification.
    // A deliberately injected offline facts port remains usable without a live registry.
    if (Option.isSome(providers)) {
      const observations = yield* readProviderCapacity(yield* providers.value.getProviders);
      const sampledAtMs = yield* Clock.currentTimeMillis;
      const capacity = yield* Effect.promise(() =>
        readExecutionCapacity(trusted.repository.workspaceRootRealpath, sampledAtMs),
      );
      trusted = {
        ...trusted,
        usageLimits: observations.get(trusted.route.providerInstanceId)?.limits,
        usageSource: observations.get(trusted.route.providerInstanceId)?.source,
        host: withExecutionCapacity(trusted.host, capacity),
      };
    }
    const reserve = Effect.gen(function* () {
      const runOnce = () =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              // Read time after acquiring the transaction, including any lock wait.
              const nowMs = yield* Clock.currentTimeMillis;
              if (!Number.isFinite(nowMs) || nowMs < preparedAtMs) {
                return yield* new MissionAdmissionStoreError({
                  operation: "reserve",
                  category: "persistence",
                });
              }
              return yield* reserveTransaction(
                { ...trusted, nowMs: trusted.nowMs + (nowMs - preparedAtMs) },
                boundRequest,
              );
            }),
          )
          .pipe(Effect.mapError(toStoreError));
      const first = yield* runOnce().pipe(Effect.result);
      if (Result.isFailure(first)) {
        // A lost CAS race or receipt collision means a concurrent reservation
        // won; reread once so an exact duplicate recovers instead of failing.
        if (first.failure.category !== "request_conflict") return yield* first.failure;
        const second = yield* runOnce().pipe(Effect.result);
        if (Result.isFailure(second)) return yield* second.failure;
        return second.success;
      }
      return first.success;
    });
    return {
      [preparedAdmission]: true,
      sqlClient: sql,
      commandHashes: Object.freeze({
        promptHash: boundRequest.promptHash,
        optionsHash: boundRequest.optionsHash,
      }),
      reserve,
    };
  });

  const reserve = Effect.fn("MissionAdmissionStore.reserve")(function* (
    request: MissionAdmissionRequest,
  ) {
    const prepared = yield* prepare(request);
    return yield* prepared.reserve;
  });

  return MissionAdmissionStore.of({ prepare, reserve });
});

export const layer = Layer.effect(MissionAdmissionStore, make);
