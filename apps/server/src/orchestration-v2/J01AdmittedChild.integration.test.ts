import {
  CommandId,
  EventId,
  MessageId,
  type ServerProvider,
  UsageLimitSourceId,
  EnvironmentId,
  Mission,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as MuseUsage from "../nofun/MuseUsage.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as SessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as MissionPolicy from "../mcp/MissionMcpPolicy.ts";
import * as MissionAuthority from "../mcp/MissionMcpAuthority.ts";
import * as AdmissionRuntime from "./MissionAdmissionRuntime.ts";
import * as Projects from "./ProjectStore.ts";
import * as Projections from "./ProjectionStore.ts";

// Only passive OS sampling and provider launch are offline. The facts port,
// authority resolver, credential registry and durable admission are production.
vi.mock("./ExecutionCapacity.ts", async (original) => ({
  ...(await original<typeof import("./ExecutionCapacity.ts")>()),
  readExecutionCapacity: async (diskPath: string, observedAtMs: number) => ({
    hostId: "j01-host",
    bootId: "j01-boot",
    observedAtMs,
    cpu: { utilization: 0.1, count: 8, loadAverage1m: 0.5, saturated: false },
    memory: { totalBytes: 64 * 1024 ** 3, availableBytes: 32 * 1024 ** 3, pressure: "normal" },
    disk: { path: diskPath, availableBytes: 100 * 1024 ** 3, floorBytes: 5 * 1024 ** 3 },
    buildLock: { path: "build-lock", state: "available" },
    ready: true,
    reasons: [],
  }),
}));
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AdmissionStore from "./MissionAdmissionStore.ts";
import * as EventLog from "../persistence/OrchestrationEventStore.ts";
import * as Missions from "./MissionService.ts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
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
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
 * Public mission delegation still refuses until its owning MCP lane binds it.
 * The production request-scoped runtime below proves canonical admission and
 * exact replay without replacing the trusted facts port.
 * No provider starts and no live T3 state is opened.
 */
it.effect.each(["provider", "muse"] as const)(
  "J01 gate 1: production runtime admits one canonical child with %s quota and exact replay writes nothing; public binding remains pending",
  (quotaSource) => {
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
    const environment = Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(authority.environmentId),
      getDescriptor: Effect.die("No environment descriptor is used"),
    });
    const registry = SessionRegistry.layer.pipe(
      Layer.provide(environment),
      Layer.provide(
        Layer.succeed(HttpServer.HttpServer, {
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43131),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
    );
    const publisher = new MissionPolicy.MissionMcpPolicyPublisher();
    publisher.publish({
      company: "nofun",
      companyVerified: true,
      bindingVerified: true,
      policyRef: "J01-offline-policy",
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      allowedProjectIds: [ProjectId.make("project-admission")],
      bootstrapControllerThreadIds: [authority.controllerThreadId],
    });
    const policy = Layer.succeed(MissionAuthority.MissionMcpTrustedPolicy, publisher.policy);
    const provider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "offline",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      models: [{ slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      usageLimits:
        quotaSource === "provider"
          ? {
              checkedAt: "1970-01-01T00:00:00.000Z",
              windows: [{ id: "five_hour", kind: "session", label: "5h", usedPercent: 20 }],
            }
          : undefined,
    };
    const runtimeServices = Layer.mergeAll(
      RuntimeLayer.layer,
      RuntimeLayer.layerEventInfrastructure,
      Projects.layer,
      Projections.layer,
      Missions.layer.pipe(Layer.provide(RuntimeLayer.layerEventInfrastructure)),
    );
    const mcpDependencies = Layer.mergeAll(
      runtimeServices,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      ProviderRegistryMock.layer([provider]),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ).pipe(Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})));
    const runtime = Layer.mergeAll(
      runtimeServices,
      RuntimeLayer.layerMissionAdmissionRuntime.pipe(Layer.provide(runtimeServices)),
      OrchestratorMcpService.layer.pipe(Layer.provide(mcpDependencies)),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
          ProviderRegistryMock.layer([provider]),
          quotaSource === "muse"
            ? Layer.mock(MuseUsage.MuseUsage)({
                current: Effect.succeed([
                  {
                    id: UsageLimitSourceId.make(`muse:${instanceId}`),
                    kind: "muse",
                    label: "Offline subscription",
                    checkedAt: "1970-01-01T00:00:00.000Z",
                    accounts: [
                      {
                        id: "j01-account",
                        driver,
                        usageLimits: {
                          checkedAt: "1970-01-01T00:00:00.000Z",
                          windows: [
                            { id: "five_hour", kind: "session", label: "5h", usedPercent: 20 },
                          ],
                        },
                      },
                    ],
                  },
                ]),
              })
            : Layer.empty,
          registry,
          environment,
          policy,
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bk1-j01-runtime-" })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(NodeServices.layer),
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
      const eventLog = yield* EventLog.OrchestrationEventStore;
      const before = yield* eventLog.latestApplicationSequence;
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
      expect(yield* eventLog.latestApplicationSequence).toBe(before);
      const nowMs = yield* Clock.currentTimeMillis;
      const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      yield* (yield* Projects.ProjectStoreV2).apply({
        sequence: 0,
        eventId: EventId.make("J01-project-seed"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-admission"),
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-admission"),
          title: "J01 offline",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: selection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const filename = path.join(config.stateDir, "nofun", "mission-admission.json");
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      yield* fs.writeFileString(
        filename,
        yield* encodeJson({
          version: 1,
          teamId: authority.teamId,
          environmentId: authority.environmentId,
          company: "No Fun",
          hostQualification: {
            hostId: "j01-host",
            bootId: "j01-boot",
            buildObserved: true,
            buildOk: true,
            toolchainObserved: true,
            toolchainOk: true,
            observedAtMs: nowMs,
          },
          repositoryObservations: [
            {
              projectId: "project-admission",
              workspaceRootRealpath: "/workspace/project",
              observedAncestry: ["base"],
              observedAtMs: nowMs,
            },
          ],
          providers: [
            {
              instanceId,
              accountId: "j01-account",
              company: "No Fun",
              billingMode: "subscription",
              verifiedAtMs: nowMs,
              routes: [
                {
                  modelId: selection.model,
                  profile: "default",
                  capability: "read_only",
                  supportedModelIds: [selection.model],
                },
              ],
            },
          ],
        }),
        { mode: 0o600 },
      );
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("J01-parent-start"),
        threadId: authority.controllerThreadId,
        messageId: MessageId.make("J01-parent-message"),
        text: "Run the admitted inventory",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const parent = yield* threads.getThreadProjection(authority.controllerThreadId);
      const parentRun = parent.runs[0]!;
      const credentials = yield* SessionRegistry.McpSessionRegistry;
      const issued = yield* credentials.issue({
        threadId: authority.controllerThreadId,
        providerInstanceId: instanceId,
      });
      const caller = (yield* credentials.resolve(
        issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      ))!;
      const binding = yield* AdmissionRuntime.MissionAdmissionRuntime;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("J01-canonical-child"),
        parentThreadId: authority.controllerThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: input.task,
        modelSelection: selection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const [first, concurrent] = yield* Effect.all(
        [
          binding.dispatch(caller, input.mission, command),
          binding.dispatch(caller, input.mission, command),
        ],
        { concurrency: "unbounded" },
      );
      expect(concurrent.taskId).toBe(first.taskId);
      expect(concurrent.result.sequence).toBe(first.result.sequence);
      const admitted = Option.getOrThrow(yield* missions.get(mission.id));
      expect(admitted.execution?.admissions).toHaveLength(1);
      const children = (yield* threads.getThreadProjection(authority.controllerThreadId)).subagents;
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe(first.taskId);
      expect(children[0]!.childThreadId).toMatch(
        /^thread:delegated-task:mission-dispatch%3A[0-9a-f]{64}$/,
      );
      const child = yield* threads.getThreadProjection(children[0]!.childThreadId!);
      expect(child.messages[0]?.text).toBe(input.task);
      const log = yield* EventLog.OrchestrationEventStore;
      const committedSequence = yield* log.latestApplicationSequence;
      const admissionEvents = yield* log.readMissionEvents(mission.id);
      const replay = yield* binding.dispatch(caller, input.mission, command);
      expect(replay.taskId).toBe(first.taskId);
      expect(replay.result.sequence).toBe(first.result.sequence);
      expect(replay.result.storedEvents).toEqual(first.result.storedEvents);
      expect(yield* log.latestApplicationSequence).toBe(committedSequence);
      expect(yield* log.readMissionEvents(mission.id)).toEqual(admissionEvents);
      expect(Option.getOrThrow(yield* missions.get(mission.id))).toEqual(admitted);
      expect((yield* threads.getThreadProjection(authority.controllerThreadId)).subagents).toEqual(
        children,
      );
      const changed = yield* binding
        .dispatch(caller, input.mission, {
          ...command,
          task: "A different prompt is not an exact replay.",
        })
        .pipe(Effect.flip);
      expect(changed._tag).toBe("OrchestratorDispatchError");
      expect(yield* log.latestApplicationSequence).toBe(committedSequence);
      expect(Option.getOrThrow(yield* missions.get(mission.id))).toEqual(admitted);
      // A revoked credential may not recover an already admitted child.
      yield* credentials.revokeThread(authority.controllerThreadId);
      expect((yield* binding.dispatch(caller, input.mission, command).pipe(Effect.flip))._tag).toBe(
        "OrchestratorDispatchError",
      );
    }).pipe(
      Effect.provide(
        runtime.pipe(Layer.provide(Layer.succeed(Missions.MissionAuthority, authority))),
      ),
    );
  },
);

it.todo(
  "J01 gate 2: associate, accept and integrate an admitted public child result once (blocked: B-02d/public admission binding)",
);
it.todo(
  "J01 gate 3: refuse an old server build (gap: admission binds runtime configuration, not server build/SHA identity)",
);
