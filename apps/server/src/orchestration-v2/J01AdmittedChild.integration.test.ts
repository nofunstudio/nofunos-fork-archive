import {
  CommandId,
  EnvironmentId,
  Mission,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AdmissionStore from "./MissionAdmissionStore.ts";
import * as Missions from "./MissionService.ts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
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

it.todo(
  "J01 gate 2: associate, accept and integrate an admitted public child result once (blocked: B-02d/public admission binding)",
);
it.todo(
  "J01 gate 3: refuse an old server build (gap: admission binds runtime configuration, not server build/SHA identity)",
);
