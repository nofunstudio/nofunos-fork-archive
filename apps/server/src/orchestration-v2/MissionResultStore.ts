// @effect-diagnostics nodeBuiltinImport:off -- stable command hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { CommandId, EventId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionId,
  type MissionResultReconciledEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  MAX_MISSION_EXECUTION_RESULTS,
  type MissionExecution,
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
  acceptMissionResult,
  acknowledgeMailboxDelivery,
  applyServerObservation,
  integrateMissionResult,
  MissionResultReconciliationError,
  recordInstalledDelivery,
  reconcileTerminalArrival,
  rejectMissionResult,
  reviewMissionResult,
  type MissionResultArrival,
  type MissionResultDisposition,
  type MissionResultOutcome,
  type MissionResultReceipt,
  type MissionResultRecord,
  type MissionResultServerObservation,
} from "./MissionResultReconciliation.ts";
import { MissionAuthority, MissionTransactionGuard } from "./MissionService.ts";

/**
 * Dormant internal result store. Persists mission result reconciliation
 * through the SAME canonical mission event log / projection / command
 * receipt transaction and never launches, releases, rotates, or retros.
 *
 * A fresh command appends one `mission.result-reconciled` event carrying the
 * FULL updated mission, bumps the snapshot revision by one, and records the
 * command receipt atomically; a failed receipt insert rolls everything back.
 * An exact replay (same command id, same bytes) returns the SAME saved
 * outcome with no new event or revision. Same id with different bytes is a
 * request conflict. Domain policy failures preserve the current record and
 * persist only a rejected receipt. No dispatch, release, rotation, or Retro
 * wiring exists in this slice.
 */
export class MissionResultStoreError extends Schema.TaggedError<MissionResultStoreError>()(
  "MissionResultStoreError",
  {
    operation: Schema.Literals(["execute"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission result execute failed (${this.category}).`;
  }
}

export type MissionResultAction =
  | "initialize"
  | "arrive"
  | "observe"
  | "mailbox_ack"
  | "review"
  | "accept"
  | "integrate"
  | "installed_delivery"
  | "reject";

/** Bounded result-reconcile command. The command id is the caller-stable idempotency key. */
export interface MissionResultCommand {
  readonly commandId: CommandId;
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly deliveryEpoch: number;
  readonly taskId: string;
  readonly dispatchKey: string;
  readonly action: MissionResultAction;
  readonly summaryText?: string | undefined;
  readonly outcome?: MissionResultOutcome | undefined;
  readonly arrival?: MissionResultArrival | undefined;
  readonly receipt?: MissionResultReceipt | undefined;
  readonly reason?: string | undefined;
  readonly cancellationRequested?: boolean | undefined;
  readonly pendingChildRuns?: boolean | undefined;
}

/**
 * Trusted server association for the producing run. Supplied by runtime
 * ownership through the facts port, never by arrival self-attestation.
 */
export interface MissionResultTrustedAssociation {
  readonly childTaskId: string;
  readonly childThreadId: string;
  readonly childRunId: string;
  readonly requiredAncestry: ReadonlyArray<string>;
  readonly initialCommitSet: ReadonlyArray<string>;
  readonly initialAncestry: ReadonlyArray<string>;
  readonly source: string;
  readonly sourceRef: string;
  readonly initialResultRevision: number;
  readonly digests: {
    readonly inputDigest: string;
    readonly dependencyDigest: string;
    readonly acceptanceDigest: string;
  };
  readonly admissionDispatchKey: string;
  readonly admissionRequestDigest: string;
  readonly attemptNumber: number;
  readonly pendingChildRuns: boolean;
}

export interface MissionResultTrustedFacts {
  readonly teamId: string;
  readonly environmentId: string;
  readonly deliveryThreadId: string;
  readonly deliveryEpoch: number;
  readonly nowMs: number;
  readonly association: MissionResultTrustedAssociation;
  /** Authoritative server observation; the only input that may clear pending or add a run. */
  readonly observation?: MissionResultServerObservation | undefined;
  /** Exact expected installed build, from trusted facts only. Proposals cannot set this. */
  readonly installedBuildRef?: string | undefined;
}

export class MissionResultFactsPort extends Context.Service<
  MissionResultFactsPort,
  {
    readonly readFacts: (
      command: MissionResultCommand,
    ) => Effect.Effect<MissionResultTrustedFacts, MissionResultStoreError>;
  }
>()("t3/orchestration-v2/MissionResultStore/MissionResultFactsPort") {}

export interface MissionResultExecution {
  readonly record: MissionResultRecord;
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly recovered: boolean;
  /** True only when a fresh event, revision, and accepted receipt committed. */
  readonly committed: boolean;
  readonly eventSequence: number;
  readonly disposition: MissionResultDisposition;
}

export type MissionResultExecuteResult = Result.Result<
  MissionResultExecution,
  MissionResultReconciliationError
>;

export class MissionResultStore extends Context.Service<
  MissionResultStore,
  {
    readonly execute: (
      command: MissionResultCommand,
    ) => Effect.Effect<MissionResultExecuteResult, MissionResultStoreError>;
  }
>()("t3/orchestration-v2/MissionResultStore") {}

export const commandTypeFor = (action: MissionResultAction): string =>
  `mission.result-reconcile:${action}`;

/**
 * Stable request hash over the serialized action. It deliberately excludes
 * the mutable canonical revision so an exact retry hashes identically.
 */
export const requestHashFor = (command: MissionResultCommand): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        action: command.action,
        arrival: command.arrival ?? null,
        cancellationRequested: command.cancellationRequested ?? null,
        commandId: command.commandId,
        deliveryEpoch: command.deliveryEpoch,
        dispatchKey: command.dispatchKey,
        expectedRevision: command.expectedRevision,
        missionId: command.missionId,
        outcome: command.outcome ?? null,
        pendingChildRuns: command.pendingChildRuns ?? null,
        reason: command.reason ?? null,
        receipt: command.receipt ?? null,
        summaryText: command.summaryText ?? null,
        taskId: command.taskId,
      }),
    )
    .digest("hex");

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeSavedFailure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionResultReconciliationError),
);
const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(MissionResultReconciliationError));
const isStoreError = Schema.is(MissionResultStoreError);

/** Canonical source inputs and criteria; runtime associations must bind these exact digests. */
export const canonicalResultDigests = (mission: Mission, taskId: string) => {
  const task = mission.tasks.find((entry) => entry.id === taskId);
  if (!task) return undefined;
  const hash = (value: unknown) =>
    NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
  return {
    inputDigest: task.specHash,
    dependencyDigest: hash({ ids: task.dependencies, hashes: task.dependencyHashes }),
    acceptanceDigest: hash(
      task.acceptanceIds.map((id) =>
        mission.intent.acceptanceCriteria.find((criterion) => criterion.id === id),
      ),
    ),
  };
};
const digestsMatch = (
  a: MissionResultTrustedAssociation["digests"],
  b: MissionResultTrustedAssociation["digests"],
) =>
  a.inputDigest === b.inputDigest &&
  a.dependencyDigest === b.dependencyDigest &&
  a.acceptanceDigest === b.acceptanceDigest;

const DISPOSITIONS: ReadonlySet<string> = new Set([
  "advanced",
  "held_not_done",
  "held_frozen",
  "held_stale",
  "held_conflict",
  "duplicate",
  "no_regression",
  "invalidated",
]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const factsPort = yield* MissionResultFactsPort;

  const toStoreError = (cause: unknown): MissionResultStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionResultStoreError({ operation: "execute", category: "persistence", cause });

  const refuse = (
    operation: MissionResultReconciliationError["operation"],
    category: MissionResultReconciliationError["category"],
    detail?: string,
  ): ReturnType<typeof reconcileTerminalArrival> =>
    detail === undefined
      ? Result.fail(new MissionResultReconciliationError({ operation, category }))
      : Result.fail(new MissionResultReconciliationError({ operation, category, detail }));

  const persistRejection = Effect.fn("MissionResultStore.persistRejection")(function* (
    command: MissionResultCommand,
    missionId: MissionId,
    requestHash: string,
    failure: MissionResultReconciliationError,
  ) {
    const failedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    if (
      !(yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: missionId,
        commandType: commandTypeFor(command.action),
        acceptedAt: failedAt,
        resultSequence: 0,
        status: "rejected",
        error: yield* encodeFailure(failure),
        requestHash,
      }))
    )
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "request_conflict",
      });
    return Result.fail(failure);
  });

  const executeTransaction = Effect.fn("MissionResultStore.executeTransaction")(function* (
    trusted: MissionResultTrustedFacts,
    command: MissionResultCommand,
    requestHash: string,
  ) {
    // Canonical reread scoped by the authenticated team/env precedes every
    // receipt lookup, including replay of completed work.
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (rows[0] === undefined) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "scope_denied",
      });
    }
    const canonical = yield* decodeMission(rows[0].snapshot_json);
    if (rows[0].revision !== canonical.revision) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "persistence",
      });
    }
    // Public request-scoped authority must remain live at the owning commit,
    // including on exact replay. Internal/offline authorities keep their contract.
    if (authority.transactionGuard !== undefined) {
      yield* MissionTransactionGuard.check({
        sql,
        authority,
        request: { operation: "read", missionId: canonical.id },
        expectedMission: canonical,
      }).pipe(
        Effect.mapError(
          () => new MissionResultStoreError({ operation: "execute", category: "scope_denied" }),
        ),
      );
    }
    if (trusted.teamId !== authority.teamId || trusted.environmentId !== authority.environmentId) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "scope_denied",
      });
    }
    // Latest delivery controller/epoch is revalidated even for replay, before any lookup.
    const delivery = canonical.managers.delivery;
    if (
      delivery?.threadId !== authority.controllerThreadId ||
      delivery.epoch === undefined ||
      delivery.epoch !== trusted.deliveryEpoch ||
      delivery.epoch !== command.deliveryEpoch ||
      trusted.deliveryThreadId !== authority.controllerThreadId
    ) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "scope_denied",
      });
    }
    const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isSome(prior)) {
      const saved = prior.value;
      if (
        saved.aggregateKind !== "mission" ||
        saved.aggregateId !== canonical.id ||
        saved.requestHash !== requestHash
      ) {
        return yield* new MissionResultStoreError({
          operation: "execute",
          category: "request_conflict",
        });
      }
      if (saved.status === "rejected") {
        if (saved.error === null) {
          return yield* new MissionResultStoreError({
            operation: "execute",
            category: "persistence",
          });
        }
        return Result.fail(
          yield* decodeSavedFailure(saved.error).pipe(Effect.mapError(toStoreError)),
        );
      }
      const logged = yield* events.readMissionEvents(canonical.id);
      const reconciled = logged.find(
        (event) =>
          event.type === "mission.result-reconciled" && event.commandId === command.commandId,
      );
      if (reconciled === undefined || reconciled.type !== "mission.result-reconciled") {
        return yield* new MissionResultStoreError({
          operation: "execute",
          category: "persistence",
        });
      }
      const record = reconciled.payload.mission.execution?.results?.find(
        (result) => result.taskId === command.taskId,
      );
      if (record === undefined || !DISPOSITIONS.has(reconciled.payload.disposition)) {
        return yield* new MissionResultStoreError({
          operation: "execute",
          category: "persistence",
        });
      }
      return Result.succeed({
        record,
        receipt: saved,
        recovered: true,
        committed: false,
        eventSequence: reconciled.sequence,
        disposition: reconciled.payload.disposition as MissionResultDisposition,
      });
    }
    // Compare-and-swap on the canonical revision for fresh commands.
    if (command.expectedRevision !== canonical.revision) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "request_conflict",
      });
    }
    const execution: MissionExecution = canonical.execution ?? emptyMissionExecution();
    const results = [...(execution.results ?? [])];
    const index = results.findIndex((result) => result.taskId === command.taskId);
    const current = index === -1 ? undefined : results[index];

    const task = canonical.tasks.find((entry) => entry.id === command.taskId);
    const admission = execution.admissions.find(
      (entry) => entry.dispatchKey === command.dispatchKey,
    );
    const digests = canonicalResultDigests(canonical, command.taskId);
    const binding = canonical.bindings.find((entry) => entry.projectId === task?.projectId);
    const requiredAncestry =
      binding === undefined ? [] : [...new Set([binding.baseCommit, ...binding.ancestry])];
    const association = trusted.association;
    const associationValid =
      task !== undefined &&
      binding !== undefined &&
      digests !== undefined &&
      command.dispatchKey === association.admissionDispatchKey &&
      admission !== undefined &&
      admission.taskId === command.taskId &&
      admission.attemptNumber === association.attemptNumber &&
      admission.requestDigest === association.admissionRequestDigest &&
      digestsMatch(association.digests, digests) &&
      requiredAncestry.length === association.requiredAncestry.length &&
      requiredAncestry.every((ref) => association.requiredAncestry.includes(ref)) &&
      requiredAncestry.every(
        (ref) =>
          association.initialAncestry.includes(ref) || association.initialCommitSet.includes(ref),
      );
    if (
      !associationValid ||
      (current !== undefined && current.attemptNumber !== association.attemptNumber)
    ) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        new MissionResultReconciliationError({
          operation: command.action === "initialize" ? "initialize" : "freshness",
          category: "digest_mismatch",
          detail: "Current task, admission, ancestry and runtime association do not match.",
        }),
      );
    }
    if (
      ["review", "accept", "integrate", "installed_delivery"].includes(command.action) &&
      current !== undefined &&
      digests !== undefined &&
      !digestsMatch(current.digests, digests)
    ) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        new MissionResultReconciliationError({
          operation: "freshness",
          category: "digest_mismatch",
          detail: "Result inputs or acceptance criteria changed; re-review current work.",
        }),
      );
    }

    let decided: ReturnType<typeof reconcileTerminalArrival>;
    if (command.action === "initialize") {
      if (command.summaryText === undefined || command.outcome === undefined) {
        decided = refuse(
          "initialize",
          "invalid_transition",
          "Initialize requires summaryText and outcome.",
        );
      } else if (current !== undefined) {
        decided = refuse(
          "initialize",
          "invalid_transition",
          "A result record already exists; use arrival and review commands.",
        );
      } else if (results.length >= MAX_MISSION_EXECUTION_RESULTS) {
        decided = refuse(
          "initialize",
          "invalid_transition",
          "Mission result bound reached; history is preserved and no further results are accepted.",
        );
      } else if (command.dispatchKey !== trusted.association.admissionDispatchKey) {
        decided = refuse(
          "initialize",
          "digest_mismatch",
          "Command dispatch key does not match the trusted admission dispatch key.",
        );
      } else if (canonical.tasks.find((task) => task.id === command.taskId) === undefined) {
        decided = refuse(
          "initialize",
          "invalid_transition",
          "No canonical task matches the command task.",
        );
      } else {
        const admission = execution.admissions.find(
          (entry) => entry.dispatchKey === trusted.association.admissionDispatchKey,
        );
        if (
          admission === undefined ||
          admission.taskId !== command.taskId ||
          admission.attemptNumber !== trusted.association.attemptNumber
        ) {
          decided = refuse(
            "initialize",
            "digest_mismatch",
            "No canonical admission matches the trusted dispatch key, task, and attempt.",
          );
        } else {
          const association = trusted.association;
          decided = Result.succeed({
            record: {
              taskId: command.taskId,
              attemptNumber: association.attemptNumber,
              state: "produced",
              outcome: command.outcome,
              digests: { ...association.digests },
              provenance: {
                childTaskId: association.childTaskId,
                childThreadId: association.childThreadId,
                childRunId: association.childRunId,
                commitSet: [...association.initialCommitSet],
                requiredAncestry: [...association.requiredAncestry],
                ancestry: [...association.initialAncestry],
                source: association.source,
                sourceRef: association.sourceRef,
                resultRevision: association.initialResultRevision,
              },
              summaryText: command.summaryText,
              cancellationRequested: command.cancellationRequested ?? false,
              pendingChildRuns: association.pendingChildRuns,
              mailboxAcked: false,
              quarantined: [],
            },
            disposition: "advanced",
            detail: "Result record initialized from the trusted producing association.",
          });
        }
      }
    } else if (command.action === "arrive") {
      decided =
        current === undefined
          ? refuse("arrive", "invalid_transition", "No result record exists; initialize first.")
          : command.arrival === undefined
            ? refuse("arrive", "invalid_transition", "An arrival command requires arrival content.")
            : reconcileTerminalArrival({
                record: current,
                arrival: command.arrival,
                ...(trusted.observation === undefined
                  ? {}
                  : { serverObservation: trusted.observation }),
              });
    } else if (command.action === "observe") {
      decided =
        current === undefined
          ? refuse("observe", "invalid_transition", "No result record exists; initialize first.")
          : trusted.observation === undefined
            ? refuse(
                "observe",
                "invalid_transition",
                "No authoritative server observation is available.",
              )
            : applyServerObservation({ record: current, observation: trusted.observation });
    } else if (
      command.action === "review" ||
      command.action === "accept" ||
      command.action === "integrate" ||
      command.action === "installed_delivery"
    ) {
      if (current === undefined) {
        decided = refuse(
          command.action,
          "invalid_transition",
          "No result record exists; initialize first.",
        );
      } else if (command.receipt === undefined) {
        decided = refuse(
          command.action,
          "evidence_mismatch",
          "A decision command requires a receipt.",
        );
      } else if (command.receipt.decidedBy !== authority.controllerThreadId) {
        decided = refuse(
          command.action,
          "evidence_mismatch",
          "The receipt approval actor must match the authenticated runtime controller.",
        );
      } else if (command.action === "review") {
        decided = reviewMissionResult({ record: current, receipt: command.receipt });
      } else if (command.action === "accept") {
        decided = acceptMissionResult({ record: current, receipt: command.receipt });
      } else if (command.action === "integrate") {
        decided = integrateMissionResult({ record: current, receipt: command.receipt });
      } else if (trusted.installedBuildRef === undefined) {
        decided = refuse(
          "installed_delivery",
          "evidence_mismatch",
          "No trusted expected build is available; a proposal cannot choose one.",
        );
      } else {
        decided = recordInstalledDelivery({
          record: current,
          receipt: command.receipt,
          expectedBuildRef: trusted.installedBuildRef,
        });
      }
    } else if (command.action === "mailbox_ack") {
      decided =
        current === undefined
          ? refuse(
              "acknowledge",
              "invalid_transition",
              "No result record exists; initialize first.",
            )
          : acknowledgeMailboxDelivery({ record: current });
    } else if (command.action === "reject") {
      decided =
        current === undefined
          ? refuse("reject", "invalid_transition", "No result record exists; initialize first.")
          : command.reason === undefined
            ? refuse("reject", "invalid_transition", "A rejection requires a reason.")
            : rejectMissionResult({ record: current, reason: command.reason });
    } else {
      // The command type is a TS interface, not wire validation: an unknown
      // runtime action fails closed and never mutates the record.
      decided = refuse(
        "reject",
        "invalid_transition",
        "Unknown result action; the command was not applied.",
      );
    }
    if (Result.isFailure(decided)) {
      return yield* persistRejection(command, canonical.id, requestHash, decided.failure);
    }
    const nextRecord = decided.success.record;
    const disposition = decided.success.disposition;
    if (index === -1) results.push(nextRecord);
    else results[index] = nextRecord;
    const nextExecution: MissionExecution = { ...execution, results };
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const updated: Mission = {
      ...canonical,
      revision: canonical.revision + 1,
      execution: nextExecution,
      updatedAt: now,
    };
    const event: MissionResultReconciledEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId: command.commandId,
      metadata: {},
      type: "mission.result-reconciled",
      payload: {
        mission: updated,
        taskId: command.taskId,
        dispatchKey: command.dispatchKey,
        operation: command.action,
        resultRevision: nextRecord.provenance.resultRevision,
        commandId: command.commandId,
        disposition,
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
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "request_conflict",
      });
    }
    const receipt: Receipts.OrchestrationCommandReceipt = {
      commandId: command.commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: commandTypeFor(command.action),
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash,
    };
    if (!(yield* receipts.insertIfAbsent(receipt))) {
      return yield* new MissionResultStoreError({
        operation: "execute",
        category: "request_conflict",
      });
    }
    return Result.succeed({
      record: nextRecord,
      receipt,
      recovered: false,
      committed: true,
      eventSequence: stored.sequence,
      disposition,
    });
  });

  const execute = Effect.fn("MissionResultStore.execute")(function* (
    command: MissionResultCommand,
  ): Effect.fn.Return<MissionResultExecuteResult, MissionResultStoreError> {
    // Trusted observations are read before the transaction; no provider
    // action, launch, or network happens inside it.
    const trusted = yield* factsPort.readFacts(command);
    const requestHash = requestHashFor(command);
    const runOnce = () =>
      sql
        .withTransaction(executeTransaction(trusted, command, requestHash))
        .pipe(Effect.mapError(toStoreError));
    const first = yield* runOnce().pipe(Effect.result);
    if (Result.isFailure(first)) {
      // A lost CAS race or receipt collision means a concurrent command won;
      // reread once so an exact duplicate recovers instead of failing.
      if (first.failure.category !== "request_conflict") return yield* first.failure;
      const second = yield* runOnce().pipe(Effect.result);
      if (Result.isFailure(second)) return yield* second.failure;
      return second.success;
    }
    return first.success;
  });

  return MissionResultStore.of({ execute });
});

export const layer = Layer.effect(MissionResultStore, make);
