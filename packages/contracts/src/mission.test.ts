import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  Mission,
  MissionCommand,
  MissionEvent,
  dependencyReceiptHashesFromAcceptedResults,
} from "./mission.ts";
import { MissionResultRecord } from "./missionResult.ts";
import {
  MAX_MISSION_EXECUTION_ADMISSIONS,
  MAX_MISSION_EXECUTION_RESULTS,
  MissionExecution,
  emptyMissionExecution,
  isEmptyMissionExecution,
  missionExecutionResults,
  missionManagerReservations,
  missionRetroCheckpoints,
  missionRetroSkillEvaluations,
} from "./missionExecution.ts";
import {
  MAX_MISSION_RETRO_SKILL_EVALUATIONS,
  MissionRetroSkillEvaluation,
} from "./missionRetroSkillEvaluation.ts";
import {
  MAX_MISSION_RETRO_CHECKPOINTS,
  MissionRetroCheckpoint,
  MissionRetroCheckpoints,
  MissionRetroSourceRef,
} from "./missionRetro.ts";
import { MAX_QUARANTINE_ENTRIES } from "./missionResult.ts";
import { MissionRetroReportReceipt } from "./missionRetroReportReceipt.ts";
import {
  MAX_MANAGER_TRANSFER_RESERVATIONS,
  MissionManagerReservation,
} from "./missionManagerTransfer.ts";

const decodeCommand = Schema.decodeUnknownSync(MissionCommand);

const decodeEvent = Schema.decodeUnknownSync(MissionEvent);

const encodeMission = Schema.encodeSync(Mission);

const decodeExecution = Schema.decodeUnknownSync(MissionExecution);
const decodeReceipt = Schema.decodeUnknownSync(MissionRetroReportReceipt);
const decodeMission = Schema.decodeUnknownSync(Mission);
const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));
const decodeMissionJson = Schema.decodeUnknownSync(Schema.fromJsonString(Mission));
const decodeResult = Schema.decodeUnknownSync(MissionResultRecord);

const decodeRetroCheckpoint = Schema.decodeUnknownSync(MissionRetroCheckpoint);
const decodeSkillEvaluation = Schema.decodeUnknownSync(MissionRetroSkillEvaluation);
const decodeRetroCheckpoints = Schema.decodeUnknownSync(MissionRetroCheckpoints);
const decodeRetroSourceRef = Schema.decodeUnknownSync(MissionRetroSourceRef);
const encodeExecution = Schema.encodeSync(MissionExecution);
const encodeRetroCheckpoint = Schema.encodeSync(MissionRetroCheckpoint);

const OCCURRED_AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const missionFixture = () => ({
  schemaVersion: 1,
  id: "mission-1",
  revision: 0,
  teamId: "team-1",
  authorityEnvironmentId: "env-1",
  bindings: [
    {
      projectId: "project-1",
      workspaceRoot: "/tmp/project",
      baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
      ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
    },
    {
      projectId: "project-2",
      workspaceRoot: "/tmp/project-two",
      baseCommit: "b2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
      ancestry: ["b2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
    },
  ],
  intent: {
    outcome: "Ship the opt-in mission aggregate.",
    scope: ["contracts"],
    exclusions: ["persistence"],
    authorityRefs: [{ ...AUTHORITY }],
    acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
    decisions: [{ id: "d-1", text: "Small leaf module.", authority: { ...AUTHORITY } }],
  },
  integrationTarget: { summary: "Root store follow-up." },
  managers: { delivery: { threadId: "thread-1", epoch: 3 } },
  status: "active",
  tasks: [
    {
      id: "task-a",
      projectId: "project-1",
      title: "Define schemas",
      specHash: "hash-a1",
      dependencyHashes: [],
      dependencies: [],
      acceptanceIds: ["ac-1"],
      attempt: { attemptNumber: 1, receiptRef: "receipt-a" },
      updatedAt: OCCURRED_AT,
    },
    {
      id: "task-b",
      projectId: "project-2",
      title: "Define planner",
      specHash: "hash-b1",
      dependencyHashes: ["hash-a1"],
      dependencies: ["task-a"],
      acceptanceIds: ["ac-1"],
      attempt: { attemptNumber: 1, receiptRef: "receipt-b" },
      updatedAt: OCCURRED_AT,
    },
  ],
  updatedAt: OCCURRED_AT,
});

const resultRecord = (patch: Record<string, unknown> = {}) =>
  decodeResult({
    taskId: "task-a",
    attemptNumber: 1,
    state: "produced",
    outcome: "completed",
    digests: {
      inputDigest: "proposal-spec-hash",
      dependencyDigest: "proposal-dependency-hash",
      acceptanceDigest: "proposal-acceptance-hash",
    },
    provenance: {
      childTaskId: "child",
      childThreadId: "thread",
      childRunId: "run",
      commitSet: ["commit-1"],
      requiredAncestry: ["base"],
      ancestry: ["base"],
      source: "server",
      sourceRef: "ref",
      resultRevision: 1,
    },
    summaryText: "done",
    cancellationRequested: false,
    pendingChildRuns: false,
    mailboxAcked: true,
    quarantined: [],
    ...patch,
  });

const acceptanceReceipt = {
  kind: "acceptance",
  revision: 4,
  commitSet: ["commit-1"],
  evidenceKind: "test_report",
  evidenceRef: "evidence-accepted",
  decidedBy: "delivery",
  decidedAt: OCCURRED_AT,
} as const;

describe("dependency receipt hashes", () => {
  it("derives hashes from canonical acceptance receipts, not proposal digests", () => {
    const accepted = resultRecord({ state: "accepted", acceptanceReceipt });
    const hashes = dependencyReceiptHashesFromAcceptedResults([
      resultRecord(),
      resultRecord({
        taskId: "task-reviewed",
        state: "reviewed",
        acceptanceReceipt,
      }),
      accepted,
      resultRecord({
        taskId: "task-integrated",
        state: "integrated",
        acceptanceReceipt,
        integrationReceipt: { ...acceptanceReceipt, kind: "integration", evidenceRef: "merge-1" },
      }),
    ]);

    expect(hashes.map((entry) => entry.taskId)).toEqual(["task-a", "task-integrated"]);
    expect(hashes[0]?.hash).toBe(hashes.find((entry) => entry.taskId === "task-integrated")?.hash);
    expect(hashes[0]?.hash).not.toContain("proposal-");
    expect(hashes[0]?.hash).toContain("evidence-accepted");
    expect(hashes[0]?.hash).not.toContain("merge-1");
  });

  it("omits a task whose accepted results disagree or lack an acceptance receipt", () => {
    expect(
      dependencyReceiptHashesFromAcceptedResults([
        resultRecord({ state: "accepted" }),
        resultRecord({
          taskId: "task-b",
          state: "accepted",
          acceptanceReceipt: { ...acceptanceReceipt, kind: "review" },
        }),
        resultRecord({ taskId: "task-c", state: "accepted", acceptanceReceipt }),
        resultRecord({
          taskId: "task-c",
          state: "accepted",
          acceptanceReceipt: { ...acceptanceReceipt, evidenceRef: "other-evidence" },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("mission wire schemas", () => {
  it("round-trips a multi-repository mission", () => {
    const decoded = decodeMission(missionFixture());
    const encoded = encodeMission(decoded);
    expect(encoded.bindings).toHaveLength(2);
    expect(decodeMission(encoded)).toEqual(decoded);
  });

  it("round-trips create and replace commands", () => {
    const create = decodeCommand({
      type: "mission.create",
      commandId: "cmd-1",
      mission: missionFixture(),
    });
    expect(create.type).toBe("mission.create");
    const replace = decodeCommand({
      type: "mission.replace",
      commandId: "cmd-2",
      expectedRevision: 0,
      epoch: 3,
      authority: { ...AUTHORITY },
      mission: { ...missionFixture(), revision: 1 },
    });
    expect(replace.type).toBe("mission.replace");
  });

  it("round-trips a revised event with admission splits", () => {
    const event = decodeEvent({
      sequence: 7,
      eventId: "event-7",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-2",
      metadata: {},
      type: "mission.revised",
      payload: {
        mission: { ...missionFixture(), revision: 1 },
        invalidatedAdmissionRefs: ["receipt-a"],
        preservedAdmissionRefs: ["receipt-b"],
      },
    });
    expect(event.type).toBe("mission.revised");
  });

  it("rejects a non-1 schema version at decode", () => {
    expect(() => decodeMission({ ...missionFixture(), schemaVersion: 2 })).toThrow();
  });

  it("rejects empty bindings at decode", () => {
    expect(() => decodeMission({ ...missionFixture(), bindings: [] })).toThrow();
  });

  it("decodes an omitted execution as backwards compatible", () => {
    const decoded = decodeMission(missionFixture());
    expect(decoded.execution).toBeUndefined();
  });

  it("keeps admission scopes absent on a legacy mission snapshot", () => {
    const decoded = decodeMissionJson(JSON.stringify(missionFixture()));
    const task = decoded.tasks[0]!;
    expect(task.writerScope).toBeUndefined();
    expect(task.sharedManifestScopes).toBeUndefined();
    expect(task.guiScopes).toBeUndefined();
    expect(task.taskNecessary).toBeUndefined();
    const persisted = JSON.parse(encodeMissionJson(decoded)) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(persisted.tasks[0]).not.toHaveProperty("writerScope");
    expect(persisted.tasks[0]).not.toHaveProperty("sharedManifestScopes");
    expect(persisted.tasks[0]).not.toHaveProperty("guiScopes");
    expect(persisted.tasks[0]).not.toHaveProperty("taskNecessary");
  });

  it("round-trips canonical task scopes and necessity", () => {
    const mission = missionFixture();
    const task = mission.tasks[0]!;
    const scoped = {
      ...mission,
      tasks: [
        {
          ...task,
          writerScope: "/workspace/project/src/admission",
          sharedManifestScopes: ["/workspace/project/package.json"],
          guiScopes: [],
          taskNecessary: true,
        },
        mission.tasks[1],
      ],
    };
    const decoded = decodeMissionJson(JSON.stringify(scoped));
    expect(decoded.tasks[0]).toMatchObject({
      writerScope: "/workspace/project/src/admission",
      sharedManifestScopes: ["/workspace/project/package.json"],
      guiScopes: [],
      taskNecessary: true,
    });
    expect(decodeMissionJson(encodeMissionJson(decoded)).tasks[0]).toMatchObject({
      writerScope: "/workspace/project/src/admission",
      sharedManifestScopes: ["/workspace/project/package.json"],
      guiScopes: [],
      taskNecessary: true,
    });
  });

  it("rejects a task scope that is not a normalized absolute path", () => {
    const withScope = (writerScope: string) => ({
      ...missionFixture(),
      tasks: [{ ...missionFixture().tasks[0], writerScope }],
    });
    for (const writerScope of [
      "src/admission",
      "/tmp/../etc",
      "/tmp/foo/",
      "/tmp//foo",
      "C:\\tmp",
    ]) {
      expect(() => decodeMission(withScope(writerScope))).toThrow();
    }
    expect(() =>
      decodeMission({
        ...missionFixture(),
        tasks: [
          {
            ...missionFixture().tasks[0],
            sharedManifestScopes: ["../package.json"],
          },
        ],
      }),
    ).toThrow();
  });

  it("round-trips bounded execution state", () => {
    const admission = {
      dispatchKey: '["mission-admission","team-1","env-1","mission-1","task-a",1,"write"]',
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 1,
      operation: "write",
      requestDigest: "digest-1",
      admittedAtMs: 1_760_400_000_000,
      chosenRoute: {
        providerInstanceId: "codex_personal",
        modelId: "model-a",
        profile: "muse-focused high",
      },
      rejectedRoutes: [],
      accountVerifiedAtMs: 1_760_399_999_000,
      hostObservedAtMs: 1_760_399_995_000,
      repositoryObservedAtMs: 1_760_399_995_000,
      accountId: "acct-1",
      billingMode: "subscription",
      hostId: "test-host",
      bootId: "test-boot",
      hostThreadId: "thread-1",
      hostEpoch: 3,
      unknownUsageException: false,
      unknownUsageExceptionId: null,
      exceptionConsumptionRef: null,
    };
    const execution = decodeExecution({
      ...emptyMissionExecution(),
      admissions: [admission],
      writerClaims: [
        {
          scope: "/tmp/project/work",
          dispatchKey: admission.dispatchKey,
          missionId: "mission-1",
          taskId: "task-a",
          attemptNumber: 1,
          operation: "write",
        },
      ],
      consumedExceptionIds: ["ex-1"],
    });
    const decoded = decodeMission({ ...missionFixture(), execution });
    expect(decoded.execution).toEqual(execution);
    expect(encodeMission(decoded).execution).toEqual(execution);
  });

  it("rejects execution beyond the admission bound", () => {
    const admission = {
      dispatchKey: "key",
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      taskId: "task-a",
      attemptNumber: 1,
      operation: "write",
      requestDigest: "digest",
      admittedAtMs: 1,
      chosenRoute: {
        providerInstanceId: "codex_personal",
        modelId: "model-a",
        profile: "p",
      },
      rejectedRoutes: [],
      accountVerifiedAtMs: 1,
      hostObservedAtMs: 1,
      repositoryObservedAtMs: 1,
      accountId: "acct-1",
      billingMode: "subscription",
      hostId: "h",
      bootId: "b",
      hostThreadId: "thread-1",
      hostEpoch: 3,
      unknownUsageException: false,
      unknownUsageExceptionId: null,
      exceptionConsumptionRef: null,
    };
    expect(() =>
      decodeExecution({
        ...emptyMissionExecution(),
        admissions: Array.from({ length: MAX_MISSION_EXECUTION_ADMISSIONS + 1 }, () => ({
          ...admission,
        })),
      }),
    ).toThrow();
  });

  it("round-trips a mission.admission-reserved event", () => {
    const event = decodeEvent({
      sequence: 9,
      eventId: "event-9",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-9",
      metadata: {},
      type: "mission.admission-reserved",
      payload: {
        mission: { ...missionFixture(), revision: 1, execution: emptyMissionExecution() },
        dispatchKey: '["mission-admission","team-1","env-1","mission-1","task-a",1,"write"]',
        requestDigest: "digest-1",
      },
    });
    expect(event.type).toBe("mission.admission-reserved");
    if (event.type === "mission.admission-reserved") {
      expect(event.payload.mission.revision).toBe(1);
    }
  });

  it("decodes an omitted results array as empty", () => {
    const decoded = decodeExecution({
      admissions: [],
      writerClaims: [],
      consumedExceptionIds: [],
    });
    expect(missionExecutionResults(decoded)).toEqual([]);
    expect(isEmptyMissionExecution(decoded)).toBe(true);
    expect(missionExecutionResults(decodeExecution(emptyMissionExecution()))).toEqual([]);
  });

  it("treats result records as execution state that cannot be forged at create", () => {
    const record = {
      taskId: "task-a",
      attemptNumber: 1,
      state: "produced",
      outcome: "completed",
      digests: {
        inputDigest: "input:1",
        dependencyDigest: "deps:1",
        acceptanceDigest: "accept:1",
      },
      provenance: {
        childTaskId: "task-a",
        childThreadId: "thread-1",
        childRunId: "run-1",
        commitSet: ["commit:aaa"],
        requiredAncestry: ["commit:base"],
        ancestry: ["commit:base", "commit:aaa"],
        source: "subagent-run",
        sourceRef: "run-1",
        resultRevision: 0,
      },
      summaryText: "Done.",
      cancellationRequested: false,
      pendingChildRuns: false,
      mailboxAcked: false,
      quarantined: [],
    };
    const withResult = decodeExecution({ ...emptyMissionExecution(), results: [record] });
    expect(missionExecutionResults(withResult)).toHaveLength(1);
    expect(isEmptyMissionExecution(withResult)).toBe(false);
  });

  it("rejects result records beyond the bound at decode", () => {
    const record = {
      taskId: "task-a",
      attemptNumber: 1,
      state: "produced",
      outcome: "completed",
      digests: {
        inputDigest: "input:1",
        dependencyDigest: "deps:1",
        acceptanceDigest: "accept:1",
      },
      provenance: {
        childTaskId: "task-a",
        childThreadId: "thread-1",
        childRunId: "run-1",
        commitSet: ["commit:aaa"],
        requiredAncestry: ["commit:base"],
        ancestry: ["commit:base", "commit:aaa"],
        source: "subagent-run",
        sourceRef: "run-1",
        resultRevision: 0,
      },
      summaryText: "Done.",
      cancellationRequested: false,
      pendingChildRuns: false,
      mailboxAcked: false,
      quarantined: [],
    };
    expect(() =>
      decodeExecution({
        ...emptyMissionExecution(),
        results: Array.from({ length: MAX_MISSION_EXECUTION_RESULTS + 1 }, () => ({ ...record })),
      }),
    ).toThrow();
  });

  it("rejects quarantine beyond its bound at decode", () => {
    const decoded = decodeExecution(emptyMissionExecution());
    expect(missionExecutionResults(decoded)).toEqual([]);
    const entry = { resultRevision: 0, summaryText: "Held.", reason: "stale: test" };
    const record = {
      taskId: "task-a",
      attemptNumber: 1,
      state: "produced",
      outcome: "completed",
      digests: {
        inputDigest: "input:1",
        dependencyDigest: "deps:1",
        acceptanceDigest: "accept:1",
      },
      provenance: {
        childTaskId: "task-a",
        childThreadId: "thread-1",
        childRunId: "run-1",
        commitSet: ["commit:aaa"],
        requiredAncestry: ["commit:base"],
        ancestry: ["commit:base", "commit:aaa"],
        source: "subagent-run",
        sourceRef: "run-1",
        resultRevision: 0,
      },
      summaryText: "Done.",
      cancellationRequested: false,
      pendingChildRuns: false,
      mailboxAcked: false,
      quarantined: Array.from({ length: MAX_QUARANTINE_ENTRIES + 1 }, () => ({ ...entry })),
    };
    expect(() => decodeExecution({ ...emptyMissionExecution(), results: [record] })).toThrow();
  });

  it("round-trips bounded retro checkpoint descriptors as empty by default", () => {
    const decoded = decodeExecution(emptyMissionExecution());
    expect(missionRetroCheckpoints(decoded)).toEqual([]);
    expect(isEmptyMissionExecution(decoded)).toBe(true);
    const checkpoint = decodeRetroCheckpoint({
      checkpointId: "retro-0123456789abcdef0123456789abcdef",
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      sourceThreadId: "thread-origin",
      sourceRoot: "thread://thread-origin",
      trigger: "milestone",
      requestedReporter: "muse-spark-1.3",
      status: "queued_ready",
      coverage: "full",
      snapshotFingerprint: "a".repeat(64),
      coveredFromInclusive: 4,
      coveredToExclusive: 12,
      sourceRefs: [
        {
          rootRef: "thread://thread-origin",
          chunkRef: "chunk-4-12",
          chunkHash: "b".repeat(64),
          coveredFromInclusive: 4,
          coveredToExclusive: 12,
        },
      ],
      omissions: [],
      capturedAt: OCCURRED_AT,
    });
    const legacy = {
      ...encodeRetroCheckpoint(checkpoint),
      requestedReporter: "muse-spark-1.3-contributor",
    };
    expect(encodeRetroCheckpoint(decodeRetroCheckpoint(legacy))).toEqual(legacy);
    const withCheckpoint = decodeExecution({
      ...emptyMissionExecution(),
      retroCheckpoints: [checkpoint],
    });
    expect(missionRetroCheckpoints(withCheckpoint)).toHaveLength(1);
    expect(isEmptyMissionExecution(withCheckpoint)).toBe(false);
    const roundTripped = decodeMission({
      ...missionFixture(),
      execution: encodeExecution(withCheckpoint),
    });
    expect(missionRetroCheckpoints(roundTripped.execution!)).toHaveLength(1);
  });

  it("rejects retro checkpoints beyond the bound at decode", () => {
    const checkpoint = decodeRetroCheckpoint({
      checkpointId: "retro-bound",
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      sourceThreadId: "thread-origin",
      sourceRoot: "thread://thread-origin",
      trigger: "settled",
      requestedReporter: "muse-spark-1.3",
      status: "queued_capacity",
      coverage: "unknown",
      snapshotFingerprint: "c".repeat(64),
      coveredFromInclusive: 0,
      coveredToExclusive: 3,
      sourceRefs: [],
      omissions: ["range 1-2 redacted before export"],
      capturedAt: OCCURRED_AT,
    });
    expect(() =>
      decodeRetroCheckpoints(
        Array.from({ length: MAX_MISSION_RETRO_CHECKPOINTS + 1 }, () => ({ ...checkpoint })),
      ),
    ).toThrow();
  });

  it("rejects reversed or empty retro ranges at decode", () => {
    const ref = {
      rootRef: "thread://thread-origin",
      chunkRef: "chunk-0-0",
      chunkHash: "d".repeat(64),
      coveredFromInclusive: 5,
      coveredToExclusive: 5,
    };
    expect(() => decodeRetroSourceRef(ref)).toThrow();
    expect(() =>
      decodeRetroSourceRef({
        ...ref,
        coveredFromInclusive: 9,
        coveredToExclusive: 5,
      }),
    ).toThrow();
    expect(() =>
      decodeRetroSourceRef({
        ...ref,
        chunkHash: "not-a-sha256",
        coveredFromInclusive: 1,
        coveredToExclusive: 2,
      }),
    ).toThrow();
  });

  it("round-trips a mission.retro-checkpoint-captured event with the full mission", () => {
    const event = decodeEvent({
      sequence: 13,
      eventId: "event-13",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-13",
      metadata: {},
      type: "mission.retro-checkpoint-captured",
      payload: {
        mission: { ...missionFixture(), revision: 3, execution: emptyMissionExecution() },
        checkpointId: "retro-0123456789abcdef0123456789abcdef",
      },
    });
    expect(event.type).toBe("mission.retro-checkpoint-captured");
    if (event.type === "mission.retro-checkpoint-captured") {
      expect(event.payload.mission.revision).toBe(3);
      expect(event.payload.checkpointId).toBe("retro-0123456789abcdef0123456789abcdef");
    }
  });

  it("round-trips a mission.result-reconciled event with the full mission", () => {
    const event = decodeEvent({
      sequence: 11,
      eventId: "event-11",
      aggregateKind: "mission",
      aggregateId: "mission-1",
      occurredAt: OCCURRED_AT,
      commandId: "cmd-11",
      metadata: {},
      type: "mission.result-reconciled",
      payload: {
        mission: { ...missionFixture(), revision: 2, execution: emptyMissionExecution() },
        taskId: "task-a",
        dispatchKey: '["mission-admission","team-1","env-1","mission-1","task-a",1,"write"]',
        operation: "accept",
        resultRevision: 3,
        commandId: "cmd-11",
        disposition: "advanced",
      },
    });
    expect(event.type).toBe("mission.result-reconciled");
    if (event.type === "mission.result-reconciled") {
      expect(event.payload.mission.revision).toBe(2);
      expect(event.payload.operation).toBe("accept");
      expect(event.payload.resultRevision).toBe(3);
      expect(event.payload.commandId).toBe("cmd-11");
    }
  });
});

it("retains analysis state as execution evidence and bounds its leaf array", () => {
  const queued = {
    checkpointId: "retro-one",
    teamId: "team-1",
    environmentId: "env-1",
    missionId: "mission-1",
    sourceThreadId: "origin",
    sourceRoot: "thread://origin",
    snapshotFingerprint: "a".repeat(64),
    coveredFromInclusive: 1,
    coveredToExclusive: 2,
    managerThreadId: "retro-manager",
    managerEpoch: 4,
    status: "queued_capacity",
    queueReason: "capacity",
    fence: 0,
    attemptNumber: 0,
    lease: null,
    settlement: null,
  };
  const execution = decodeExecution({ ...emptyMissionExecution(), retroAnalyses: [queued] });
  expect(isEmptyMissionExecution(execution)).toBe(false);
  expect(encodeExecution(execution)).toMatchObject({ retroAnalyses: [queued] });
  expect(() =>
    decodeExecution({
      ...emptyMissionExecution(),
      retroAnalyses: Array.from({ length: 65 }, (_, index) => ({
        ...queued,
        checkpointId: `retro-${index}`,
      })),
    }),
  ).toThrow();
});

it("round-trips bounded retro report receipts and the received event", () => {
  const receipt = decodeReceipt({
    checkpointId: "retro-one",
    teamId: "team-1",
    environmentId: "env-1",
    missionId: "mission-1",
    sourceThreadId: "origin",
    sourceRoot: "thread://origin",
    snapshotFingerprint: "a".repeat(64),
    coveredFromInclusive: 1,
    coveredToExclusive: 2,
    reporterChildThreadId: "child-1",
    reporterRunId: "run-1",
    assignmentToken: "b".repeat(64),
    fence: 1,
    attemptNumber: 1,
    reportRevision: 1,
    accountId: "account",
    providerInstanceId: "muse-personal",
    modelId: "muse-spark-1.3",
    profile: "muse-review",
    company: "No Fun",
    originalArtifactRef: "retro-original:abc",
    originalArtifactSha: "c".repeat(64),
    claimedSourceReportHash: "d".repeat(64),
    sourceReportHash: "d".repeat(64),
    normalizedArtifactRef: "retro-normalized:" + "e".repeat(64),
    normalizedArtifactSha: "f".repeat(64),
    coverageEvidenceRef: "retro-coverage:fixture",
    coverageEvidenceSha: "a".repeat(64),
    normalizedReportHash: "e".repeat(64),
    verdict: "no_change",
    disposition: "queued_for_triage",
    coverageFull: true,
    coverageReasonRefs: [],
    incidentCount: 0,
    shortlistCount: 0,
    incidentArtifactRef: "retro-normalized:" + "e".repeat(64),
    receivedAt: OCCURRED_AT,
    quarantine: [],
  });
  expect(receipt.sourceReportHash).not.toBe(receipt.normalizedReportHash);
  const withReceipts = decodeExecution({
    ...emptyMissionExecution(),
    retroReportReceipts: [receipt],
  });
  expect(isEmptyMissionExecution(withReceipts)).toBe(false);
  expect(() =>
    decodeExecution({
      ...emptyMissionExecution(),
      retroReportReceipts: Array.from({ length: 65 }, (_, i) => ({
        ...receipt,
        checkpointId: `retro-${i}`,
        sourceReportHash: String(i).padStart(64, "0"),
      })),
    }),
  ).toThrow();
  const event = decodeEvent({
    sequence: 21,
    eventId: "report-event",
    aggregateKind: "mission",
    aggregateId: "mission-1",
    occurredAt: OCCURRED_AT,
    commandId: "report-cmd",
    metadata: {},
    type: "mission.retro-report-received",
    payload: {
      mission: { ...missionFixture(), execution: withReceipts },
      checkpointId: "retro-one",
      sourceReportHash: "d".repeat(64),
      operation: "receive",
    },
  });
  expect(event.type).toBe("mission.retro-report-received");
});

it("round-trips the full retro analysis update event", () => {
  const event = decodeEvent({
    sequence: 1,
    eventId: "analysis-event",
    aggregateKind: "mission",
    aggregateId: "mission-1",
    occurredAt: OCCURRED_AT,
    commandId: "analysis-cmd",
    metadata: {},
    type: "mission.retro-analysis-updated",
    payload: {
      mission: { ...missionFixture(), execution: emptyMissionExecution() },
      checkpointId: "retro-one",
      operation: "claim",
    },
  });
  expect(event.type).toBe("mission.retro-analysis-updated");
});

const reservationFixture = () => ({
  reservationId: "mgr-reserve-0123456789abcdef0123456789abcdef",
  successorThreadId: "thread-successor-1",
  role: "delivery",
  currentThreadId: "thread-1",
  currentEpoch: 3,
  observedRevision: 0,
  timezone: "America/Denver",
  localDate: "2026-10-13",
  ordinal: 0,
  reason: "first_slot",
  artifactRef: `manager-handoff:${"a".repeat(64)}`,
  artifactSha256: "a".repeat(64),
  commandId: "reserve-cmd-1",
  requestDigest: "b".repeat(64),
  reservedAt: OCCURRED_AT,
});

const decodeReservation = Schema.decodeUnknownSync(MissionManagerReservation);

it("decodes an omitted projectTimezone as backwards compatible", () => {
  const decoded = decodeMission(missionFixture());
  expect(decoded.projectTimezone).toBeUndefined();
  const zoned = decodeMission({ ...missionFixture(), projectTimezone: "America/Denver" });
  expect(zoned.projectTimezone).toBe("America/Denver");
  expect(encodeMission(zoned).projectTimezone).toBe("America/Denver");
});

it("decodes omitted manager reservations as empty", () => {
  const decoded = decodeExecution({
    admissions: [],
    writerClaims: [],
    consumedExceptionIds: [],
  });
  expect(missionManagerReservations(decoded)).toEqual([]);
  expect(isEmptyMissionExecution(decoded)).toBe(true);
  expect(missionManagerReservations(decodeExecution(emptyMissionExecution()))).toEqual([]);
});

it("round-trips a bounded manager reservation as execution state", () => {
  const reservation = decodeReservation(reservationFixture());
  const withReservation = decodeExecution({
    ...emptyMissionExecution(),
    managerReservations: [reservationFixture()],
  });
  expect(missionManagerReservations(withReservation)).toEqual([reservation]);
  expect(isEmptyMissionExecution(withReservation)).toBe(false);
  expect(encodeExecution(withReservation).managerReservations).toEqual([reservation]);
});

it("rejects manager reservations beyond the bound at decode", () => {
  expect(MAX_MANAGER_TRANSFER_RESERVATIONS).toBe(64);
  expect(() =>
    decodeExecution({
      ...emptyMissionExecution(),
      managerReservations: Array.from(
        { length: MAX_MANAGER_TRANSFER_RESERVATIONS + 1 },
        (_, i) => ({
          ...reservationFixture(),
          reservationId: `mgr-reserve-${String(i).padStart(32, "0")}`,
        }),
      ),
    }),
  ).toThrow();
});

it("rejects a reservation with a malformed artifact ref at decode", () => {
  expect(() =>
    decodeReservation({ ...reservationFixture(), artifactRef: "/tmp/artifact.json" }),
  ).toThrow();
  expect(() =>
    decodeReservation({ ...reservationFixture(), artifactSha256: "not-a-hash" }),
  ).toThrow();
});

it("round-trips a mission.manager-handoff-reserved event", () => {
  const event = decodeEvent({
    sequence: 3,
    eventId: "event-3",
    aggregateKind: "mission",
    aggregateId: "mission-1",
    occurredAt: OCCURRED_AT,
    commandId: "reserve-cmd-1",
    metadata: {},
    type: "mission.manager-handoff-reserved",
    payload: {
      mission: {
        ...missionFixture(),
        revision: 1,
        execution: { ...emptyMissionExecution(), managerReservations: [reservationFixture()] },
      },
      reservationId: "mgr-reserve-0123456789abcdef0123456789abcdef",
    },
  });
  expect(event.type).toBe("mission.manager-handoff-reserved");
  if (event.type === "mission.manager-handoff-reserved") {
    expect(event.payload.reservationId).toBe("mgr-reserve-0123456789abcdef0123456789abcdef");
    expect(event.payload.mission.revision).toBe(1);
  }
});

it("rejects malformed calendar days and mismatched handoff SHA bindings", () => {
  for (const localDate of ["2026-02-30", "2026-13-01", "0000-01-01"])
    expect(() => decodeReservation({ ...reservationFixture(), localDate })).toThrow();
  expect(() =>
    decodeReservation({ ...reservationFixture(), artifactSha256: "b".repeat(64) }),
  ).toThrow();
});
it("bounds reservation identities, counters, and configured timezone", () => {
  expect(() =>
    decodeReservation({ ...reservationFixture(), currentEpoch: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  expect(() =>
    decodeReservation({ ...reservationFixture(), reservationId: "x".repeat(513) }),
  ).toThrow();
  expect(() => decodeMission({ ...missionFixture(), projectTimezone: "x".repeat(129) })).toThrow();
});

const skillEvaluationFixture = (overrides: Record<string, unknown> = {}) => ({
  evaluationId: "eval-1",
  teamId: "team-1",
  environmentId: "env-1",
  missionId: "mission-1",
  candidateId: "candidate-1",
  targetSkillRef: "skills/my-skill",
  sourceReportHash: "d".repeat(64),
  normalizedReportHash: "e".repeat(64),
  oldSkillSha256: "a".repeat(64),
  newSkillSha256: "b".repeat(64),
  kind: "review_ready",
  reason: "ready_fix_verified",
  failurePairs: { required: 1, observed: 1, oldPass: 0, newPass: 1 },
  positivePairs: { required: 1, observed: 1, oldPass: 1, newPass: 1 },
  negativePairs: { required: 1, observed: 1, oldPass: 1, newPass: 1 },
  uncertainty: "observed_pairs_only",
  evidenceArtifactRef: `skill-replay-evidence:${"f".repeat(64)}`,
  evidenceArtifactSha: "f".repeat(64),
  reviewerRef: "reviewer-thread-1",
  recordedByThreadId: "thread-1",
  retroEpoch: 3,
  recordedAt: OCCURRED_AT,
  ...overrides,
});

it("decodes an omitted skill evaluation array as empty", () => {
  const decoded = decodeExecution({
    admissions: [],
    writerClaims: [],
    consumedExceptionIds: [],
  });
  expect(missionRetroSkillEvaluations(decoded)).toEqual([]);
  expect(isEmptyMissionExecution(decoded)).toBe(true);
  expect(missionRetroSkillEvaluations(decodeExecution(emptyMissionExecution()))).toEqual([]);
  expect(encodeExecution(emptyMissionExecution()).retroSkillEvaluations).toEqual([]);
});

it("round-trips a bounded skill evaluation receipt as execution state", () => {
  const receipt = decodeSkillEvaluation(skillEvaluationFixture());
  // Opaque provenance refs from either role decode without interpretation.
  const followUp = decodeSkillEvaluation(
    skillEvaluationFixture({
      evaluationId: "eval-2",
      reviewerRef: "retro-manager",
      recordedByThreadId: "successor-thread-9",
    }),
  );
  const withEvaluations = decodeExecution({
    ...emptyMissionExecution(),
    retroSkillEvaluations: [receipt, followUp],
  });
  expect(missionRetroSkillEvaluations(withEvaluations)).toHaveLength(2);
  expect(isEmptyMissionExecution(withEvaluations)).toBe(false);
  const roundTripped = decodeMission({
    ...missionFixture(),
    execution: encodeExecution(withEvaluations),
  });
  expect(missionRetroSkillEvaluations(roundTripped.execution!)).toHaveLength(2);
});

it("round-trips a no-change skill evaluation receipt", () => {
  const receipt = decodeSkillEvaluation(
    skillEvaluationFixture({
      evaluationId: "eval-nochange",
      oldSkillSha256: "a".repeat(64),
      newSkillSha256: "a".repeat(64),
      kind: "no_change",
      reason: "no_change_identical",
      failurePairs: { required: 1, observed: 1, oldPass: 1, newPass: 1 },
    }),
  );
  const withEvaluations = decodeExecution({
    ...emptyMissionExecution(),
    retroSkillEvaluations: [receipt],
  });
  expect(isEmptyMissionExecution(withEvaluations)).toBe(false);
  expect(encodeExecution(withEvaluations).retroSkillEvaluations).toHaveLength(1);
});

it("rejects skill evaluation receipts beyond the bound at decode", () => {
  expect(MAX_MISSION_RETRO_SKILL_EVALUATIONS).toBe(64);
  expect(() =>
    decodeExecution({
      ...emptyMissionExecution(),
      retroSkillEvaluations: Array.from(
        { length: MAX_MISSION_RETRO_SKILL_EVALUATIONS + 1 },
        (_, index) => ({ ...skillEvaluationFixture(), evaluationId: `eval-${index}` }),
      ),
    }),
  ).toThrow();
});

it("rejects implausible skill evaluation receipts at decode", () => {
  const cases: Array<Record<string, unknown>> = [
    { targetSkillRef: "/absolute/skill" },
    { targetSkillRef: "../escape" },
    { targetSkillRef: "skills/./same" },
    { targetSkillRef: "https://example.com/skill" },
    { targetSkillRef: "skill%20name" },
    { targetSkillRef: "x".repeat(257) },
    { oldSkillSha256: "not-a-hash" },
    { evidenceArtifactRef: `skill-replay-evidence:${"a".repeat(64)}` },
    { reviewerRef: "x".repeat(513) },
    { failurePairs: { required: 0, observed: 1, oldPass: 0, newPass: 1 } },
    { failurePairs: { required: 1, observed: 65, oldPass: 0, newPass: 1 } },
    { failurePairs: { required: 1, observed: 1, oldPass: 2, newPass: 1 } },
    { kind: "hold", reason: "ready_fix_verified" },
    { kind: "review_ready", reason: "hold_no_improvement" },
    { kind: "rejected", reason: "no_change_identical" },
    { kind: "no_change", reason: "rejected_regression" },
    {
      kind: "review_ready",
      reason: "ready_fix_verified",
      failurePairs: { required: 2, observed: 1, oldPass: 0, newPass: 1 },
    },
    {
      kind: "review_ready",
      reason: "ready_fix_verified",
      failurePairs: { required: 1, observed: 1, oldPass: 1, newPass: 1 },
    },
    {
      kind: "no_change",
      reason: "no_change_identical",
      oldSkillSha256: "b".repeat(64),
      newSkillSha256: "b".repeat(64),
    },
    {
      kind: "hold",
      reason: "hold_insufficient_samples",
      failurePairs: { required: 1, observed: 30, oldPass: 0, newPass: 0 },
      positivePairs: { required: 1, observed: 30, oldPass: 30, newPass: 30 },
      negativePairs: { required: 1, observed: 30, oldPass: 30, newPass: 30 },
    },
  ];
  for (const overrides of cases) {
    expect(
      () => decodeSkillEvaluation(skillEvaluationFixture(overrides)),
      JSON.stringify(overrides),
    ).toThrow();
  }
});
