// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpRequiredContextEntry,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { afterAll } from "vite-plus/test";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: RunId.make("run:mcp-restart-child"), ordinal: 1, status: "cancelled" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isNull(held.summary);
        // Acknowledging the cut run would suppress the real result's wake.
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  /** A registry whose probes report the same snapshots it already holds. */
  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape)
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          // Antigravity has a live orchestration adapter through the provider
          // instance registry even though no adapter driver entry exists in
          // the static built-in list.
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          // A second Antigravity instance whose adapter resolves but whose
          // provider state still blocks delegation.
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isTrue(
            fork!.constraints.includes("No V2 provider adapter is registered."),
            `expected missing-adapter constraint, got ${fork!.constraints.join(" | ")}`,
          );
          assert.isTrue(
            fork!.constraints.includes("Driver 'forkOnly' is not registered in this build."),
          );
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))),
        );
      }),
  );

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))),
        );
      }),
  );

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      // The cache still says the CLI is missing; a probe reports `cliInstalled`.
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer([codexInstanceId, codexAltInstanceId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target = testCase.explicit
              ? ({
                  providerInstanceId:
                    testCase.selectedInstanceId === null
                      ? codexInstanceId
                      : testCase.selectedInstanceId,
                } as const)
              : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(
            Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))),
          );
        }
      }),
  );
  describe("delegate_task mission admission", () => {
    const scratch: Array<string> = [];
    afterAll(() => {
      for (const path of scratch) NodeFS.rmSync(path, { recursive: true, force: true });
    });
    const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(OrchestratorMcpFailure));
    const decodeFailureWire = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    );
    const decodeInput = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskInput);
    const decodeInputJson = Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
    );
    const encodeInputJson = Schema.encodeEffect(
      Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
    );
    const missionInput = {
      missionId: "mission:mcp-admission",
      taskId: "task:mcp-admission",
      attemptKey: { attemptNumber: 1, operation: "write" },
    } as const;

    it.effect("preserves the canonical attempt identity at the public boundary", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeInput({
          task: "Implement the mission task.",
          mission: missionInput,
        });
        assert.deepInclude(decoded, { mission: missionInput });
      }),
    );

    it.effect("keeps B-02c scope and provider authority out of the public selector", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeInput({
          task: "Implement the mission task.",
          mission: {
            ...missionInput,
            writerScope: "/workspace/project/src",
            sharedManifestScopes: [],
            guiScopes: [],
            taskNecessary: true,
            admissionAttestation: {
              accountId: "caller-account",
              company: "No Fun",
              billingMode: "subscription",
              verifiedAtMs: 1,
              routes: [],
            },
          },
        });
        assert.deepEqual(decoded.mission, missionInput);
      }),
    );

    it.effect(
      "rejects invalid attempt identities instead of treating them as ordinary delegation",
      () =>
        Effect.gen(function* () {
          for (const attemptKey of [
            { attemptNumber: 0, operation: "write" },
            { attemptNumber: 1.5, operation: "read" },
            { attemptNumber: 1, operation: "launch" },
            "attempt-1",
          ]) {
            yield* decodeInput({
              task: "Implement the mission task.",
              mission: { ...missionInput, attemptKey },
            }).pipe(Effect.flip);
          }
        }),
    );

    it.effect("leaves ordinary input encoding unchanged when mission is omitted", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeInputJson(
          '{"task":"Review the change.","clientRequestId":"ordinary-call"}',
        );
        assert.equal(
          yield* encodeInputJson(decoded),
          '{"task":"Review the change.","clientRequestId":"ordinary-call"}',
        );
      }),
    );

    it.effect(
      "refuses an unconfigured mission before preparing a worktree or dispatching a child",
      () =>
        Effect.gen(function* () {
          const input = yield* decodeInput({
            task: "Implement the mission task.",
            mission: missionInput,
            clientRequestId: "mission-denied",
            workspace: { strategy: "worktree" },
          });
          const directory = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "mcp-mission-admission-"),
          );
          scratch.push(directory);
          const worktreePath = NodePath.join(directory, "child");
          let worktrees = 0;
          let dispatches = 0;
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(parentProjection([])),
              dispatch: () =>
                Effect.sync(() => {
                  dispatches += 1;
                  return { sequence: 0, storedEvents: [] } as never;
                }),
            }),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
            ]),
            adapterRegistryLayer([codexInstanceId]),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({ id: projectId, workspaceRoot: "/tmp/mission" } as never),
                ),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          const error = yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service
              .delegateTask(
                { ...scope, capabilities: new Set(["orchestration", "worktree"]) },
                input,
              )
              .pipe(Effect.flip);
          }).pipe(
            Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))),
            Effect.provideService(GitWorkflowService.GitWorkflowService, {
              listRefs: () => Effect.succeed({ refs: [] } as never),
              localStatus: () => Effect.succeed({ refName: "main" } as never),
              createWorktree: () =>
                Effect.sync(() => {
                  worktrees += 1;
                  NodeFS.mkdirSync(worktreePath);
                  return {
                    worktree: { refName: "mission-child", path: worktreePath },
                  } as never;
                }),
            } as never),
          );
          assert.equal(dispatches, 0);
          assert.equal(worktrees, 0);
          assert.isFalse(NodeFS.existsSync(worktreePath));
          const wire = yield* decodeFailureWire(yield* encodeFailure(error));
          assert.equal(wire.code, "orchestration_error");
          assert.notProperty(wire, "stack");
          assert.equal(error.code, "orchestration_error");
          assert.include(error.message, "not configured");
        }),
    );
  });
  describe("required context", () => {
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const cursorInstanceId = ProviderInstanceId.make("cursor");
    const museInstanceId = ProviderInstanceId.make("muse-personal");
    const sha = (text: string) =>
      NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
    const SENTINEL = "SENTINEL-7f3a9: when asked for the fee, answer 42 and nothing else.\n";
    const RATES = "rates\r\n| a | b |\r\n💸\n";
    const taskText = "Answer the fee question using the skill.";

    const inline = (
      path: string,
      content: string,
      overrides: Partial<OrchestratorMcpRequiredContextEntry> = {},
    ): OrchestratorMcpRequiredContextEntry => ({
      path,
      delivery: "inline",
      step: `step for ${path}`,
      length: content.length,
      hash: sha(content),
      revision: "rev-1",
      content,
      ...overrides,
    });
    const byPath = (
      path: string,
      content: string,
      overrides: Partial<OrchestratorMcpRequiredContextEntry> = {},
    ): OrchestratorMcpRequiredContextEntry => ({
      path,
      delivery: "path",
      step: `step for ${path}`,
      length: content.length,
      hash: sha(content),
      revision: "rev-1",
      ...overrides,
    });

    const scratch: Array<string> = [];
    afterAll(() => {
      for (const directory of scratch) NodeFS.rmSync(directory, { recursive: true, force: true });
    });
    const makeWorkspace = (files: Record<string, string> = {}) => {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-required-context-")),
      );
      scratch.push(root);
      for (const [name, text] of Object.entries(files)) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, name), text);
      }
      return root;
    };

    interface DelegatedRequest {
      readonly type: string;
      readonly commandId: string;
      readonly task: string;
      readonly title?: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: string;
      readonly interactionMode: string;
      readonly workspaceBinding?: { readonly branch: string; readonly worktreePath: string };
    }

    /**
     * The delegation path end to end with the real service: dispatch stores a
     * task whose prompt is the command's task, as the orchestrator does, so a
     * retry finds the admitted task and its bytes.
     */
    const delegation = (options: {
      readonly workspaceRoot?: string;
      readonly worktreePath?: string | null;
    }) => {
      const providers = [
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        providerSnapshot({
          instanceId: claudeInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5-5",
        }),
        providerSnapshot({
          instanceId: cursorInstanceId,
          driver: ProviderDriverKind.make("cursor"),
          model: "cursor-model",
        }),
        providerSnapshot({
          instanceId: museInstanceId,
          driver: ProviderDriverKind.make("acpRegistry"),
          model: "muse-spark",
        }),
      ];
      const dispatched: Array<DelegatedRequest> = [];
      const tasks: Array<unknown> = [];
      const worktrees: Array<string> = [];
      const projectLookups = { count: 0 };
      const probes = { count: 0 };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? ({
                    ...parentProjection(tasks),
                    thread: {
                      ...parentProjection(tasks).thread,
                      worktreePath: options.worktreePath ?? null,
                    },
                  } as unknown as OrchestrationV2ThreadProjection)
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              const request = command as unknown as DelegatedRequest;
              const task = {
                id: IdAllocator.delegatedTaskNodeId({ commandId: request.commandId as never }),
                threadId: parentThreadId,
                runId: parentRunId,
                parentNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: request.modelSelection.instanceId,
                providerThreadId: null,
                childThreadId,
                nativeTaskRef: null,
                prompt: request.task,
                title: null,
                model: request.modelSelection.model,
                status: "running",
                result: null,
                startedAt: null,
                completedAt: null,
              };
              dispatched.push(request);
              tasks.push(task);
              return {
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never;
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          refreshInstance: () =>
            Effect.sync(() => {
              probes.count += 1;
              return providers;
            }),
        }),
        adapterRegistryLayer(providers.map((provider) => provider.instanceId)),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.sync(() => {
              projectLookups.count += 1;
              return Option.some({
                id: projectId,
                workspaceRoot: options.workspaceRoot ?? "/no/such/workspace",
              } as never);
            }),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const git = Layer.mock(GitWorkflowService.GitWorkflowService)({
        listRefs: () => Effect.succeed({ refs: [] } as never),
        localStatus: () => Effect.succeed({ refName: "main" } as never),
        createWorktree: (input) =>
          Effect.sync(() => {
            worktrees.push(String(input.newRefName));
            return {
              worktree: { refName: String(input.newRefName), path: "/future/worktree" },
            } as never;
          }),
      });
      const worktreeScope: McpInvocationScope = {
        ...scope,
        capabilities: new Set(["orchestration", "worktree"]),
      };
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          OrchestratorMcpService.OrchestratorMcpService | GitWorkflowService.GitWorkflowService
        >,
      ) =>
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              git,
              OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies)),
            ),
          ),
        );
      return { dispatched, worktrees, projectLookups, probes, worktreeScope, run };
    };

    const delegate = (
      scopeToUse: McpInvocationScope,
      input: Parameters<OrchestratorMcpService.OrchestratorMcpServiceShape["delegateTask"]>[1],
    ) =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.delegateTask(scopeToUse, input);
      });

    it.effect(
      "delivers the declared bytes, identity, and sentinel to the child prompt and leaves task, role, modes, and options alone",
      () =>
        Effect.gen(function* () {
          const harness = delegation({});
          const result = yield* harness.run(
            delegate(scope, {
              task: taskText,
              role: "review",
              mode: "async",
              clientRequestId: "rc-deliver",
              target: {
                providerInstanceId: museInstanceId,
                model: "muse-spark",
                options: [{ id: "profile", value: "muse-review" }],
              },
              requiredContext: [
                inline("skills/fee/SKILL.md", SENTINEL, {
                  revision: "git:5d16d577",
                  step: "step 2",
                }),
                inline("skills/fee/references/rates.md", RATES, { revision: "v2", step: "step 3" }),
              ],
            }),
          );
          assert.equal(result.status, "running");
          assert.equal(harness.dispatched.length, 1);
          const [request] = harness.dispatched;
          assert.equal(
            request!.task,
            [
              `Act as the review sub-agent for this task.\n\n${taskText}`,
              [
                "required_references:",
                "  - skills/fee/SKILL.md | inline | step 2",
                "  - skills/fee/references/rates.md | inline | step 3",
              ].join("\n"),
              `=== BEGIN REQUIRED CONTEXT kind=skill-entry uri=skills/fee/SKILL.md chars=${SENTINEL.length} sha256=${sha(SENTINEL)} revision=git:5d16d577 ===\n${SENTINEL}\n=== END REQUIRED CONTEXT uri=skills/fee/SKILL.md ===`,
              `=== BEGIN REQUIRED CONTEXT kind=reference uri=skills/fee/references/rates.md chars=${RATES.length} sha256=${sha(RATES)} revision=v2 ===\n${RATES}\n=== END REQUIRED CONTEXT uri=skills/fee/references/rates.md ===`,
            ].join("\n\n"),
          );
          // Nothing about the child's authority moved: a read-only profile stays
          // read-only, and the parent's modes are inherited, not tightened or widened.
          assert.deepEqual(request!.modelSelection, {
            instanceId: museInstanceId,
            model: "muse-spark",
            options: [{ id: "profile", value: "muse-review" }],
          });
          assert.equal(request!.runtimeMode, "full-access");
          assert.equal(request!.interactionMode, "default");
          assert.equal(harness.projectLookups.count, 0);
        }),
    );

    it.effect("leaves a task without requiredContext byte-for-byte as before", () =>
      Effect.gen(function* () {
        const harness = delegation({});
        yield* harness.run(
          Effect.gen(function* () {
            yield* delegate(scope, {
              task: taskText,
              mode: "async",
              clientRequestId: "rc-legacy-1",
            });
            yield* delegate(scope, {
              task: taskText,
              role: "research",
              mode: "async",
              clientRequestId: "rc-legacy-2",
            });
          }),
        );
        assert.deepEqual(
          harness.dispatched.map((request) => request.task),
          [taskText, `Act as the research sub-agent for this task.\n\n${taskText}`],
        );
        assert.equal(harness.projectLookups.count, 0);
      }),
    );

    it.effect("reads a path reference once from the project workspace and admits its bytes", () =>
      Effect.gen(function* () {
        const workspaceRoot = makeWorkspace({ "docs/rates.md": RATES });
        const harness = delegation({ workspaceRoot });
        yield* harness.run(
          delegate(scope, {
            task: taskText,
            mode: "async",
            clientRequestId: "rc-path",
            requiredContext: [byPath("docs/rates.md", RATES, { revision: "wt:abc" })],
          }),
        );
        assert.equal(harness.projectLookups.count, 1);
        assert.include(
          harness.dispatched[0]!.task,
          `=== BEGIN REQUIRED CONTEXT kind=reference uri=docs/rates.md chars=${RATES.length} sha256=${sha(RATES)} revision=wt:abc ===\n${RATES}\n=== END REQUIRED CONTEXT uri=docs/rates.md ===`,
        );
        assert.include(
          harness.dispatched[0]!.task,
          "required_references:\n  - docs/rates.md | path | step for docs/rates.md",
        );
      }),
    );

    it.effect("prefers the thread's bound worktree and never asks the project", () =>
      Effect.gen(function* () {
        const worktreePath = makeWorkspace({ "docs/rates.md": RATES });
        const harness = delegation({ worktreePath });
        yield* harness.run(
          delegate(scope, {
            task: taskText,
            mode: "async",
            clientRequestId: "rc-bound",
            requiredContext: [byPath("docs/rates.md", RATES)],
          }),
        );
        assert.equal(harness.projectLookups.count, 0);
        assert.equal(harness.dispatched.length, 1);
      }),
    );

    it.effect("does not reopen a path reference on a retry, even after the file is gone", () =>
      Effect.gen(function* () {
        const workspaceRoot = makeWorkspace({ "docs/rates.md": RATES });
        const harness = delegation({ workspaceRoot });
        const input = {
          task: taskText,
          mode: "async",
          clientRequestId: "rc-replay",
          requiredContext: [
            inline("skills/fee/SKILL.md", SENTINEL),
            byPath("docs/rates.md", RATES),
          ],
        } as const;
        yield* harness.run(
          Effect.gen(function* () {
            const first = yield* delegate(scope, input);
            NodeFS.rmSync(NodePath.join(workspaceRoot, "docs/rates.md"));
            const second = yield* delegate(scope, input);
            assert.equal(second.taskId, first.taskId);
          }),
        );
        assert.equal(harness.dispatched.length, 1);
        assert.equal(harness.projectLookups.count, 1);
      }),
    );

    it.effect("refuses a changed request that reuses a clientRequestId", () =>
      Effect.gen(function* () {
        const harness = delegation({});
        const base = {
          task: taskText,
          mode: "async",
          clientRequestId: "rc-conflict",
          requiredContext: [inline("skills/fee/SKILL.md", SENTINEL, { revision: "r1" })],
        } as const;
        const changed = SENTINEL.replace("42", "43");
        const attempts = {
          "one byte of content": {
            ...base,
            requiredContext: [inline("skills/fee/SKILL.md", changed, { revision: "r1" })],
          },
          "the revision": {
            ...base,
            requiredContext: [inline("skills/fee/SKILL.md", SENTINEL, { revision: "r2" })],
          },
          "the step": {
            ...base,
            requiredContext: [
              inline("skills/fee/SKILL.md", SENTINEL, { revision: "r1", step: "other" }),
            ],
          },
          "the task text": { ...base, task: `${taskText} Also tip.` },
          "an added reference": {
            ...base,
            requiredContext: [...base.requiredContext, inline("extra.md", "extra")],
          },
          "dropping the context": { task: taskText, mode: "async", clientRequestId: "rc-conflict" },
        } as const;
        yield* harness.run(
          Effect.gen(function* () {
            const first = yield* delegate(scope, base);
            for (const [name, attempt] of Object.entries(attempts)) {
              const error = yield* delegate(scope, attempt).pipe(Effect.flip);
              assert.equal(error.code, "invalid_request", name);
              assert.equal(
                error.message,
                `BLOCKED reference <declaration>: clientRequestId rc-conflict already started task ${first.taskId} with different task text or required context; use a new clientRequestId to deliver changed context`,
                name,
              );
            }
            // The identical request is still just a retry.
            assert.equal((yield* delegate(scope, base)).taskId, first.taskId);
          }),
        );
        assert.equal(harness.dispatched.length, 1);
      }),
    );

    it.effect("keeps today's retry behavior when neither request carries required context", () =>
      Effect.gen(function* () {
        const harness = delegation({});
        yield* harness.run(
          Effect.gen(function* () {
            const first = yield* delegate(scope, {
              task: taskText,
              mode: "async",
              clientRequestId: "rc-plain",
            });
            const second = yield* delegate(scope, {
              task: "A different task text.",
              mode: "async",
              clientRequestId: "rc-plain",
            });
            assert.equal(second.taskId, first.taskId);
          }),
        );
        assert.equal(harness.dispatched.length, 1);
      }),
    );

    it.effect(
      "finds the same task for an identical retry without a clientRequestId, and a new one for changed context",
      () =>
        Effect.gen(function* () {
          const harness = delegation({});
          const request = (content: string) =>
            ({
              task: taskText,
              mode: "async",
              requiredContext: [inline("skills/fee/SKILL.md", content)],
            }) as const;
          yield* harness.run(
            Effect.gen(function* () {
              const first = yield* delegate(scope, request(SENTINEL));
              assert.equal((yield* delegate(scope, request(SENTINEL))).taskId, first.taskId);
              assert.equal(harness.dispatched.length, 1);
              const changed = yield* delegate(scope, request(SENTINEL.replace("42", "43")));
              assert.notEqual(changed.taskId, first.taskId);
            }),
          );
          assert.equal(harness.dispatched.length, 2);
        }),
    );

    const refusals: ReadonlyArray<
      readonly [string, () => OrchestratorMcpRequiredContextEntry, string]
    > = [
      [
        "a missing path reference",
        () => byPath("docs/gone.md", "x"),
        "BLOCKED reference docs/gone.md: does not exist in this thread's workspace; deliver it inline",
      ],
      [
        "a hash mismatch",
        () => inline("a.md", "body text", { hash: sha("other text") }),
        `BLOCKED reference a.md: content hashes to ${sha("body text")} but hash declares ${sha("other text")}`,
      ],
      [
        "truncated inline content",
        () => inline("a.md", "body text", { length: 10 }),
        "BLOCKED reference a.md: content has 9 UTF-16 code units but length declares 10; it was truncated, altered, or the declaration is stale",
      ],
      [
        "a path that escapes the workspace",
        () => byPath("../escape.md", "x"),
        "BLOCKED reference ../escape.md: resolves outside this thread's workspace",
      ],
      [
        "a credential-shaped path",
        () => inline(".env", "SECRET=1"),
        "BLOCKED reference requiredContext[1]: path names a credential-shaped file",
      ],
    ];
    it.effect.each(refusals)(
      "refuses %s before any worktree, probe, or dispatch exists",
      ([name, entry, message]) =>
        Effect.gen(function* () {
          const workspaceRoot = makeWorkspace();
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(workspaceRoot), "escape.md"), "x");
          const harness = delegation({ workspaceRoot });
          const error = yield* harness
            .run(
              delegate(harness.worktreeScope, {
                task: taskText,
                mode: "async",
                clientRequestId: `rc-refuse-${name}`,
                workspace: { strategy: "worktree" },
                requiredContext: [inline("skills/fee/SKILL.md", SENTINEL), entry()],
              }),
            )
            .pipe(Effect.flip);
          assert.equal(error.code, "invalid_request");
          assert.equal(error.message, message);
          assert.deepEqual(harness.dispatched, []);
          assert.deepEqual(harness.worktrees, []);
          assert.equal(harness.probes.count, 0);
        }),
    );

    it.effect("prepares the worktree only after every reference verified", () =>
      Effect.gen(function* () {
        const workspaceRoot = makeWorkspace({ "docs/rates.md": RATES });
        const harness = delegation({ workspaceRoot });
        yield* harness.run(
          delegate(harness.worktreeScope, {
            task: taskText,
            mode: "async",
            clientRequestId: "rc-worktree",
            workspace: { strategy: "worktree", branch: "t3/required" },
            requiredContext: [byPath("docs/rates.md", RATES)],
          }),
        );
        assert.deepEqual(harness.worktrees, ["t3/required"]);
        assert.equal(harness.dispatched[0]!.workspaceBinding?.branch, "t3/required");
        assert.include(harness.dispatched[0]!.task, RATES);
      }),
    );

    it.effect("enforces the 64-reference and 120000-code-unit bounds", () =>
      Effect.gen(function* () {
        const harness = delegation({});
        const refs = (count: number) =>
          Array.from({ length: count }, (_, index) => inline(`r${index}.md`, "x"));
        const half = "x".repeat(60_000);
        const message = (requiredContext: ReadonlyArray<OrchestratorMcpRequiredContextEntry>) =>
          harness
            .run(
              delegate(scope, {
                task: taskText,
                mode: "async",
                clientRequestId: `rc-bounds-${requiredContext.length}-${requiredContext[0]?.path}`,
                requiredContext,
              }),
            )
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
        assert.equal(
          yield* message(refs(65)),
          "BLOCKED reference <declaration>: expected between 1 and 64 required references",
        );
        assert.equal(
          yield* message([inline("a.md", half), inline("b.md", `${half}y`)]),
          "BLOCKED reference <declaration>: required context totals 120001 UTF-16 code units, over the 120000 limit; nothing was truncated",
        );
        assert.equal(
          yield* message([inline("a.md", "x"), inline("a.md", "x")]),
          "BLOCKED reference a.md: duplicate required reference declaration",
        );
        assert.deepEqual(harness.dispatched, []);
        yield* harness.run(
          delegate(scope, {
            task: taskText,
            mode: "async",
            clientRequestId: "rc-bounds-exact",
            requiredContext: [inline("a.md", half), inline("b.md", half)],
          }),
        );
        assert.equal(harness.dispatched.length, 1);
      }),
    );

    it.effect("refuses task text that already declares required_references", () =>
      Effect.gen(function* () {
        const harness = delegation({});
        const error = yield* harness
          .run(
            delegate(scope, {
              task: `root_owner: codex:1\nrequired_references: none\ngoal: ${taskText}`,
              mode: "async",
              clientRequestId: "rc-double",
              requiredContext: [inline("a.md", "body")],
            }),
          )
          .pipe(Effect.flip);
        assert.include(
          error.message,
          "BLOCKED reference <declaration>: the task text already declares required_references",
        );
        assert.deepEqual(harness.dispatched, []);
      }),
    );

    it.effect("refuses skill-shaped tokens only for drivers whose adapter would rewrite them", () =>
      Effect.gen(function* () {
        const dollar = "Use $fee-check before selecting a value.\n";
        const euro = "Use €fee-check before selecting a value.\n";
        const harness = delegation({});
        const attempt = (instanceId: ProviderInstanceId, model: string, content: string) =>
          harness
            .run(
              delegate(scope, {
                task: taskText,
                mode: "async",
                clientRequestId: `rc-skill-${instanceId}-${sha(content).slice(0, 6)}`,
                target: { providerInstanceId: instanceId, model },
                requiredContext: [inline("a.md", content)],
              }),
            )
            .pipe(Effect.exit);
        const blocked = (
          exit: Awaited<ReturnType<typeof Effect.runPromiseExit<unknown, unknown>>>,
        ) => (exit._tag === "Failure" ? String(exit.cause) : "");

        assert.include(
          blocked(yield* attempt(cursorInstanceId, "cursor-model", dollar)),
          "the skill-shaped token '$fee-check', which the cursor adapter rewrites",
        );
        assert.include(
          blocked(yield* attempt(codexInstanceId, "gpt-5.4", euro)),
          "the skill-shaped token '€fee-check', which the codex adapter rewrites",
        );
        assert.deepEqual(harness.dispatched, []);
        // Claude leaves a required-context fence alone (ClaudeSkillDispatch), Codex keeps `$`,
        // and a non-rewriting driver sends everything as is.
        assert.equal((yield* attempt(claudeInstanceId, "claude-opus-5-5", dollar))._tag, "Success");
        assert.equal((yield* attempt(codexInstanceId, "gpt-5.4", dollar))._tag, "Success");
        assert.equal((yield* attempt(museInstanceId, "muse-spark", euro))._tag, "Success");
        assert.equal(harness.dispatched.length, 3);
      }),
    );
  });
});
