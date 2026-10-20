import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import type { MissionResultReceipt } from "../orchestration-v2/MissionResultReconciliation.ts";
import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AdmissionStore from "../orchestration-v2/MissionAdmissionStore.ts";
import * as Missions from "../orchestration-v2/MissionService.ts";
import * as MissionResultStore from "../orchestration-v2/MissionResultStore.ts";
import type { MissionAdmissionRequest } from "../orchestration-v2/MissionAdmission.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "./McpSessionRegistry.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviders from "../sourceControl/SourceControlProviderRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as TurnStartTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as MissionMcpService from "./MissionMcpService.ts";

/**
 * Result mutations stay behind the request-bound mission authorization
 * boundary: every accept/integrate resolves MissionMcpAuthorityPort for the
 * actual caller scope, binds scope.environmentId to the mission authority,
 * and re-checks the exact decision plus credential/policy inside the write
 * transaction (the same transaction-guard pattern as the admission store).
 * Replay re-resolves authority: a revoked credential, a mismatched
 * environment, or a rotated epoch refuses the exact replay with zero state
 * change instead of recovering it.
 */
const TEAM_ID = "team-j01-g2";
const ENV_ID = "environment-j01-g2";
const DELIVERY_THREAD = "delivery-j01-g2";
const MISSION_ID = "J01-gate-2-result-authority";
const TASK_ID = "task-result-accept";
const NOW_MS = Date.parse("2026-10-19T08:00:00.000Z");
const BASE_COMMIT = "b2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const COMMIT_A = "commit:aaa";
const COMMIT_B = "commit:bbb";
const RESULT_REVISION = 3;

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeMission = Schema.decodeUnknownSync(Mission);

interface AuthorityKnobs {
  /** Resolve fails scope_denied while false: the credential is revoked. */
  readonly credentialValid: { value: boolean };
  /**
   * Guard-check behavior: "live" passes a valid binding, "dead" always
   * denies, and "deadAtWriteOnce" passes the two canonical-read checks of
   * the next decision but denies its write-transaction check (call 3).
   */
  readonly mode: { value: "live" | "dead" | "deadAtWriteOnce" };
  /** Every transaction-guard check invocation, including replays. */
  readonly guardCalls: { count: number };
  /** Override the authority facts environment: an environment mismatch. */
  readonly factsEnvironment: { value: string | undefined };
}

const makeKnobs = (): AuthorityKnobs => ({
  credentialValid: { value: true },
  mode: { value: "live" },
  guardCalls: { count: 0 },
  factsEnvironment: { value: undefined },
});

const scopeDeniedError = () =>
  new Missions.MissionServiceError({ operation: "read", category: "scope_denied" });

const missionFixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: MISSION_ID,
    revision: 0,
    teamId: TEAM_ID,
    authorityEnvironmentId: ENV_ID,
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
    managers: { delivery: { threadId: DELIVERY_THREAD, epoch: 1 } },
    status: "active",
    tasks: [
      {
        id: TASK_ID,
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
  teamId: TEAM_ID,
  environmentId: ENV_ID,
  deliveryThreadId: DELIVERY_THREAD,
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
  taskId: TASK_ID,
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

const decisionReceipt = (
  kind: MissionResultReceipt["kind"],
  evidenceKind: MissionResultReceipt["evidenceKind"],
): MissionResultReceipt => ({
  kind,
  revision: RESULT_REVISION,
  commitSet: [COMMIT_A, COMMIT_B],
  evidenceKind,
  evidenceRef: `evidence:${kind}`,
  decidedBy: DELIVERY_THREAD,
  decidedAt: iso(NOW_MS),
});

const selector = {
  kind: "task-result" as const,
  missionId: MISSION_ID,
  taskId: TASK_ID,
  attemptNumber: 1,
  resultRevision: RESULT_REVISION,
};

const scopeFor = (instanceId: ProviderInstanceId, environmentId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make(environmentId),
  capabilities: new Set(["orchestration"]),
  requestNamespace: "J01-gate-2-authority",
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make(DELIVERY_THREAD),
    providerSessionId: "J01-gate-2-authority-session",
    providerInstanceId: instanceId,
  },
  client: undefined,
});

const makeHarness = (knobs: AuthorityKnobs) => {
  const calls = { count: 0 };
  const instanceId = ProviderInstanceId.make("offline-gate-2-authority");
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
    continuationIdentity: { driverKind: driver, continuationKey: "offline:gate-2-authority" },
    displayName: "Offline gate-2 authority",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const resultState: { facts: MissionResultStore.MissionResultTrustedFacts } = {
    facts: {
      teamId: TEAM_ID,
      environmentId: ENV_ID,
      deliveryThreadId: DELIVERY_THREAD,
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
  const authorityPort = Layer.effect(
    MissionMcpService.MissionMcpAuthorityPort,
    Effect.map(SqlClient.SqlClient, (sql) =>
      MissionMcpService.MissionMcpAuthorityPort.of({
        resolve: (request) => {
          calls.count += 1;
          if (!knobs.credentialValid.value) {
            return Effect.fail(
              new MissionMcpService.MissionMcpFailure({
                code: "scope_denied",
                message: "The credential is revoked.",
              }),
            );
          }
          if (request.scope.environmentId !== ENV_ID) {
            return Effect.fail(
              new MissionMcpService.MissionMcpFailure({
                code: "scope_denied",
                message: "The environment is not authorized.",
              }),
            );
          }
          if (request.requestKey === undefined) {
            return Effect.fail(
              new MissionMcpService.MissionMcpFailure({
                code: "authority_unavailable",
                message: "A request key is required.",
              }),
            );
          }
          const facts = {
            company: "nofun" as const,
            companyVerified: true as const,
            bindingVerified: true as const,
            teamId: TeamId.make(TEAM_ID),
            environmentId:
              knobs.factsEnvironment.value === undefined
                ? request.scope.environmentId
                : EnvironmentId.make(knobs.factsEnvironment.value),
            controllerThreadId: request.scope.thread.threadId,
          };
          return Effect.succeed({
            ...facts,
            transactionGuard: Missions.MissionTransactionGuard.make({
              sql,
              requestKey: request.requestKey,
              request: { operation: "read" as const, missionId: request.missionId },
              authority: {
                teamId: facts.teamId,
                environmentId: facts.environmentId,
                controllerThreadId: facts.controllerThreadId,
              },
              check: () =>
                Effect.gen(function* () {
                  knobs.guardCalls.count += 1;
                  if (
                    knobs.mode.value === "dead" ||
                    (knobs.mode.value === "deadAtWriteOnce" && knobs.guardCalls.count === 3)
                  ) {
                    return yield* scopeDeniedError();
                  }
                  const rows = yield* sql<{
                    team_id: string;
                    authority_environment_id: string;
                    manager: string | null;
                  }>`SELECT team_id, authority_environment_id, json_extract(snapshot_json, '$.managers.delivery.threadId') AS manager
                    FROM projection_missions WHERE mission_id = ${request.missionId}`;
                  const row = rows[0];
                  if (
                    row !== undefined &&
                    (row.team_id !== facts.teamId ||
                      row.authority_environment_id !== facts.environmentId ||
                      row.manager !== facts.controllerThreadId)
                  ) {
                    return yield* scopeDeniedError();
                  }
                }).pipe(Effect.mapError(() => scopeDeniedError())),
            }),
          });
        },
      }),
    ),
  );
  const withAuthority = Layer.succeed(Missions.MissionAuthority, {
    teamId: TeamId.make(TEAM_ID),
    environmentId: EnvironmentId.make(ENV_ID),
    controllerThreadId: ThreadId.make(DELIVERY_THREAD),
  });
  // The request-scoped decision reads the same stub facts the injected
  // store uses: the port must also be visible in the handler's outer
  // context, not only inside the store layer pipe.
  const stubFactsPort = Layer.succeed(MissionResultStore.MissionResultFactsPort, {
    readFacts: () => Effect.succeed(resultState.facts),
  });
  const runtimeServices = Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventInfrastructure,
    authorityPort,
    stubFactsPort,
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
      Layer.provide(stubFactsPort),
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
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "b04-j01-g2-authority-" })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeServices.layer),
  );

  const snapshotState = Effect.gen(function* () {
    const missions = yield* Missions.MissionService;
    const mission = Option.getOrThrow(yield* missions.get(MissionId.make(MISSION_ID)));
    const sql = yield* SqlClient.SqlClient;
    const events = yield* sql`SELECT sequence FROM orchestration_events`;
    return {
      revision: mission.revision,
      events,
      recordState: mission.execution?.results?.find((result) => result.taskId === TASK_ID)?.state,
    };
  });

  /** Create, admit, initialize, observe, and review one result through public store APIs. */
  const prepareReviewed = Effect.gen(function* () {
    const missions = yield* Missions.MissionService;
    yield* missions.execute({
      type: "mission.create",
      commandId: CommandId.make("J01-authority-create"),
      mission: missionFixture(),
    });
    const admissions = yield* AdmissionStore.MissionAdmissionStore;
    const reserved = yield* admissions.reserve(admissionRequest(missionFixture()));
    if (!Result.isSuccess(reserved)) {
      return assert.fail(
        `admission must succeed: ${reserved.failure.code} ${reserved.failure.message}`,
      );
    }
    const canonical = Option.getOrThrow(yield* missions.get(MissionId.make(MISSION_ID)));
    const digests = MissionResultStore.canonicalResultDigests(canonical, TASK_ID);
    if (digests === undefined) return assert.fail("result digests must exist");
    const association: ResultAssociation = {
      ...resultState.facts.association,
      digests,
      admissionDispatchKey: reserved.success.receipt.dispatchKey,
      admissionRequestDigest: reserved.success.receipt.requestDigest,
    };
    resultState.facts = { ...resultState.facts, association };
    const revisionAfterReserve = Option.getOrThrow(
      yield* missions.get(MissionId.make(MISSION_ID)),
    ).revision;
    const results = yield* MissionResultStore.MissionResultStore;
    const base = {
      missionId: MISSION_ID,
      expectedRevision: revisionAfterReserve,
      deliveryEpoch: 1,
      taskId: TASK_ID,
      dispatchKey: association.admissionDispatchKey,
      summaryText: "Worker finished the task.",
      outcome: "completed" as const,
    };
    const initialized = yield* results.execute({
      ...base,
      commandId: CommandId.make("J01-authority-initialize"),
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
      yield* missions.get(MissionId.make(MISSION_ID)),
    ).revision;
    const observed = yield* results.execute({
      ...base,
      commandId: CommandId.make("J01-authority-observe"),
      action: "observe",
      expectedRevision: revisionAfterInit,
      summaryText: undefined,
      outcome: undefined,
    });
    assert.isTrue(Result.isSuccess(observed));
    const revisionAfterObserve = Option.getOrThrow(
      yield* missions.get(MissionId.make(MISSION_ID)),
    ).revision;
    const reviewed = yield* results.execute({
      ...base,
      commandId: CommandId.make("J01-authority-review"),
      action: "review",
      expectedRevision: revisionAfterObserve,
      summaryText: undefined,
      outcome: undefined,
      receipt: decisionReceipt("review", "test_report"),
    });
    assert.isTrue(Result.isSuccess(reviewed));
    return Option.getOrThrow(yield* missions.get(MissionId.make(MISSION_ID))).revision;
  });

  return { calls, instanceId, knobs, resultState, runtime, snapshotState, prepareReviewed };
};

it.effect(
  "a denied authority refuses accept, its exact replay, and integrate with zero state change",
  () => {
    const knobs = makeKnobs();
    knobs.credentialValid.value = false;
    const harness = makeHarness(knobs);
    const scope = scopeFor(harness.instanceId, "wrong-environment");
    return Effect.gen(function* () {
      const revisionBeforeAccept = yield* harness.prepareReviewed;
      const before = yield* harness.snapshotState;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const acceptArgs = {
        selector,
        expectedRevision: revisionBeforeAccept,
        receipt: decisionReceipt("acceptance", "check_pass"),
        clientRequestId: "J01-authority-denied-accept",
      };
      const denied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
      const replayDenied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
      expect(replayDenied.code).toBe("capability_denied");
      const integrateDenied = yield* mcp
        .integrateMissionResult(scope, {
          selector,
          expectedRevision: revisionBeforeAccept,
          receipt: decisionReceipt("integration", "git_integration"),
          clientRequestId: "J01-authority-denied-integrate",
        })
        .pipe(Effect.flip);
      expect(integrateDenied.code).toBe("capability_denied");
      expect(harness.calls.count).toBeGreaterThan(0);
      expect(yield* harness.snapshotState).toEqual(before);
    }).pipe(Effect.provide(harness.runtime));
  },
);

it.effect("a revoked credential refuses the exact replay of a committed accept", () => {
  const knobs = makeKnobs();
  const harness = makeHarness(knobs);
  const scope = scopeFor(harness.instanceId, ENV_ID);
  return Effect.gen(function* () {
    const revisionBeforeAccept = yield* harness.prepareReviewed;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const acceptArgs = {
      selector,
      expectedRevision: revisionBeforeAccept,
      receipt: decisionReceipt("acceptance", "check_pass"),
      clientRequestId: "J01-authority-accept",
    };
    const accepted = yield* mcp.acceptMissionResult(scope, acceptArgs);
    expect(accepted.committed).toBe(true);
    expect(accepted.recovered).toBe(false);
    const afterAccept = yield* harness.snapshotState;
    expect(afterAccept.recordState).toBe("accepted");
    knobs.credentialValid.value = false;
    const replayDenied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(replayDenied.code).toBe("capability_denied");
    const integrateDenied = yield* mcp
      .integrateMissionResult(scope, {
        selector,
        expectedRevision: revisionBeforeAccept + 1,
        receipt: decisionReceipt("integration", "git_integration"),
        clientRequestId: "J01-authority-integrate-revoked",
      })
      .pipe(Effect.flip);
    expect(integrateDenied.code).toBe("capability_denied");
    expect(harness.calls.count).toBeGreaterThan(0);
    const after = yield* harness.snapshotState;
    expect(after).toEqual(afterAccept);
    expect(after.recordState).toBe("accepted");
  }).pipe(Effect.provide(harness.runtime));
});

it.effect("an authority environment mismatch refuses fresh and replayed decisions", () => {
  const knobs = makeKnobs();
  knobs.factsEnvironment.value = "environment-other";
  const harness = makeHarness(knobs);
  const scope = scopeFor(harness.instanceId, ENV_ID);
  return Effect.gen(function* () {
    const revisionBeforeAccept = yield* harness.prepareReviewed;
    const before = yield* harness.snapshotState;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const acceptArgs = {
      selector,
      expectedRevision: revisionBeforeAccept,
      receipt: decisionReceipt("acceptance", "check_pass"),
      clientRequestId: "J01-authority-env-accept",
    };
    const denied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(denied.code).toBe("capability_denied");
    const replayDenied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(replayDenied.code).toBe("capability_denied");
    expect(harness.calls.count).toBeGreaterThan(0);
    expect(yield* harness.snapshotState).toEqual(before);
  }).pipe(Effect.provide(harness.runtime));
});

it.effect(
  "a policy revoked at the write refuses inside the write transaction, then the retry commits once live",
  () => {
    const knobs = makeKnobs();
    knobs.mode.value = "deadAtWriteOnce";
    const harness = makeHarness(knobs);
    const scope = scopeFor(harness.instanceId, ENV_ID);
    return Effect.gen(function* () {
      const revisionBeforeAccept = yield* harness.prepareReviewed;
      const before = yield* harness.snapshotState;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const acceptArgs = {
        selector,
        expectedRevision: revisionBeforeAccept,
        receipt: decisionReceipt("acceptance", "check_pass"),
        clientRequestId: "J01-authority-policy-accept",
      };
      const denied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
      // The two canonical-read checks passed and the write-transaction check
      // denied: the decision never reached the store.
      expect(knobs.guardCalls.count).toBe(3);
      expect(harness.calls.count).toBeGreaterThan(0);
      expect(yield* harness.snapshotState).toEqual(before);
      knobs.mode.value = "live";
      const retried = yield* mcp.acceptMissionResult(scope, acceptArgs);
      expect(retried.committed).toBe(true);
      expect(retried.recovered).toBe(false);
      expect(retried.missionRevision).toBe(revisionBeforeAccept + 1);
    }).pipe(Effect.provide(harness.runtime));
  },
);

it.effect("a dead policy refuses fresh and replayed decisions with zero state change", () => {
  const knobs = makeKnobs();
  knobs.mode.value = "dead";
  const harness = makeHarness(knobs);
  const scope = scopeFor(harness.instanceId, ENV_ID);
  return Effect.gen(function* () {
    const revisionBeforeAccept = yield* harness.prepareReviewed;
    const before = yield* harness.snapshotState;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const acceptArgs = {
      selector,
      expectedRevision: revisionBeforeAccept,
      receipt: decisionReceipt("acceptance", "check_pass"),
      clientRequestId: "J01-authority-policy-dead",
    };
    const denied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(denied.code).toBe("capability_denied");
    const replayDenied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(replayDenied.code).toBe("capability_denied");
    expect(knobs.guardCalls.count).toBeGreaterThan(0);
    expect(yield* harness.snapshotState).toEqual(before);
  }).pipe(Effect.provide(harness.runtime));
});

it.effect("an advanced trusted epoch refuses stale decisions on fresh and replayed calls", () => {
  const knobs = makeKnobs();
  const harness = makeHarness(knobs);
  const scope = scopeFor(harness.instanceId, ENV_ID);
  return Effect.gen(function* () {
    const revisionBeforeAccept = yield* harness.prepareReviewed;
    const before = yield* harness.snapshotState;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    harness.resultState.facts = { ...harness.resultState.facts, deliveryEpoch: 2 };
    const acceptArgs = {
      selector,
      expectedRevision: revisionBeforeAccept,
      receipt: decisionReceipt("acceptance", "check_pass"),
      clientRequestId: "J01-authority-epoch-accept",
    };
    const denied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(denied.code).toBe("capability_denied");
    const replayDenied = yield* mcp.acceptMissionResult(scope, acceptArgs).pipe(Effect.flip);
    expect(replayDenied.code).toBe("capability_denied");
    expect(harness.calls.count).toBeGreaterThan(0);
    expect(yield* harness.snapshotState).toEqual(before);
    harness.resultState.facts = { ...harness.resultState.facts, deliveryEpoch: 1 };
    const retried = yield* mcp.acceptMissionResult(scope, acceptArgs);
    expect(retried.committed).toBe(true);
    expect(retried.recovered).toBe(false);
    expect(retried.missionRevision).toBe(revisionBeforeAccept + 1);
  }).pipe(Effect.provide(harness.runtime));
});
