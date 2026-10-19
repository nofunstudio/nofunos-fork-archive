import {
  CommandId,
  EnvironmentId,
  MessageId,
  Mission,
  MissionId,
  MissionTaskSpec,
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
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { MissionAdmissionRequest } from "./MissionAdmission.ts";
import * as Facts from "./MissionAdmissionFacts.ts";
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
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TurnStartTestkit from "./ProviderTurnStartService.testkit.ts";

const decodeTask = Schema.decodeSync(MissionTaskSpec);
const encodeTaskJson = Schema.encodeSync(Schema.fromJsonString(MissionTaskSpec));
const decodeTaskJson = Schema.decodeUnknownSync(Schema.fromJsonString(MissionTaskSpec));
const encodeMissionJson = Schema.encodeEffect(Schema.fromJsonString(Mission));
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

// B-02 prerequisite: production readFacts must obtain scope from the canonical
// task, never from the proposal. Keep this regression red until the owning
// contract/persistence lane supplies that authority; do not invent a scope.
// Expected failure records the frozen Nos lane's reproduced prerequisite gap.
it.fails("canonical mission tasks retain admission scope through persistence", () => {
  const task = {
    id: "task-admission",
    projectId: "project-admission",
    title: "Write only the assigned scope",
    specHash: "spec-hash",
    dependencyHashes: [],
    dependencies: [],
    acceptanceIds: ["acceptance-admission"],
    updatedAt: "2026-10-19T07:30:00.000Z",
    writerScope: "/workspace/project/src/admission",
    sharedManifestScopes: ["/workspace/project/package.json"],
    guiScopes: [],
  };
  const persisted = encodeTaskJson(decodeTask(task));
  const restored = decodeTaskJson(persisted);

  expect(restored).toMatchObject({
    writerScope: task.writerScope,
    sharedManifestScopes: task.sharedManifestScopes,
    guiScopes: task.guiScopes,
  });
});

const authority = {
  teamId: TeamId.make("team-admission"),
  environmentId: EnvironmentId.make("environment-admission"),
  controllerThreadId: ThreadId.make("delivery-admission"),
};
const mission = Schema.decodeUnknownSync(Mission)({
  schemaVersion: 1,
  id: "mission-admission",
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
      updatedAt: "2026-10-19T07:30:00.000Z",
    },
  ],
  updatedAt: "2026-10-19T07:30:00.000Z",
});
const request: MissionAdmissionRequest = {
  mission,
  taskId: "task-admission",
  specHash: "spec-hash",
  dependencyHashes: [],
  attempt: { attemptNumber: 1, operation: "write" },
  proposedAccountId: "account-proposal",
  proposedProviderInstanceId: "provider-proposal",
  proposedBillingMode: "subscription",
  modelId: "gpt-6.1-sol",
  profile: "default",
  promptHash: "prompt-hash",
  optionsHash: "options-hash",
  workspaceRoot: "/workspace/project",
  privilege: "writer",
  rejectedRoutes: [],
};
const authorityLayer = Layer.succeed(Missions.MissionAuthority, authority);
const layerTest = Layer.mergeAll(
  Facts.layer,
  Missions.layer.pipe(Layer.provide(Layer.mergeAll(Events.layer, Receipts.layer))),
  AdmissionStore.layer.pipe(
    Layer.provide(Layer.mergeAll(Facts.layer, Events.layer, Receipts.layer)),
  ),
).pipe(Layer.provide(authorityLayer), Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.flatMap(Missions.MissionService, (service) =>
  service.execute({ type: "mission.create", commandId: CommandId.make("seed-admission"), mission }),
);
const denial = (error: AdmissionStore.MissionAdmissionStoreError) => {
  expect(error).toBeInstanceOf(AdmissionStore.MissionAdmissionStoreError);
  expect(error.category).toBe("scope_denied");
  expect(error.cause).toBeInstanceOf(Facts.MissionAdmissionFactsUnavailable);
  return error.cause as Facts.MissionAdmissionFactsUnavailable;
};

it.effect(
  "denies missing canonical scopes and provider attestations without writing a reservation",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM projection_missions`;
      const eventsBefore = yield* sql`SELECT sequence FROM orchestration_events`;
      const store = yield* AdmissionStore.MissionAdmissionStore;
      const error = denial(yield* Effect.flip(store.reserve(request)));
      expect(error.reason).toBe("canonical_facts_unavailable");
      expect(error.missing).toEqual([
        "writerScope",
        "sharedManifestScopes",
        "guiScopes",
        "taskNecessary",
        "company",
        "billingMode",
        "capability",
      ]);
      expect(yield* sql`SELECT * FROM projection_missions`).toEqual(before);
      expect(yield* sql`SELECT sequence FROM orchestration_events`).toEqual(eventsBefore);
      expect(
        yield* sql`SELECT * FROM orchestration_command_receipts WHERE command_id != ${"seed-admission"}`,
      ).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not accept scopes or attestations smuggled in a worker proposal", () =>
  Effect.gen(function* () {
    yield* seed;
    const port = yield* AdmissionStore.MissionAdmissionFactsPort;
    const proposal = {
      ...request,
      mission: {
        ...mission,
        tasks: mission.tasks.map((task) => ({
          ...task,
          writerScope: "/workspace/project",
          sharedManifestScopes: [],
          guiScopes: [],
          taskNecessary: true,
        })),
      },
      company: "No Fun",
      billingMode: "subscription",
      capability: "writer",
    };
    expect(denial(yield* Effect.flip(port.readFacts(proposal))).reason).toBe(
      "canonical_facts_unavailable",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses facts without authenticated mission authority", () =>
  Effect.gen(function* () {
    const port = yield* AdmissionStore.MissionAdmissionFactsPort;
    expect(denial(yield* Effect.flip(port.readFacts(request))).reason).toBe(
      "authority_unavailable",
    );
  }).pipe(Effect.provide(Facts.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect(
  "uses scoped canonical identity and rejects absent missions, tasks, and stale delivery authority",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const port = yield* AdmissionStore.MissionAdmissionFactsPort;
      for (const proposed of [
        {
          ...request,
          mission: {
            ...mission,
            id: MissionId.make("missing-mission"),
          },
        },
        { ...request, mission: { ...mission, teamId: TeamId.make("another-team") } },
      ]) {
        expect(denial(yield* Effect.flip(port.readFacts(proposed))).reason).toBe(
          "mission_unavailable",
        );
      }
      expect(
        denial(yield* Effect.flip(port.readFacts({ ...request, taskId: "missing-task" }))).reason,
      ).toBe("task_unavailable");
      const sql = yield* SqlClient.SqlClient;
      const snapshot = yield* encodeMissionJson({
        ...mission,
        managers: { delivery: { threadId: ThreadId.make("other-controller"), epoch: 2 } },
      });
      yield* sql`UPDATE projection_missions SET snapshot_json = ${snapshot}`;
      expect(denial(yield* Effect.flip(port.readFacts(request))).reason).toBe("delivery_mismatch");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "composes admission with trusted authority and preserves ordinary delegated dispatch without authority",
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
    const runtime = RuntimeLayer.layer.pipe(
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
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "b02-admission-runtime-" })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeServices.layer),
    );
    const ordinaryDispatch = Effect.gen(function* () {
      const service = yield* ThreadManagement.ThreadManagementService;
      const threadId = ThreadId.make("ordinary-admission-parent");
      yield* service.dispatch({
        type: "thread.create",
        commandId: CommandId.make("ordinary-admission-create"),
        threadId,
        projectId: ProjectId.make("project-admission"),
        title: "Ordinary delegation",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace/project",
        createdBy: "user",
        creationSource: "web",
      });
      yield* service.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ordinary-admission-message"),
        threadId,
        messageId: MessageId.make("ordinary-admission-message"),
        text: "Start parent",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const parent = yield* service.getThreadProjection(threadId);
      const run = parent.runs[0]!;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("ordinary-admission-child"),
        parentThreadId: threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Ordinary delegation stays opt-in",
        modelSelection: selection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const configured = yield* Effect.serviceOption(AdmissionStore.MissionAdmissionStore);
      if (Option.isSome(configured)) {
        const refused = yield* Effect.flip(
          service.dispatch(command, {
            missionAdmissionRequest: {
              ...request,
              proposedProviderInstanceId: instanceId,
              privilege: "full-access",
            },
          }),
        );
        // Reaching the port proves ThreadManagement received both store and runtime policy.
        if (!isDispatchError(refused)) {
          return yield* Effect.die("Expected mission preparation to fail at the facts port");
        }
        expect(refused.cause).toBeInstanceOf(AdmissionStore.MissionAdmissionStoreError);
        expect(denial(refused.cause as AdmissionStore.MissionAdmissionStoreError).reason).toBe(
          "mission_unavailable",
        );
      }
      const first = yield* service.dispatch(command);
      expect((yield* service.dispatch(command)).sequence).toBe(first.sequence);
      const after = yield* service.getThreadProjection(threadId);
      expect(after.subagents).toHaveLength(1);
      const child = yield* service.getThreadProjection(after.subagents[0]!.childThreadId!);
      expect(child.messages[0]!.text).toBe(command.task);
      expect(child.thread.modelSelection).toEqual(selection);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM projection_missions`).toEqual([]);
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const configured = yield* Effect.serviceOption(AdmissionStore.MissionAdmissionStore);
        expect(Option.isSome(configured)).toBe(true);
        const store = Option.getOrThrow(configured);
        // Real store preparation reaches the production facts port, not synthetic facts.
        expect(denial(yield* Effect.flip(store.reserve(request))).reason).toBe(
          "mission_unavailable",
        );
        yield* ordinaryDispatch;
      }).pipe(Effect.provide(runtime.pipe(Layer.provide(authorityLayer))));
      yield* ordinaryDispatch.pipe(Effect.provide(runtime));
    });
  },
);
