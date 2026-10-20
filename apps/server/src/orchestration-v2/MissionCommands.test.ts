import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { CommandId, EventId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  MissionCreateCommand,
  MissionReplaceCommand,
} from "../../../../packages/contracts/src/mission.ts";
import { planMissionCommand, type MissionPlanContext } from "./MissionCommands.ts";

const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const OCCURRED_AT = "2026-10-14T00:00:00.000Z";

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

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeCreate = Schema.decodeUnknownSync(MissionCreateCommand);
const decodeReplace = Schema.decodeUnknownSync(MissionReplaceCommand);
const ctx: MissionPlanContext = {
  sequence: 7,
  eventId: EventId.make("event-7"),
  occurredAt: OCCURRED_AT,
};

const replace = (mission: unknown, overrides: Record<string, unknown> = {}) =>
  decodeReplace({
    type: "mission.replace",
    commandId: CommandId.make("cmd-2"),
    expectedRevision: 0,
    epoch: 3,
    authority: { ...AUTHORITY },
    mission,
    ...overrides,
  });

const ok = (result: ReturnType<typeof planMissionCommand>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};
const code = (result: ReturnType<typeof planMissionCommand>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.code : assert.fail("expected failure");
};

describe("planMissionCommand", () => {
  // Generic create starts root-owned state empty: no execution, no attempts.
  const createFixture = () => {
    const mission = missionFixture();
    return { ...mission, tasks: mission.tasks.map(({ attempt: _a, ...task }) => task) };
  };
  it("plans a create with a mission.created event", () => {
    const result = ok(
      planMissionCommand(
        decodeCreate({ type: "mission.create", commandId: "cmd-1", mission: createFixture() }),
        null,
        ctx,
      ),
    );
    assert.equal(result.event.type, "mission.created");
    assert.equal(result.event.aggregateId, "mission-1");
    assert.equal(result.event.sequence, 7);
  });

  it("rejects a create when the mission already exists", () => {
    const current = decodeMission(missionFixture());
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-1", mission: createFixture() }),
          current,
          ctx,
        ),
      ),
      "already_exists",
    );
  });

  it("rejects a create supplying task attempt refs", () => {
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-1", mission: missionFixture() }),
          null,
          ctx,
        ),
      ),
      "forged_admission_ref",
    );
  });

  it("rejects a create supplying nonempty execution state", () => {
    const mission = {
      ...createFixture(),
      execution: { admissions: [], writerClaims: [], consumedExceptionIds: ["ex-1"] },
    };
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-1", mission }),
          null,
          ctx,
        ),
      ),
      "forged_execution_state",
    );
  });

  it("plans a revise and splits preserved vs invalidated admissions", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const next = {
      ...base,
      revision: 1,
      tasks: [{ ...base.tasks[0]!, specHash: "hash-a2" }, base.tasks[1]!],
    };
    const result = ok(planMissionCommand(replace(next), current, ctx));
    assert.equal(result.event.type, "mission.revised");
    assert.deepEqual(result.invalidatedAdmissionRefs, ["receipt-a"]);
    assert.deepEqual(result.preservedAdmissionRefs, ["receipt-b"]);
    // Invalidated pointer is removed from the committed aggregate; preserved stays.
    assert.equal(result.mission.tasks[0]?.attempt, undefined);
    assert.equal(result.mission.tasks[1]?.attempt?.receiptRef, "receipt-b");
    if (result.event.type === "mission.revised")
      assert.equal(result.event.payload.mission.tasks[0]?.attempt, undefined);
  });

  it("invalidates admissions for removed tasks", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const result = ok(
      planMissionCommand(replace({ ...base, revision: 1, tasks: [base.tasks[0]!] }), current, ctx),
    );
    assert.deepEqual(result.invalidatedAdmissionRefs, ["receipt-b"]);
    assert.deepEqual(result.preservedAdmissionRefs, ["receipt-a"]);
  });

  it("rejects a stale expected revision", () => {
    const current = decodeMission(missionFixture());
    assert.equal(
      code(
        planMissionCommand(
          replace({ ...missionFixture(), revision: 6 }, { expectedRevision: 5 }),
          current,
          ctx,
        ),
      ),
      "stale_revision",
    );
  });

  it("rejects a command epoch behind the current manager epoch", () => {
    const current = decodeMission(missionFixture());
    assert.equal(
      code(
        planMissionCommand(
          replace({ ...missionFixture(), revision: 1 }, { epoch: 2 }),
          current,
          ctx,
        ),
      ),
      "epoch_mismatch",
    );
  });

  it("rejects an authority outside the recorded provenance", () => {
    const current = decodeMission(missionFixture());
    assert.equal(
      code(
        planMissionCommand(
          replace(
            { ...missionFixture(), revision: 1 },
            { authority: { source: "stranger", ref: "nope" } },
          ),
          current,
          ctx,
        ),
      ),
      "authority_mismatch",
    );
  });

  it("rejects identity changes on replacement", () => {
    const current = decodeMission(missionFixture());
    assert.equal(
      code(
        planMissionCommand(
          replace({ ...missionFixture(), revision: 1, teamId: "team-2" }),
          current,
          ctx,
        ),
      ),
      "immutable_identity",
    );
  });

  it("rejects unknown task dependencies", () => {
    const base = missionFixture();
    const result = planMissionCommand(
      decodeCreate({
        type: "mission.create",
        commandId: "cmd-8",
        mission: {
          ...base,
          tasks: [
            {
              id: "task-x",
              projectId: "project-1",
              title: "Orphan",
              specHash: "hash-x",
              dependencyHashes: ["hash-ghost"],
              dependencies: ["task-ghost"],
              acceptanceIds: ["ac-1"],
              updatedAt: OCCURRED_AT,
            },
          ],
        },
      }),
      null,
      ctx,
    );
    assert.equal(code(result), "unknown_dependency");
  });

  it("rejects dependency cycles", () => {
    const base = missionFixture();
    const tasks = [
      {
        id: "task-a",
        projectId: "project-1",
        title: "A",
        specHash: "hash-a",
        dependencyHashes: ["hash-b"],
        dependencies: ["task-b"],
        acceptanceIds: ["ac-1"],
        updatedAt: OCCURRED_AT,
      },
      {
        id: "task-b",
        projectId: "project-1",
        title: "B",
        specHash: "hash-b",
        dependencyHashes: ["hash-a"],
        dependencies: ["task-a"],
        acceptanceIds: ["ac-1"],
        updatedAt: OCCURRED_AT,
      },
    ];
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-9", mission: { ...base, tasks } }),
          null,
          ctx,
        ),
      ),
      "dependency_cycle",
    );
  });

  it("rejects duplicate task ids", () => {
    const base = createFixture();
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({
            type: "mission.create",
            commandId: "cmd-10",
            mission: { ...base, tasks: [base.tasks[0]!, base.tasks[0]!] },
          }),
          null,
          ctx,
        ),
      ),
      "duplicate_task_ids",
    );
  });

  it("invalidates admission references when canonical admission authority changes without a spec hash change", () => {
    for (const change of [
      { writerScope: "/workspace/reassigned" },
      { sharedManifestScopes: ["/workspace/package.json"] },
      { guiScopes: ["/workspace/gui"] },
      { taskNecessary: false },
    ]) {
      const base = missionFixture();
      const current = decodeMission({
        ...base,
        tasks: base.tasks.map((task) => ({
          ...task,
          writerScope: "/workspace/assigned",
          sharedManifestScopes: [],
          guiScopes: [],
          taskNecessary: true,
        })),
      });
      const next = {
        ...current,
        revision: 1,
        tasks: current.tasks.map((task, index) => (index === 0 ? { ...task, ...change } : task)),
      };
      const result = ok(planMissionCommand(replace(next), current, ctx));
      assert.deepEqual(result.invalidatedAdmissionRefs, ["receipt-a"]);
      assert.deepEqual(result.preservedAdmissionRefs, ["receipt-b"]);
      assert.equal(result.mission.tasks[0]?.attempt, undefined);
    }
  });

  it("invalidates on dependency-hash-only change while specHash stays (root regression)", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const next = {
      ...base,
      revision: 1,
      tasks: [base.tasks[0]!, { ...base.tasks[1]!, dependencyHashes: ["changed-input"] }],
    };
    const result = ok(planMissionCommand(replace(next), current, ctx));
    assert.deepEqual(result.invalidatedAdmissionRefs, ["receipt-b"]);
    assert.deepEqual(result.preservedAdmissionRefs, ["receipt-a"]);
    assert.equal(result.mission.tasks[1]?.attempt, undefined);
  });

  it("invalidates on dependency-id and acceptance-content changes", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const byGraph = ok(
      planMissionCommand(
        replace({
          ...base,
          revision: 1,
          tasks: [
            { ...base.tasks[0]! },
            { ...base.tasks[1]!, dependencies: [], dependencyHashes: [] },
          ],
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(byGraph.invalidatedAdmissionRefs, ["receipt-b"]);
    const byAcceptance = ok(
      planMissionCommand(
        replace({
          ...base,
          revision: 1,
          intent: {
            ...base.intent,
            acceptanceCriteria: [{ id: "ac-1", text: "Changed criterion." }],
          },
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual([...byAcceptance.invalidatedAdmissionRefs].sort(), ["receipt-a", "receipt-b"]);
    const byLink = ok(
      planMissionCommand(
        replace({
          ...base,
          revision: 1,
          tasks: [{ ...base.tasks[0]!, acceptanceIds: [] }, base.tasks[1]!],
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(byLink.invalidatedAdmissionRefs, ["receipt-a"]);
  });

  it("preserves admissions on unrelated intent outcome edits and restores canonical refs", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    // User replacement omits attempts entirely; canonical preserved refs return.
    const tasks = base.tasks.map(({ attempt: _a, ...t }) => t);
    const result = ok(
      planMissionCommand(
        replace({
          ...base,
          revision: 1,
          intent: { ...base.intent, outcome: "Reworded outcome." },
          tasks,
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(result.invalidatedAdmissionRefs, []);
    assert.deepEqual([...result.preservedAdmissionRefs].sort(), ["receipt-a", "receipt-b"]);
    assert.equal(result.mission.tasks[0]?.attempt?.receiptRef, "receipt-a");
  });

  it("rejects forged admission refs in a user replacement", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const forged = {
      ...base,
      revision: 1,
      tasks: [
        base.tasks[0]!,
        { ...base.tasks[1]!, attempt: { attemptNumber: 9, receiptRef: "receipt-forged" } },
      ],
    };
    assert.equal(code(planMissionCommand(replace(forged), current, ctx)), "forged_admission_ref");
  });

  it("preserves canonical execution when a replacement drops or overwrites it", () => {
    const execution = { admissions: [], writerClaims: [], consumedExceptionIds: ["ex-1"] };
    const current = decodeMission({ ...missionFixture(), execution });
    const dropped = ok(
      planMissionCommand(replace({ ...missionFixture(), revision: 1 }), current, ctx),
    );
    assert.deepEqual(dropped.mission.execution, execution);
    const overwritten = ok(
      planMissionCommand(
        replace({
          ...missionFixture(),
          revision: 1,
          execution: { admissions: [], writerClaims: [], consumedExceptionIds: [] },
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(overwritten.mission.execution, execution);
    if (overwritten.event.type === "mission.revised")
      assert.deepEqual(overwritten.event.payload.mission.execution, execution);
  });

  it("preserves execution across spec edits that invalidate planning refs", () => {
    const execution = { admissions: [], writerClaims: [], consumedExceptionIds: ["ex-1"] };
    const current = decodeMission({ ...missionFixture(), execution });
    const base = missionFixture();
    const result = ok(
      planMissionCommand(
        replace({
          ...base,
          revision: 1,
          tasks: [base.tasks[0]!, { ...base.tasks[1]!, dependencyHashes: ["changed-input"] }],
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(result.invalidatedAdmissionRefs, ["receipt-b"]);
    assert.deepEqual(result.mission.execution, execution);
  });

  it("accepts two repository bindings and rejects a task routed to an unbound project", () => {
    const created = ok(
      planMissionCommand(
        decodeCreate({ type: "mission.create", commandId: "cmd-11", mission: createFixture() }),
        null,
        ctx,
      ),
    );
    assert.equal(created.mission.bindings.length, 2);
    const base = createFixture();
    const wrong = {
      ...base,
      tasks: [{ ...base.tasks[0]!, projectId: "project-404" }, base.tasks[1]!],
    };
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-12", mission: wrong }),
          null,
          ctx,
        ),
      ),
      "unknown_task_project",
    );
    const dup = {
      ...base,
      bindings: [base.bindings[0]!, { ...base.bindings[1]!, projectId: "project-1" }],
    };
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({ type: "mission.create", commandId: "cmd-13", mission: dup }),
          null,
          ctx,
        ),
      ),
      "duplicate_binding",
    );
  });

  it("grants an unassigned retro role through a current delivery CAS revision", () => {
    const base = missionFixture();
    const next = {
      ...base,
      revision: 1,
      managers: { ...base.managers, retro: { threadId: "retro-1", epoch: 1 } },
    };
    const planned = ok(planMissionCommand(replace(next), decodeMission(base), ctx));
    assert.equal(planned.mission.managers.retro?.threadId, "retro-1");
    assert.equal(planned.mission.managers.retro?.epoch, 1);
  });

  it("denies partial grants, role removal, owner replacement and epoch jumps", () => {
    const base = missionFixture();
    for (const retro of [
      { threadId: "retro-1" },
      { epoch: 1 },
      { threadId: "retro-1", epoch: 9 },
    ]) {
      assert.equal(
        code(
          planMissionCommand(
            replace({ ...base, revision: 1, managers: { ...base.managers, retro } }),
            decodeMission(base),
            ctx,
          ),
        ),
        "manager_assignment_immutable",
      );
    }
    const assigned = decodeMission({
      ...base,
      managers: { ...base.managers, retro: { threadId: "retro-1", epoch: 1 } },
    });
    for (const retro of [
      undefined,
      { threadId: "retro-2", epoch: 2 },
      { threadId: "retro-1", epoch: 2 },
    ]) {
      assert.equal(
        code(
          planMissionCommand(
            replace({
              ...base,
              revision: 1,
              managers: { ...base.managers, ...(retro ? { retro } : {}) },
            }),
            assigned,
            ctx,
          ),
        ),
        "manager_assignment_immutable",
      );
    }
  });

  it("rejects role grants from stale revisions, stale delivery epochs and foreign authority", () => {
    const base = missionFixture();
    const next = {
      ...base,
      revision: 1,
      managers: { ...base.managers, retro: { threadId: "retro-1", epoch: 1 } },
    };
    for (const [override, expected] of [
      [{ expectedRevision: 9 }, "stale_revision"],
      [{ epoch: 2 }, "epoch_mismatch"],
      [{ authority: { source: "stranger", ref: "nope" } }, "authority_mismatch"],
    ] as const) {
      assert.equal(
        code(planMissionCommand(replace(next, override), decodeMission(base), ctx)),
        expected,
      );
    }
  });

  it("denies generic role-owner replacement and stale manager epoch", () => {
    const current = decodeMission(missionFixture());
    const base = missionFixture();
    const roleChange = {
      ...base,
      revision: 1,
      managers: { delivery: { threadId: "thread-2", epoch: 3 } },
    };
    assert.equal(
      code(planMissionCommand(replace(roleChange), current, ctx)),
      "manager_assignment_immutable",
    );
    assert.equal(
      code(planMissionCommand(replace({ ...base, revision: 1 }, { epoch: 99 }), current, ctx)),
      "epoch_mismatch",
    );
  });

  it("blocks managed revisions when the current mission has no known delivery manager", () => {
    const base = missionFixture();
    const unmanaged = decodeMission({ ...base, managers: {} });
    assert.equal(
      code(planMissionCommand(replace({ ...base, revision: 1, managers: {} }), unmanaged, ctx)),
      "missing_manager",
    );
  });
});

describe("canonical manager reservation preservation", () => {
  const reservation = {
    reservationId: "reserve-1",
    successorThreadId: "successor-1",
    role: "delivery",
    currentThreadId: "thread-1",
    currentEpoch: 3,
    observedRevision: 0,
    timezone: "America/Denver",
    localDate: "2026-10-14",
    ordinal: 0,
    reason: "first_slot",
    artifactRef: `manager-handoff:${"a".repeat(64)}`,
    artifactSha256: "a".repeat(64),
    commandId: "reserve-cmd",
    requestDigest: "b".repeat(64),
    reservedAt: OCCURRED_AT,
  };
  const execution = {
    admissions: [],
    writerClaims: [],
    consumedExceptionIds: [],
    managerReservations: [reservation],
  };
  it("denies generic create with forged reservation state", () => {
    const fixture = missionFixture();
    const proposed = {
      ...fixture,
      tasks: fixture.tasks.map(({ attempt: _attempt, ...task }) => task),
      execution,
    };
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({
            type: "mission.create",
            commandId: "forge-reservation",
            mission: proposed,
          }),
          null,
          ctx,
        ),
      ),
      "forged_execution_state",
    );
  });
  it("preserves canonical reservations against replacement omission", () => {
    const current = decodeMission({ ...missionFixture(), execution });
    const revised = ok(
      planMissionCommand(replace({ ...missionFixture(), revision: 1 }), current, ctx),
    );
    assert.deepEqual(revised.mission.execution, current.execution);
  });
  it("preserves the configured timezone when an older replacement omits it", () => {
    const current = decodeMission({ ...missionFixture(), projectTimezone: "America/Denver" });
    const revised = ok(
      planMissionCommand(replace({ ...missionFixture(), revision: 1 }), current, ctx),
    );
    assert.equal(revised.mission.projectTimezone, "America/Denver");
  });
});

describe("canonical skill evaluation preservation", () => {
  const skillEvaluation = {
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
  };
  const execution = {
    admissions: [],
    writerClaims: [],
    consumedExceptionIds: [],
    retroSkillEvaluations: [skillEvaluation],
  };
  it("denies generic create with forged skill evaluation state", () => {
    const fixture = missionFixture();
    const proposed = {
      ...fixture,
      tasks: fixture.tasks.map(({ attempt: _attempt, ...task }) => task),
      execution,
    };
    assert.equal(
      code(
        planMissionCommand(
          decodeCreate({
            type: "mission.create",
            commandId: "forge-skill-eval",
            mission: proposed,
          }),
          null,
          ctx,
        ),
      ),
      "forged_execution_state",
    );
  });
  it("preserves canonical skill evaluations against replacement omission or overwrite", () => {
    const current = decodeMission({ ...missionFixture(), execution });
    const dropped = ok(
      planMissionCommand(replace({ ...missionFixture(), revision: 1 }), current, ctx),
    );
    assert.deepEqual(dropped.mission.execution, current.execution);
    const emptied = ok(
      planMissionCommand(
        replace({
          ...missionFixture(),
          revision: 1,
          execution: { admissions: [], writerClaims: [], consumedExceptionIds: [] },
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(emptied.mission.execution, current.execution);
    const forged = ok(
      planMissionCommand(
        replace({
          ...missionFixture(),
          revision: 1,
          execution: {
            admissions: [],
            writerClaims: [],
            consumedExceptionIds: [],
            retroSkillEvaluations: [],
          },
        }),
        current,
        ctx,
      ),
    );
    assert.deepEqual(forged.mission.execution, current.execution);
  });
});
