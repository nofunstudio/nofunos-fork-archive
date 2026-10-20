import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AdmissionStore from "./MissionAdmissionStore.ts";
import * as Missions from "./MissionService.ts";
import * as MissionResultStore from "./MissionResultStore.ts";
import type { MissionAdmissionRequest } from "./MissionAdmission.ts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviders from "../sourceControl/SourceControlProviderRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TurnStartTestkit from "./ProviderTurnStartService.testkit.ts";

import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
const authority = {
  teamId: TeamId.make("team-admission"),
  environmentId: EnvironmentId.make("environment-admission"),
  controllerThreadId: ThreadId.make("delivery-admission"),
};
const mission = Schema.decodeUnknownSync(Mission)({
  schemaVersion: 1,
  id: "J01-offline-admission-prerequisite",
  revision: 0,
  teamId: authority.teamId,
  authorityEnvironmentId: authority.environmentId,
  bindings: [
    {
      projectId: "project-admission",
      workspaceRoot: "/workspace/project",
      baseCommit: "base",
      ancestry: ["base"],
    },
  ],
  intent: {
    outcome: "Admit only canonical work",
    scope: ["admission"],
    exclusions: [],
    authorityRefs: [{ source: "owner", ref: "admission-test" }],
    acceptanceCriteria: [{ id: "acceptance-admission", text: "Fail closed" }],
    decisions: [],
  },
  integrationTarget: { summary: "Admission tests" },
  managers: { delivery: { threadId: authority.controllerThreadId, epoch: 1 } },
  status: "active",
  tasks: [
    {
      id: "task-admission",
      projectId: "project-admission",
      title: "Admission",
      specHash: "spec-hash",
      dependencyHashes: [],
      dependencies: [],
      acceptanceIds: ["acceptance-admission"],
      writerScope: "/workspace/project/src/admission",
      sharedManifestScopes: [],
      guiScopes: [],
      taskNecessary: true,
      updatedAt: "2026-10-19T07:30:00.000Z",
    },
  ],
  updatedAt: "2026-10-19T07:30:00.000Z",
});

/**
 * J01 gates are not satisfied by a synthetic facts port or an ordinary child.
 * This executable prerequisite checks the production composition through the
 * public service; the two remaining gates stay explicitly pending B-02d.
 * No provider starts and no live T3 state is opened.
 */
it.effect(
  "J01 gate 1 prerequisite: production mission entry refuses without child or admission",
  () => {
    const instanceId = ProviderInstanceId.make("offline-admission");
    const selection = { instanceId, model: "gpt-6.1-sol" };
    const driver = ProviderDriverKind.make("codex");
    const adapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("No provider process is permitted"),
    } as ProviderAdapterV2Shape;
    const instance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "offline:admission" },
      displayName: "Offline admission",
      enabled: true,
      snapshot: { getSnapshot: Effect.succeed({}) } as ProviderInstance["snapshot"],
      orchestrationAdapter: adapter,
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
    const runtimeServices = Layer.mergeAll(
      RuntimeLayer.layer,
      Missions.layer.pipe(Layer.provide(RuntimeLayer.layerEventInfrastructure)),
    );
    const mcpDependencies = Layer.mergeAll(
      runtimeServices,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      ProviderRegistryMock.layer(),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ).pipe(Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})));
    const runtime = Layer.mergeAll(
      runtimeServices,
      OrchestratorMcpService.layer.pipe(Layer.provide(mcpDependencies)),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
          ProviderRegistryMock.layer(),
          McpSessionRegistryTestkit.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          Layer.mock(TextGeneration.TextGeneration)({}),
          Layer.mock(SourceControlProviders.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("No source-control link is used by admission tests"),
          }),
          TurnStartTestkit.layer,
          ServerSettings.layerTest(),
          // Park background workers; this proves durable dispatch, never a live provider start.
          Layer.succeed(ServerActivation, Effect.never),
        ),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "b04-j01-runtime-" })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const missions = yield* Missions.MissionService;
      const created = yield* missions.execute({
        type: "mission.create",
        commandId: CommandId.make("J01-offline-create"),
        mission,
      });
      expect(created.committed).toBe(true);
      const canonical = Option.getOrThrow(yield* missions.get(mission.id));
      expect(canonical.tasks[0]?.writerScope).toBe("/workspace/project/src/admission");
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("J01-offline-parent-create"),
        threadId: authority.controllerThreadId,
        projectId: ProjectId.make("project-admission"),
        title: "J01 offline prerequisite",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace/project",
        createdBy: "user",
        creationSource: "web",
      });
      expect(Option.isSome(yield* Effect.serviceOption(AdmissionStore.MissionAdmissionStore))).toBe(
        true,
      );
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT sequence FROM orchestration_events`;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = {
        task: "Read the evidence inventory and return a bounded summary.",
        mission: {
          missionId: mission.id,
          taskId: "task-admission",
          attemptKey: { attemptNumber: 1, operation: "read" as const },
        },
        workspace: { strategy: "worktree" as const },
        clientRequestId: "J01-offline-denied",
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = yield* mcp
          .delegateTask(
            {
              environmentId: authority.environmentId,
              capabilities: new Set(["orchestration", "worktree"]),
              requestNamespace: "J01-offline",
              issuedAt: 0,
              thread: {
                threadId: authority.controllerThreadId,
                providerSessionId: "J01-offline-session",
                providerInstanceId: instanceId,
              },
              client: undefined,
            },
            input,
          )
          .pipe(Effect.flip);
        expect(refused.code).toBe("orchestration_error");
        expect(refused.message).toContain("not configured");
      }
      expect((yield* threads.getThreadProjection(authority.controllerThreadId)).subagents).toEqual(
        [],
      );
      const after = Option.getOrThrow(yield* missions.get(mission.id));
      expect(after).toEqual(canonical);
      expect(after.execution?.admissions ?? []).toEqual([]);
      expect(yield* sql`SELECT sequence FROM orchestration_events`).toEqual(before);
    }).pipe(
      Effect.provide(
        runtime.pipe(Layer.provide(Layer.succeed(Missions.MissionAuthority, authority))),
      ),
    );
  },
);

/**
 * J01 gate 2: accept and integrate one admitted public child result once
 * through the public MCP result actions. The admitted child itself is
 * constructed from the stores' public APIs (MissionService create,
 * MissionAdmissionStore reserve, MissionResultStore initialize/observe/
 * review) with test facts ports, following the MissionResultStore.test.ts
 * harness pattern: no SQL seeding, no ThreadManagementService, and no
 * runtime admission composition (BK1 wires the production facts ports and
 * the delegate_task mission branch in parallel; this test notes that
 * handoff where it relies on it).
 */
it.effect(
  "J01 gate 2: associate, accept and integrate an admitted public child result once",
  () => {
    const NOW_MS = Date.parse("2026-10-19T08:00:00.000Z");
    const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
    const BASE_COMMIT = "b2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
    const COMMIT_A = "commit:aaa";
    const COMMIT_B = "commit:bbb";
    const RESULT_REVISION = 3;
    const authority = {
      teamId: TeamId.make("team-j01-g2"),
      environmentId: EnvironmentId.make("environment-j01-g2"),
      controllerThreadId: ThreadId.make("delivery-j01-g2"),
    };
    const missionId = "J01-gate-2-result-accept";
    const taskId = "task-result-accept";
    const mission = Schema.decodeUnknownSync(Mission)({
      schemaVersion: 1,
      id: missionId,
      revision: 0,
      teamId: authority.teamId,
      authorityEnvironmentId: authority.environmentId,
      bindings: [
        {
          projectId: "project-j01-g2",
          workspaceRoot: "/workspace/project",
          baseCommit: BASE_COMMIT,
          ancestry: [BASE_COMMIT],
        },
      ],
      intent: {
        outcome: "Accept one canonical result",
        scope: ["results"],
        exclusions: [],
        authorityRefs: [{ source: "owner", ref: "gate-2-test" }],
        acceptanceCriteria: [{ id: "acceptance-g2", text: "Accept and integrate once" }],
        decisions: [],
      },
      integrationTarget: { summary: "Gate 2 tests" },
      managers: { delivery: { threadId: authority.controllerThreadId, epoch: 1 } },
      status: "active",
      tasks: [
        {
          id: taskId,
          projectId: "project-j01-g2",
          title: "Result",
          specHash: "hash-1",
          dependencyHashes: [],
          dependencies: [],
          acceptanceIds: ["acceptance-g2"],
          writerScope: "/workspace/project/src/results",
          sharedManifestScopes: [],
          guiScopes: [],
          taskNecessary: true,
          updatedAt: iso(NOW_MS - 3_600_000),
        },
      ],
      updatedAt: iso(NOW_MS - 3_600_000),
    });

    const admissionFacts = (): AdmissionStore.MissionAdmissionTrustedFacts => ({
      taskNecessary: true,
      nowMs: NOW_MS,
      teamId: "team-j01-g2",
      environmentId: "environment-j01-g2",
      deliveryThreadId: "delivery-j01-g2",
      deliveryEpoch: 1,
      account: {
        accountId: "acct-1",
        providerInstanceId: "codex_personal",
        billingMode: "subscription",
        company: "No Fun",
        verifiedAtMs: NOW_MS - 1_000,
      },
      route: {
        accountId: "acct-1",
        providerInstanceId: "codex_personal",
        billingMode: "subscription",
        modelId: "model-a",
        profile: "muse-focused high",
        capability: "writer",
        supportedModelIds: ["model-a", "model-b"],
      },
      usageLimits: {
        checkedAt: iso(NOW_MS - 60_000),
        windows: [
          { id: "five_hour", kind: "session", label: "5h", usedPercent: 50 },
          { id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 },
        ],
      },
      usageMaxObservationAgeMs: 30 * 60_000,
      host: {
        hostId: "test-host",
        bootId: "test-boot",
        ready: true,
        buildObserved: true,
        buildOk: true,
        toolchainObserved: true,
        toolchainOk: true,
        pressureObserved: true,
        pressureAcceptable: true,
        observedAtMs: NOW_MS - 5_000,
      },
      repository: {
        projectId: "project-j01-g2",
        workspaceRootRealpath: "/workspace/project",
        observedAncestry: [BASE_COMMIT],
        observedAtMs: NOW_MS - 5_000,
      },
      writerScope: "/workspace/project/src/results",
      sharedManifestScopes: [],
      guiScopes: [],
      dependencyReceipts: [],
    });

    const admissionRequest = (proposed: Mission): MissionAdmissionRequest => ({
      mission: proposed,
      taskId,
      specHash: "hash-1",
      dependencyHashes: [],
      attempt: { attemptNumber: 1, operation: "write" },
      proposedAccountId: "acct-1",
      proposedProviderInstanceId: "codex_personal",
      proposedBillingMode: "subscription",
      modelId: "model-a",
      profile: "muse-focused high",
      promptHash: "prompt-1",
      optionsHash: "options-1",
      workspaceRoot: "/workspace/project",
      privilege: "writer",
      rejectedRoutes: [],
    });

    type ResultAssociation = MissionResultStore.MissionResultTrustedAssociation;
    const resultState: { facts: MissionResultStore.MissionResultTrustedFacts } = {
      facts: {
        teamId: "team-j01-g2",
        environmentId: "environment-j01-g2",
        deliveryThreadId: "delivery-j01-g2",
        deliveryEpoch: 1,
        nowMs: NOW_MS,
        association: {
          childTaskId: "child-task-1",
          childThreadId: "child-thread-1",
          childRunId: "run-1",
          requiredAncestry: [BASE_COMMIT],
          initialCommitSet: [COMMIT_A, COMMIT_B],
          initialAncestry: [BASE_COMMIT, COMMIT_A, COMMIT_B],
          source: "subagent-run",
          sourceRef: "run-1",
          initialResultRevision: RESULT_REVISION,
          digests: { inputDigest: "unset", dependencyDigest: "unset", acceptanceDigest: "unset" },
          admissionDispatchKey: "unset",
          admissionRequestDigest: "unset",
          attemptNumber: 1,
          pendingChildRuns: false,
        },
      },
    };

    const instanceId = ProviderInstanceId.make("offline-gate-2");
    const driver = ProviderDriverKind.make("codex");
    const adapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("No provider process is permitted"),
    } as ProviderAdapterV2Shape;
    const instance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "offline:gate-2" },
      displayName: "Offline gate 2",
      enabled: true,
      snapshot: { getSnapshot: Effect.succeed({}) } as ProviderInstance["snapshot"],
      orchestrationAdapter: adapter,
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
    // Result binding under test: the result store's public API with a test
    // facts port. Production wires the trusted runtime facts ports (BK1);
    // the service methods stay fail-closed until those layers exist. The
    // admission store is deliberately NOT merged here: RuntimeLayer already
    // provides a production-wired instance whose facts port denies every
    // attempt, so the test-local stub-wired layer is provided around just
    // the reserve calls below, where it shadows production.
    // MissionAuthority is provided leaf-by-leaf (never globally): the
    // RuntimeLayer admission provision is built from serviceOption, so it
    // stays Layer.empty here and the stub-wired store below is the only
    // admission instance. Production wires the trusted facts ports (BK1).
    const withAuthority = Layer.succeed(Missions.MissionAuthority, authority);
    const runtimeServices = Layer.mergeAll(
      RuntimeLayer.layer,
      Missions.layer.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
        Layer.provide(withAuthority),
      ),
      AdmissionStore.layer.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
        Layer.provide(
          Layer.succeed(AdmissionStore.MissionAdmissionFactsPort, {
            readFacts: () => Effect.succeed(admissionFacts()),
          }),
        ),
        Layer.provide(withAuthority),
      ),
      MissionResultStore.layer.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
        Layer.provide(
          Layer.succeed(MissionResultStore.MissionResultFactsPort, {
            readFacts: () => Effect.succeed(resultState.facts),
          }),
        ),
        Layer.provide(withAuthority),
      ),
    );
    const mcpDependencies = Layer.mergeAll(
      runtimeServices,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      ProviderRegistryMock.layer(),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ).pipe(Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})));
    const runtime = Layer.mergeAll(
      runtimeServices,
      OrchestratorMcpService.layer.pipe(Layer.provide(mcpDependencies)),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
          // No ProviderRegistry here: the admission store must see
          // providers=None so the stub facts port flows through untouched
          // (same harness as MissionAdmissionStore.test.ts). Providing even
          // an empty registry would enable the store's live-capacity branch,
          // which stamps TestClock observations that invalidate the
          // fixed-clock stub facts and clobbers the stub usage limits. The
          // MCP layer keeps its own mock via mcpDependencies above.
          McpSessionRegistryTestkit.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          Layer.mock(TextGeneration.TextGeneration)({}),
          Layer.mock(SourceControlProviders.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("No source-control link is used by gate-2 tests"),
          }),
          TurnStartTestkit.layer,
          ServerSettings.layerTest(),
          Layer.succeed(ServerActivation, Effect.never),
        ),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "b04-j01-g2-runtime-" })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );

    const scope: McpInvocationScope = {
      environmentId: authority.environmentId,
      capabilities: new Set(["orchestration"]),
      requestNamespace: "J01-gate-2",
      issuedAt: 0,
      thread: {
        threadId: authority.controllerThreadId,
        providerSessionId: "J01-gate-2-session",
        providerInstanceId: instanceId,
      },
      client: undefined,
    };
    const selector = {
      kind: "task-result" as const,
      missionId,
      taskId,
      attemptNumber: 1,
      resultRevision: RESULT_REVISION,
    };
    const decisionReceipt = (
      kind: "review" | "acceptance" | "integration",
      evidenceKind: "test_report" | "check_pass" | "git_integration",
    ) => ({
      kind,
      revision: RESULT_REVISION,
      commitSet: [COMMIT_A, COMMIT_B],
      evidenceKind,
      evidenceRef: `evidence:${kind}`,
      decidedBy: authority.controllerThreadId,
      decidedAt: iso(NOW_MS),
    });

    return Effect.gen(function* () {
      const missions = yield* Missions.MissionService;
      yield* missions.execute({
        type: "mission.create",
        commandId: CommandId.make("J01-g2-create"),
        mission,
      });
      // Associate: reserve the canonical admission through the store's
      // public API. The first reservation authorizes exactly one dispatch.
      const admissions = yield* AdmissionStore.MissionAdmissionStore;
      const reserved = yield* admissions.reserve(admissionRequest(mission));
      if (!Result.isSuccess(reserved)) {
        return assert.fail(
          `admission must succeed: ${reserved.failure.code} ${reserved.failure.message}`,
        );
      }
      expect(reserved.success.dispatchAuthorized).toBe(true);
      expect(reserved.success.recovered).toBe(false);
      const canonical = Option.getOrThrow(yield* missions.get(MissionId.make(missionId)));
      const association: ResultAssociation = {
        ...resultState.facts.association,
        digests: MissionResultStore.canonicalResultDigests(canonical, taskId)!,
        admissionDispatchKey: reserved.success.receipt.dispatchKey,
        admissionRequestDigest: reserved.success.receipt.requestDigest,
      };
      resultState.facts = { ...resultState.facts, association };
      const revisionAfterReserve = Option.getOrThrow(
        yield* missions.get(MissionId.make(missionId)),
      ).revision;

      // Seed the delivered result through the store's public API: initialize
      // from the trusted association, observe the authoritative server
      // observation, and review the manager's decision receipt.
      const results = yield* MissionResultStore.MissionResultStore;
      const base = {
        missionId,
        expectedRevision: revisionAfterReserve,
        deliveryEpoch: 1,
        taskId,
        dispatchKey: association.admissionDispatchKey,
        summaryText: "Worker finished the task.",
        outcome: "completed" as const,
      };
      const initialized = yield* results.execute({
        ...base,
        commandId: CommandId.make("J01-g2-initialize"),
        action: "initialize",
      });
      assert.isTrue(Result.isSuccess(initialized));
      resultState.facts = {
        ...resultState.facts,
        observation: {
          childTaskId: association.childTaskId,
          childThreadId: association.childThreadId,
          childRunId: association.childRunId,
          resultRevision: RESULT_REVISION,
          pendingChildRuns: false,
          stage: "observed",
        },
      };
      const revisionAfterInit = Option.getOrThrow(
        yield* missions.get(MissionId.make(missionId)),
      ).revision;
      const observed = yield* results.execute({
        ...base,
        commandId: CommandId.make("J01-g2-observe"),
        action: "observe",
        expectedRevision: revisionAfterInit,
        summaryText: undefined,
        outcome: undefined,
      });
      assert.isTrue(Result.isSuccess(observed));
      const revisionAfterObserve = Option.getOrThrow(
        yield* missions.get(MissionId.make(missionId)),
      ).revision;
      const reviewed = yield* results.execute({
        ...base,
        commandId: CommandId.make("J01-g2-review"),
        action: "review",
        expectedRevision: revisionAfterObserve,
        summaryText: undefined,
        outcome: undefined,
        receipt: decisionReceipt("review", "test_report"),
      });
      assert.isTrue(Result.isSuccess(reviewed));
      const revisionBeforeAccept = Option.getOrThrow(
        yield* missions.get(MissionId.make(missionId)),
      ).revision;

      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      // Public accept: reviewed -> accepted with exactly one revision bump.
      const accepted = yield* mcp.acceptMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept,
        receipt: decisionReceipt("acceptance", "check_pass"),
        clientRequestId: "J01-g2-accept",
      });
      expect(accepted.state).toBe("accepted");
      expect(accepted.committed).toBe(true);
      expect(accepted.recovered).toBe(false);
      expect(accepted.missionRevision).toBe(revisionBeforeAccept + 1);
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 1,
      );
      // Replay with the same clientRequestId recovers without a new revision.
      const acceptedReplay = yield* mcp.acceptMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept,
        receipt: decisionReceipt("acceptance", "check_pass"),
        clientRequestId: "J01-g2-accept",
      });
      expect(acceptedReplay.committed).toBe(false);
      expect(acceptedReplay.recovered).toBe(true);
      expect(acceptedReplay.resultSequence).toBe(accepted.resultSequence);
      expect(acceptedReplay.missionRevision).toBe(revisionBeforeAccept + 1);
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 1,
      );

      // Public integrate: accepted -> integrated with exactly one more bump.
      const integrated = yield* mcp.integrateMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept + 1,
        receipt: decisionReceipt("integration", "git_integration"),
        clientRequestId: "J01-g2-integrate",
      });
      expect(integrated.state).toBe("integrated");
      expect(integrated.committed).toBe(true);
      expect(integrated.missionRevision).toBe(revisionBeforeAccept + 2);
      const integratedReplay = yield* mcp.integrateMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept + 1,
        receipt: decisionReceipt("integration", "git_integration"),
        clientRequestId: "J01-g2-integrate",
      });
      expect(integratedReplay.committed).toBe(false);
      expect(integratedReplay.recovered).toBe(true);
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 2,
      );

      // A replay of the earlier accept after later writes still recovers
      // that command without writing.
      const acceptedLateReplay = yield* mcp.acceptMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept,
        receipt: decisionReceipt("acceptance", "check_pass"),
        clientRequestId: "J01-g2-accept",
      });
      expect(acceptedLateReplay.recovered).toBe(true);
      expect(acceptedLateReplay.missionRevision).toBe(revisionBeforeAccept + 2);
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 2,
      );

      // Fail closed: stale revision, unknown selector, wrong manager, wrong
      // epoch, and wrong receipt kind each refuse with a typed refusal.
      const stale = yield* mcp
        .acceptMissionResult(scope, {
          selector,
          expectedRevision: revisionBeforeAccept,
          receipt: decisionReceipt("acceptance", "check_pass"),
          clientRequestId: "J01-g2-accept-stale",
        })
        .pipe(Effect.flip);
      expect(stale.code).toBe("invalid_request");
      const unknownTask = yield* mcp
        .acceptMissionResult(scope, {
          selector: { ...selector, taskId: "task-unknown" },
          expectedRevision: revisionBeforeAccept + 2,
          receipt: decisionReceipt("acceptance", "check_pass"),
          clientRequestId: "J01-g2-accept-unknown",
        })
        .pipe(Effect.flip);
      expect(unknownTask.code).toBe("task_not_found");
      const otherScope: McpInvocationScope = {
        ...scope,
        thread: {
          threadId: ThreadId.make("delivery-other"),
          providerSessionId: "J01-gate-2-session",
          providerInstanceId: instanceId,
        },
      };
      const wrongManager = yield* mcp
        .acceptMissionResult(otherScope, {
          selector,
          expectedRevision: revisionBeforeAccept + 2,
          receipt: decisionReceipt("acceptance", "check_pass"),
          clientRequestId: "J01-g2-accept-manager",
        })
        .pipe(Effect.flip);
      expect(wrongManager.code).toBe("capability_denied");
      resultState.facts = { ...resultState.facts, deliveryEpoch: 999 };
      const wrongEpoch = yield* mcp
        .acceptMissionResult(scope, {
          selector,
          expectedRevision: revisionBeforeAccept + 2,
          receipt: decisionReceipt("acceptance", "check_pass"),
          clientRequestId: "J01-g2-accept-epoch",
        })
        .pipe(Effect.flip);
      expect(wrongEpoch.code).toBe("capability_denied");
      resultState.facts = { ...resultState.facts, deliveryEpoch: 1 };
      const wrongKind = yield* mcp
        .acceptMissionResult(scope, {
          selector,
          expectedRevision: revisionBeforeAccept + 2,
          receipt: decisionReceipt("integration", "git_integration"),
          clientRequestId: "J01-g2-accept-kind",
        })
        .pipe(Effect.flip);
      expect(wrongKind.code).toBe("invalid_request");
      // A fresh command on the integrated record refuses without writing.
      const afterIntegrated = yield* mcp
        .acceptMissionResult(scope, {
          selector,
          expectedRevision: revisionBeforeAccept + 2,
          receipt: decisionReceipt("acceptance", "check_pass"),
          clientRequestId: "J01-g2-accept-after-integrated",
        })
        .pipe(Effect.flip);
      expect(afterIntegrated.code).toBe("invalid_request");
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 2,
      );

      // After integration, a replayed reservation for the same task attempt
      // recovers without authorizing another dispatch.
      const reread = yield* admissions.reserve(admissionRequest(mission));
      assert.isTrue(Result.isSuccess(reread));
      if (!Result.isSuccess(reread)) return assert.fail("replay must succeed");
      expect(reread.success.recovered).toBe(true);
      expect(reread.success.dispatchAuthorized).toBe(false);
      expect(Option.getOrThrow(yield* missions.get(MissionId.make(missionId))).revision).toBe(
        revisionBeforeAccept + 2,
      );
    }).pipe(Effect.provide(runtime));
  },
);
it.todo(
  "J01 gate 3: refuse an old server build (gap: admission binds runtime configuration, not server build/SHA identity)",
);
