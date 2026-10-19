import {
  ManagerLifecycleProgress,
  ManagerLifecycleState,
  ManagerProjectTimezone,
} from "./missionManagerTransfer.ts";
import * as Schema from "effect/Schema";

import { ApplicationEventMetadata } from "./applicationEvent.ts";
import {
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MissionExecution } from "./missionExecution.ts";
import type { MissionResultRecord, MissionResultReceipt } from "./missionResult.ts";

/**
 * Canonical opt-in mission aggregate wire schemas. A mission is a small
 * planning envelope (intent, repository bindings, task specs), not a second
 * project/task database: task specs carry only identity, hashes, dependency
 * edges, acceptance links, and bounded attempt/receipt references. No
 * transcripts, no scheduler, no runtime support.
 *
 * Domain validation and the pure CAS command planner live in the server
 * (`apps/server/src/orchestration-v2/MissionCommands.ts`); this module stays
 * a leaf with schemas and small derived definitions only, per the contracts
 * rule against heavy runtime logic. Persistence is owned by the root thread.
 * This module imports base schemas directly and registers nothing.
 */

/** Wire version of the mission aggregate. Replacements must preserve it. */
export const MISSION_SCHEMA_VERSION = 1;

/** Branded mission aggregate identifier, compatible with base ID rules. */
export const MissionId = TrimmedNonEmptyString.pipe(Schema.brand("MissionId"));
export type MissionId = typeof MissionId.Type;

/** Branded mission task identifier, compatible with base ID rules. */
export const MissionTaskId = TrimmedNonEmptyString.pipe(Schema.brand("MissionTaskId"));
export type MissionTaskId = typeof MissionTaskId.Type;

/** Branded team identifier, compatible with base ID rules. No base TeamId exists. */
export const TeamId = TrimmedNonEmptyString.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

/** Monotonic generation counter for manager assignments. Compared by CAS. */
export const MissionEpoch = NonNegativeInt;
export type MissionEpoch = typeof MissionEpoch.Type;

/** Explicit authority provenance: who decided, and the exact reference. */
export const MissionAuthorityProvenance = Schema.Struct({
  source: TrimmedNonEmptyString,
  ref: TrimmedNonEmptyString,
  decidedAt: Schema.optional(IsoDateTime),
});
export type MissionAuthorityProvenance = typeof MissionAuthorityProvenance.Type;

const isNonEmptyList = (values: ReadonlyArray<unknown>): boolean => values.length > 0;

const NonEmptyTextArray = Schema.Array(TrimmedNonEmptyString).check(
  Schema.makeFilter(isNonEmptyList, { expected: "a non-empty array" }),
);

const NonEmptyAuthorityRefs = Schema.Array(MissionAuthorityProvenance).check(
  Schema.makeFilter(isNonEmptyList, { expected: "at least one authority provenance" }),
);

const NonEmptyAncestry = Schema.Array(TrimmedNonEmptyString).check(
  Schema.makeFilter(isNonEmptyList, { expected: "at least one ancestry commit" }),
);

/** Repository binding: an existing workspace project plus required ancestry. */
export const MissionRepositoryBinding = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  baseCommit: TrimmedNonEmptyString,
  ancestry: NonEmptyAncestry,
});
export type MissionRepositoryBinding = typeof MissionRepositoryBinding.Type;

/** Non-empty set of repository bindings for a canonical multi-repository mission. */
export const MissionRepositoryBindings = Schema.Array(MissionRepositoryBinding).check(
  Schema.makeFilter(isNonEmptyList, { expected: "at least one repository binding" }),
);
export type MissionRepositoryBindings = typeof MissionRepositoryBindings.Type;

export const MissionAcceptanceCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type MissionAcceptanceCriterion = typeof MissionAcceptanceCriterion.Type;

export const MissionSourcedDecision = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  authority: MissionAuthorityProvenance,
});
export type MissionSourcedDecision = typeof MissionSourcedDecision.Type;

/** Human intent envelope: outcome, scope, authority, acceptance, decisions. */
export const MissionIntent = Schema.Struct({
  outcome: TrimmedNonEmptyString,
  scope: NonEmptyTextArray,
  exclusions: Schema.Array(TrimmedNonEmptyString),
  authorityRefs: NonEmptyAuthorityRefs,
  acceptanceCriteria: Schema.Array(MissionAcceptanceCriterion).check(
    Schema.makeFilter(isNonEmptyList, { expected: "at least one acceptance criterion" }),
  ),
  decisions: Schema.Array(MissionSourcedDecision),
});
export type MissionIntent = typeof MissionIntent.Type;

/** Where the mission integrates when its tasks complete. */
export const MissionIntegrationTarget = Schema.Struct({
  summary: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});
export type MissionIntegrationTarget = typeof MissionIntegrationTarget.Type;

/** One manager assignment: an owning thread plus its authoritative epoch. */
export const MissionManagerAssignment = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  epoch: Schema.optional(MissionEpoch),
});
export type MissionManagerAssignment = typeof MissionManagerAssignment.Type;

export const MissionManagers = Schema.Struct({
  delivery: Schema.optional(MissionManagerAssignment),
  retro: Schema.optional(MissionManagerAssignment),
});
export type MissionManagers = typeof MissionManagers.Type;

export const MissionStatus = Schema.Literals(["active", "paused", "completed", "stopped"]);
export type MissionStatus = typeof MissionStatus.Type;

/** Bounded attempt pointer: sequence number plus an optional receipt ref. */
export const MissionTaskAttempt = Schema.Struct({
  attemptNumber: NonNegativeInt,
  receiptRef: Schema.optional(TrimmedNonEmptyString),
});
export type MissionTaskAttempt = typeof MissionTaskAttempt.Type;

/**
 * Absolute path with no `.` or `..` segments and no trailing slash.
 * Decode rejects anything else; it does not rewrite a relative path into
 * a scope.
 */
const isNormalizedAbsolutePath = (value: string): boolean => {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  const segments = value.slice(1).split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
};

const NormalizedAbsolutePath = TrimmedNonEmptyString.check(
  Schema.makeFilter(isNormalizedAbsolutePath, {
    expected: "a normalized absolute path",
  }),
);

/**
 * One task spec: identity, the binding project it routes to, content hashes,
 * dependency edges, acceptance links, and the current attempt/receipt
 * pointer. Deliberately transcript-free.
 *
 * Scope and necessity fields are canonical server-owned values. Each is
 * optional so a legacy snapshot still decodes. Omitted means unavailable.
 */
export const MissionTaskSpec = Schema.Struct({
  id: MissionTaskId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  specHash: TrimmedNonEmptyString,
  dependencyHashes: Schema.Array(TrimmedNonEmptyString),
  dependencies: Schema.Array(MissionTaskId),
  acceptanceIds: Schema.Array(TrimmedNonEmptyString),
  attempt: Schema.optional(MissionTaskAttempt),
  /**
   * Normalized absolute writer path owned by the server. Absent on legacy
   * snapshots, which leaves the scope unavailable.
   */
  writerScope: Schema.optional(NormalizedAbsolutePath),
  /** Canonical shared-manifest paths. Omitted is unavailable, not an empty list. */
  sharedManifestScopes: Schema.optional(Schema.Array(NormalizedAbsolutePath)),
  /** Canonical GUI paths. Omitted is unavailable; a present empty list is empty. */
  guiScopes: Schema.optional(Schema.Array(NormalizedAbsolutePath)),
  /**
   * Whether this task is necessary. Omitted is unavailable, not false.
   */
  taskNecessary: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type MissionTaskSpec = typeof MissionTaskSpec.Type;

/** One dependency's receipt hash, taken from a canonical accepted result. */
export interface MissionDependencyReceiptHash {
  readonly taskId: string;
  readonly hash: string;
}

const acceptanceReceiptHash = (receipt: MissionResultReceipt): string =>
  [
    "mission-acceptance-receipt",
    receipt.kind,
    String(receipt.revision),
    receipt.evidenceKind,
    receipt.evidenceRef,
    receipt.commitSet.join("\u0002"),
    receipt.decidedBy,
    receipt.decidedAt,
  ].join("\u0001");

/**
 * Maps task id to the hash of its canonical acceptance receipt.
 *
 * Only results in `accepted` or `integrated` state qualify. Integrated
 * records keep the acceptance receipt from the accept transition. The hash
 * is that receipt's identity. Proposal `dependencyHashes`, spec hashes, and
 * result digests are not inputs. A task with no acceptance receipt, a
 * receipt that is not an acceptance, or two different acceptance receipts
 * is omitted so the caller treats it as unavailable.
 */
export const dependencyReceiptHashesFromAcceptedResults = (
  results: ReadonlyArray<MissionResultRecord>,
): ReadonlyArray<MissionDependencyReceiptHash> => {
  const hashes = new Map<string, string | null>();
  for (const result of results) {
    if (result.state !== "accepted" && result.state !== "integrated") continue;
    const receipt = result.acceptanceReceipt;
    const hash =
      receipt === undefined || receipt.kind !== "acceptance"
        ? null
        : acceptanceReceiptHash(receipt);
    const prior = hashes.get(result.taskId);
    hashes.set(result.taskId, prior === undefined || prior === hash ? hash : null);
  }
  return [...hashes.entries()]
    .flatMap(([taskId, hash]) => (hash === null ? [] : [{ taskId, hash }]))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
};

export const Mission = Schema.Struct({
  schemaVersion: Schema.Literal(MISSION_SCHEMA_VERSION),
  id: MissionId,
  revision: NonNegativeInt,
  teamId: TeamId,
  authorityEnvironmentId: EnvironmentId,
  /**
   * Explicit configurable project IANA timezone. Optional for backwards
   * compatibility; omitted on older snapshots. Required and validated as a
   * true IANA zone for manager successor-intent reservation, never
   * defaulted from the host. Generic revisions carry it; no dedicated
   * config endpoint exists.
   */
  projectTimezone: Schema.optional(ManagerProjectTimezone),
  bindings: MissionRepositoryBindings,
  intent: MissionIntent,
  integrationTarget: MissionIntegrationTarget,
  managers: MissionManagers,
  status: MissionStatus,
  tasks: Schema.Array(MissionTaskSpec),
  /**
   * Optional bounded execution state (admissions, writer claims, consumed
   * exception IDs). Omitted on older snapshots; only the dedicated
   * admission-reserved event appends here.
   */
  execution: Schema.optional(MissionExecution),
  updatedAt: IsoDateTime,
});
export type Mission = typeof Mission.Type;

export const MissionCreateCommand = Schema.Struct({
  type: Schema.Literal("mission.create"),
  commandId: CommandId,
  mission: Mission,
});
export type MissionCreateCommand = typeof MissionCreateCommand.Type;

export const MissionReplaceCommand = Schema.Struct({
  type: Schema.Literal("mission.replace"),
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  epoch: MissionEpoch,
  authority: MissionAuthorityProvenance,
  mission: Mission,
});
export type MissionReplaceCommand = typeof MissionReplaceCommand.Type;

export const MissionCommand = Schema.Union([MissionCreateCommand, MissionReplaceCommand]);
export type MissionCommand = typeof MissionCommand.Type;

const MissionEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: Schema.Literal("mission"),
  aggregateId: MissionId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  metadata: ApplicationEventMetadata,
} as const;

export const MissionCreatedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.created"),
  payload: Schema.Struct({
    mission: Mission,
  }),
});
export type MissionCreatedEvent = typeof MissionCreatedEvent.Type;

export const MissionRevisedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.revised"),
  payload: Schema.Struct({
    mission: Mission,
    invalidatedAdmissionRefs: Schema.Array(TrimmedNonEmptyString),
    preservedAdmissionRefs: Schema.Array(TrimmedNonEmptyString),
  }),
});
export type MissionRevisedEvent = typeof MissionRevisedEvent.Type;

export const MissionAdmissionReservedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.admission-reserved"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, execution state included. */
    mission: Mission,
    dispatchKey: TrimmedNonEmptyString,
    requestDigest: TrimmedNonEmptyString,
  }),
});
export type MissionAdmissionReservedEvent = typeof MissionAdmissionReservedEvent.Type;

export const MissionRetroCheckpointCapturedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.retro-checkpoint-captured"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, queued checkpoint descriptor included. */
    mission: Mission,
    /** Stable checkpoint id for the captured originating-thread boundary. */
    checkpointId: TrimmedNonEmptyString,
  }),
});
export type MissionRetroCheckpointCapturedEvent = typeof MissionRetroCheckpointCapturedEvent.Type;

/** Full durable analysis outcome, recoverable from its receipt sequence. */
export const MissionRetroAnalysisUpdatedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.retro-analysis-updated"),
  payload: Schema.Struct({
    mission: Mission,
    checkpointId: TrimmedNonEmptyString,
    operation: Schema.Literals(["claim", "settle"]),
  }),
});
export type MissionRetroAnalysisUpdatedEvent = typeof MissionRetroAnalysisUpdatedEvent.Type;

export const MissionRetroReportReceivedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.retro-report-received"),
  payload: Schema.Struct({
    mission: Mission,
    checkpointId: TrimmedNonEmptyString,
    sourceReportHash: TrimmedNonEmptyString,
    operation: Schema.Literal("receive"),
  }),
});
export type MissionRetroReportReceivedEvent = typeof MissionRetroReportReceivedEvent.Type;

export const MissionResultReconciledEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.result-reconciled"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, dedicated result records included. */
    mission: Mission,
    taskId: TrimmedNonEmptyString,
    dispatchKey: TrimmedNonEmptyString,
    /** Stable reconciled operation tag (initialize, arrive, observe, ...). */
    operation: TrimmedNonEmptyString,
    /** Canonical producing revision the reconciled record now carries. */
    resultRevision: NonNegativeInt,
    /** Stable idempotency key of the committed result command. */
    commandId: CommandId,
    /** Policy disposition the committed command produced. */
    disposition: TrimmedNonEmptyString,
  }),
});
export type MissionResultReconciledEvent = typeof MissionResultReconciledEvent.Type;

export const MissionManagerHandoffReservedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.manager-handoff-reserved"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, bounded reservation included. */
    mission: Mission,
    /** Stable reservation id committed by this event. */
    reservationId: TrimmedNonEmptyString,
  }),
});
export type MissionManagerHandoffReservedEvent = typeof MissionManagerHandoffReservedEvent.Type;

export const MissionManagerLifecycleAdvancedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.manager-lifecycle-advanced"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, advanced reservation lifecycle included. */
    mission: Mission,
    reservationId: TrimmedNonEmptyString,
    from: ManagerLifecycleState,
    to: ManagerLifecycleProgress,
  }),
});
export type MissionManagerLifecycleAdvancedEvent = typeof MissionManagerLifecycleAdvancedEvent.Type;

export const MissionRetroSkillEvaluatedEvent = Schema.Struct({
  ...MissionEventBaseFields,
  type: Schema.Literal("mission.retro-skill-evaluated"),
  payload: Schema.Struct({
    /** Full updated mission snapshot, the appended skill-evaluation receipt included. */
    mission: Mission,
    /** Stable id of the receipt this event committed. */
    evaluationId: TrimmedNonEmptyString,
  }),
});
export type MissionRetroSkillEvaluatedEvent = typeof MissionRetroSkillEvaluatedEvent.Type;

export const MissionEvent = Schema.Union([
  MissionCreatedEvent,
  MissionRevisedEvent,
  MissionAdmissionReservedEvent,
  MissionResultReconciledEvent,
  MissionRetroCheckpointCapturedEvent,
  MissionRetroAnalysisUpdatedEvent,
  MissionRetroReportReceivedEvent,
  MissionManagerHandoffReservedEvent,
  MissionManagerLifecycleAdvancedEvent,
  MissionRetroSkillEvaluatedEvent,
]);
export type MissionEvent = typeof MissionEvent.Type;
