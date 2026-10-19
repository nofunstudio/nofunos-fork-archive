import {
  CommandId,
  EnvironmentId,
  Mission,
  MessageId,
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
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TurnStartTestkit from "./ProviderTurnStartService.testkit.ts";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Orchestrator from "./Orchestrator.ts";
const authority = {
  teamId: TeamId.make("team-admission"),
  environmentId: EnvironmentId.make("environment-admission"),
  controllerThreadId: ThreadId.make("delivery-admission"),
};
const mission = Schema.decodeUnknownSync(Mission)({
  schemaVersion: 1,
  id: "J02-offline-existing-child",
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
 * D3: existing T3 child continuity only; no portable/bridge identity mapping.
 * Canonical admitted-child gates remain blocked by B-02d. This prerequisite
 * deliberately keeps the ordinary child distinguishable from a canonical one.
 * Real file SQLite is closed and reopened; activation is parked, so this is
 * queued-child persistence/replay proof, never running-provider recovery proof.
 */
it.effect(
  "J02 gate 1 prerequisite: existing queued child survives reopen without canonical admission",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "b05-j02-reopen-" });
      const dbPath = path.join(root, "state.sqlite");
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
      const runtime = Layer.mergeAll(
        RuntimeLayer.layer,
        Missions.layer.pipe(Layer.provide(RuntimeLayer.layerEventInfrastructure)),
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
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "b05-j02-runtime-" })),
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
        Layer.provide(NodeServices.layer),
      );

      const scopedRuntime = runtime.pipe(
        Layer.provide(Layer.succeed(Missions.MissionAuthority, authority)),
      );
      const parentId = authority.controllerThreadId;
      const first = yield* Effect.gen(function* () {
        const missions = yield* Missions.MissionService;
        yield* missions.execute({
          type: "mission.create",
          commandId: CommandId.make("J02-create"),
          mission,
        });
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("J02-parent"),
          threadId: parentId,
          projectId: ProjectId.make("project-admission"),
          title: "J02 existing child",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace/project",
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("J02-parent-start"),
          threadId: parentId,
          messageId: MessageId.make("J02-parent-message"),
          text: "Start parent",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const run = (yield* threads.getThreadProjection(parentId)).runs[0]!;
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make("J02-existing-child"),
          parentThreadId: parentId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Keep this existing ordinary child distinct from canonical admission.",
          modelSelection: selection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const receipt = yield* threads.dispatch(command);
        const parent = yield* threads.getThreadProjection(parentId);
        expect(parent.subagents).toHaveLength(1);
        const childId = parent.subagents[0]!.childThreadId!;
        const child = yield* threads.getThreadProjection(childId);
        expect(child.messages[0]?.text).toBe(command.task);
        const sql = yield* SqlClient.SqlClient;
        const count = (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]!.count;
        return { command, sequence: receipt.sequence, childId, count };
      }).pipe(Effect.provide(Layer.fresh(scopedRuntime)));

      // A new scoped layer opens the same file after the previous SQLite connection closed.
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const replay = yield* threads.dispatch(first.command);
        expect(replay.sequence).toBe(first.sequence);
        const parent = yield* threads.getThreadProjection(parentId);
        expect(parent.subagents).toHaveLength(1);
        expect(parent.subagents[0]?.childThreadId).toBe(first.childId);
        expect((yield* threads.getThreadProjection(first.childId)).messages[0]?.text).toBe(
          first.command.task,
        );
        const missions = yield* Missions.MissionService;
        const canonical = Option.getOrThrow(yield* missions.get(mission.id));
        expect(canonical.execution?.admissions ?? []).toEqual([]);
        expect(canonical.execution?.results ?? []).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]!
            .count,
        ).toBe(first.count);
      }).pipe(Effect.provide(Layer.fresh(scopedRuntime)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.todo(
  "J02 gate 2: recover one lost canonical completion wake after manager downtime (blocked: B-02d/J01 admitted-child predecessor)",
);
it.todo(
  "J02 gate 3: successor receives pending admitted-child completion and incumbent retirement preserves child (blocked: B-02d/J01; no synthetic admission)",
);
it.todo(
  "J02 gate 4: refuse cross-environment admitted replay (blocked: no public admitted dispatch; D3 forbids adding cross-system identity mapping)",
);
