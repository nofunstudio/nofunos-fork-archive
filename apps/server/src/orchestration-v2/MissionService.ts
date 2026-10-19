// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds canonical command bytes to durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  Mission,
  MissionCommand,
  MissionId,
  EventId,
  type TeamId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import type { MissionCompletionSelector } from "../../../../packages/contracts/src/missionCompletion.ts";
import * as MissionCommands from "./MissionCommands.ts";
import type { MissionRetroReportReceiveCommand } from "./MissionRetroReportStore.ts";

export type MissionTransactionRequest =
  | {
      readonly operation: "read" | "commit";
      readonly missionId: MissionId;
      readonly command?: MissionCommand | undefined;
    }
  | {
      readonly operation: "retro-report-receive";
      readonly missionId: MissionId;
      readonly command: MissionRetroReportReceiveCommand;
    }
  | {
      /**
       * Read-only completion-route handle: the selector rides as the
       * command so the opaque guard binds every actual selector byte.
       * No consumer executes or writes through this variant yet.
       */
      readonly operation: "completion-route-read";
      readonly missionId: MissionId;
      readonly command: MissionCompletionSelector;
    };

// A server-only handle: no enumerable authority, callbacks, policy, or credential
// can be encoded or persisted. Only the trusted MCP port supplies these handles.
export class MissionTransactionGuard {
  private constructor() {}

  static make(input: {
    readonly sql: SqlClient.SqlClient;
    readonly requestKey: object;
    readonly request: MissionTransactionRequest;
    readonly authority: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly controllerThreadId: ThreadId;
    };
    readonly check: (expectedMission?: Mission | null) => Effect.Effect<void, MissionServiceError>;
  }): MissionTransactionGuard {
    const handle = new MissionTransactionGuard();
    guards.set(handle, {
      ...input,
      identity: stableStringify(input.request),
      authorityIdentity: stableStringify(input.authority),
    });
    return handle;
  }

  /** Server-only owner check over the original opaque handles, on the owning SQL client. */
  static check(input: {
    readonly sql: SqlClient.SqlClient;
    readonly authority: MissionAuthority["Service"];
    readonly request: MissionTransactionRequest;
    readonly expectedMission?: Mission | null | undefined;
  }): Effect.Effect<void, MissionServiceError> {
    return Effect.suspend(() => {
      const { sql, authority, request, expectedMission } = input;
      const guard =
        authority.transactionGuard === undefined
          ? undefined
          : guards.get(authority.transactionGuard);
      if (
        guard === undefined ||
        guard.sql !== sql ||
        guard.requestKey !== authority.requestKey ||
        guard.identity !== stableStringify(request) ||
        guard.authorityIdentity !==
          stableStringify({
            teamId: authority.teamId,
            environmentId: authority.environmentId,
            controllerThreadId: authority.controllerThreadId,
          })
      )
        return Effect.fail(
          new MissionServiceError({ operation: request.operation, category: "scope_denied" }),
        );
      return guard.check(expectedMission);
    });
  }
}

const guards = new WeakMap<
  MissionTransactionGuard,
  {
    readonly sql: SqlClient.SqlClient;
    readonly requestKey: object;
    readonly identity: string;
    readonly authorityIdentity: string;
    readonly check: (expectedMission?: Mission | null) => Effect.Effect<void, MissionServiceError>;
  }
>();

/**
 * Trusted host observation supplied with mission authority.
 * Absent means the host was not qualified.
 */
export interface MissionHostQualification {
  readonly hostId: string;
  readonly bootId: string;
  readonly buildObserved: boolean;
  readonly buildOk: boolean;
  readonly toolchainObserved: boolean;
  readonly toolchainOk: boolean;
  readonly observedAtMs: number;
}

/**
 * Trusted repository observation for one bound project.
 * Absent from the authority means that project was not observed.
 */
export interface MissionRepositoryObservation {
  readonly projectId: string;
  readonly workspaceRootRealpath: string;
  readonly observedAncestry: ReadonlyArray<string>;
  readonly observedAtMs: number;
}

/**
 * The authenticated runtime supplies this scope; request payloads cannot replace it.
 * `teamId`, `environmentId`, and `controllerThreadId` remain the scope checked
 * by the service and the transaction guard. Delivery thread and epoch stay on
 * the canonical mission. Company, host, and repository observations are
 * optional trusted facts: omitted means unavailable.
 */
export class MissionAuthority extends Context.Service<
  MissionAuthority,
  {
    readonly teamId: TeamId;
    readonly environmentId: EnvironmentId;
    readonly controllerThreadId: ThreadId;
    readonly company?: string | undefined;
    readonly hostQualification?: MissionHostQualification | undefined;
    readonly repositoryObservations?: ReadonlyArray<MissionRepositoryObservation> | undefined;
    readonly transactionGuard?: MissionTransactionGuard | undefined;
    readonly requestKey?: object | undefined;
  }
>()("t3/orchestration-v2/MissionService/MissionAuthority") {}

export class MissionServiceError extends Schema.TaggedError<MissionServiceError>()(
  "MissionServiceError",
  {
    operation: Schema.Literals(["read", "commit", "retro-report-receive", "completion-route-read"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission ${this.operation} failed (${this.category}).`;
  }
}

export class MissionService extends Context.Service<
  MissionService,
  {
    readonly get: (id: MissionId) => Effect.Effect<Option.Option<Mission>, MissionServiceError>;
    readonly execute: (command: MissionCommand) => Effect.Effect<
      {
        readonly receipt: Receipts.OrchestrationCommandReceipt;
        readonly committed: boolean;
      },
      MissionServiceError | MissionCommands.MissionPlanError
    >;
  }
>()("t3/orchestration-v2/MissionService") {}

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeCommandSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(MissionCommand));
const encodeCommand = Schema.encodeEffect(MissionCommand);
const decodeRejection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionCommands.MissionPlanError),
);
const encodeRejection = Schema.encodeEffect(
  Schema.fromJsonString(MissionCommands.MissionPlanError),
);
const isServiceError = Schema.is(MissionServiceError);
const isPlanError = Schema.is(MissionCommands.MissionPlanError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  const checkAuthority = (
    request: MissionTransactionRequest,
    expectedMission?: Mission | null,
  ): Effect.Effect<void, MissionServiceError> =>
    // Internal callers retain their existing trusted authority contract.
    authority.transactionGuard === undefined
      ? Effect.void
      : MissionTransactionGuard.check({ sql, authority, request, expectedMission });

  const read = Effect.fn("MissionService.get")(function* (id: MissionId) {
    // Check scope in SQL before decoding or returning any retained content.
    const rows = yield* sql<{ snapshot_json: string }>`
      SELECT snapshot_json FROM projection_missions
      WHERE mission_id = ${id} AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    return rows[0] === undefined
      ? Option.none()
      : Option.some(yield* decodeMission(rows[0].snapshot_json));
  });

  const execute = Effect.fn("MissionService.execute")(function* (input: MissionCommand) {
    // Detach every command field before I/O, not only the proposal.
    const command = yield* decodeCommandSnapshot(stableStringify(input));
    const request = { operation: "commit" as const, missionId: command.mission.id, command };
    if (
      command.mission.teamId !== authority.teamId ||
      command.mission.authorityEnvironmentId !== authority.environmentId
    ) {
      return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
    }
    const encoded = yield* encodeCommand(command);
    const requestHash = NodeCrypto.createHash("sha256")
      .update(stableStringify(encoded))
      .digest("hex");
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const outcome = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkAuthority(request);
        // Scope checks precede receipt lookups, including replay of completed work.
        const owner = yield* sql<{ team_id: string; authority_environment_id: string }>`
        SELECT team_id, authority_environment_id FROM projection_missions
        WHERE mission_id = ${command.mission.id}
      `;
        if (
          owner[0] !== undefined &&
          (owner[0].team_id !== authority.teamId ||
            owner[0].authority_environment_id !== authority.environmentId)
        ) {
          return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
        }
        const current = yield* read(command.mission.id);
        const manager = Option.isSome(current)
          ? current.value.managers.delivery
          : command.mission.managers.delivery;
        if (manager?.threadId !== authority.controllerThreadId || manager.epoch === undefined) {
          return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
        }
        yield* checkAuthority(request);
        const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
        // Receipt I/O may yield. Revalidate the original canonical role and
        // snapshot before planning, replay, rejection, or any mutation.
        yield* checkAuthority(request);
        const fresh = yield* read(command.mission.id);
        if (
          stableStringify(Option.getOrNull(fresh)) !== stableStringify(Option.getOrNull(current))
        ) {
          return yield* new MissionServiceError({ operation: "commit", category: "scope_denied" });
        }
        yield* checkAuthority(request);
        if (Option.isSome(prior)) {
          if (
            prior.value.aggregateKind !== "mission" ||
            prior.value.aggregateId !== command.mission.id ||
            prior.value.requestHash !== requestHash
          ) {
            return yield* new MissionServiceError({
              operation: "commit",
              category: "request_conflict",
            });
          }
          yield* checkAuthority(request, Option.getOrNull(current));
          return prior.value.status === "rejected"
            ? Result.fail(yield* decodeRejection(prior.value.error))
            : Result.succeed({ receipt: prior.value, committed: false });
        }
        const planned = MissionCommands.planMissionCommand(command, Option.getOrNull(current), {
          sequence: 0,
          eventId: EventId.make(`mission:${command.commandId}`),
          occurredAt: now,
        });
        if (Result.isFailure(planned)) {
          const reserved = yield* receipts.insertIfAbsent({
            commandId: command.commandId,
            aggregateKind: "mission",
            aggregateId: command.mission.id,
            commandType: command.type,
            acceptedAt: now,
            resultSequence: 0,
            status: "rejected",
            error: yield* encodeRejection(planned.failure),
            requestHash,
          });
          if (!reserved)
            return yield* new MissionServiceError({
              operation: "commit",
              category: "request_conflict",
            });
          yield* checkAuthority(request, Option.getOrNull(current));
          return Result.fail(planned.failure);
        }
        const event = yield* events.appendMissionEvent(planned.success.event);
        const snapshot = yield* encodeMission(planned.success.mission);
        yield* sql`
        INSERT INTO projection_missions (
          mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at
        ) VALUES (
          ${command.mission.id}, ${authority.teamId}, ${authority.environmentId},
          ${planned.success.mission.revision}, ${snapshot}, ${now}
        )
        ON CONFLICT(mission_id) DO UPDATE SET
          revision = excluded.revision, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `;
        const receipt: Receipts.OrchestrationCommandReceipt = {
          commandId: command.commandId,
          aggregateKind: "mission",
          aggregateId: command.mission.id,
          commandType: command.type,
          acceptedAt: now,
          resultSequence: event.sequence,
          status: "accepted",
          error: null,
          requestHash,
        };
        if (!(yield* receipts.insertIfAbsent(receipt))) {
          return yield* new MissionServiceError({
            operation: "commit",
            category: "request_conflict",
          });
        }
        // The guard linearizes authorization at its final synchronized live
        // credential check, bracketed by the same local policy revision. SQL
        // still owns the transaction, including event/projection/receipt writes.
        // Failure or interruption here rolls them all back.
        yield* checkAuthority(request, planned.success.mission);
        return Result.succeed({ receipt, committed: true });
      }),
    );
    return yield* Result.isFailure(outcome)
      ? Effect.fail(outcome.failure)
      : Effect.succeed(outcome.success);
  });
  return MissionService.of({
    get: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const request = { operation: "read" as const, missionId: id };
            yield* checkAuthority(request);
            const found = yield* read(id);
            yield* checkAuthority(request, Option.getOrNull(found));
            return found;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isServiceError(cause)
              ? cause
              : new MissionServiceError({ operation: "read", category: "persistence", cause }),
          ),
        ),
    execute: (command) =>
      execute(command).pipe(
        Effect.mapError((cause) =>
          isServiceError(cause) || isPlanError(cause)
            ? cause
            : new MissionServiceError({ operation: "commit", category: "persistence", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(MissionService, make);
