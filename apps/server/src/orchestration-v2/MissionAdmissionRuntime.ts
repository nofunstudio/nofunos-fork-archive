import {
  type CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestratorMcpDelegateTaskInput,
  type NodeId,
  MissionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as McpScope from "../mcp/McpInvocationContext.ts";
import * as McpAuthority from "../mcp/MissionMcpService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as MuseUsage from "../nofun/MuseUsage.ts";
import * as Configuration from "./MissionAdmissionConfiguration.ts";
import * as Facts from "./MissionAdmissionFacts.ts";
import * as Store from "./MissionAdmissionStore.ts";
import * as Missions from "./MissionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { dispatchKeyFor } from "./MissionAdmission.ts";
import { missionBoundCommandId } from "./EventSink.ts";
import { delegatedTaskNodeId } from "./IdAllocator.ts";

type Delegation = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "delegated_task.request" }
>;

/** Request-scoped admission over the real server runtime; never a second orchestrator. */
export class MissionAdmissionRuntime extends Context.Service<
  MissionAdmissionRuntime,
  {
    readonly dispatch: (
      scope: McpScope.McpThreadInvocationScope,
      selector: NonNullable<OrchestratorMcpDelegateTaskInput["mission"]>,
      command: Delegation,
    ) => Effect.Effect<
      {
        readonly commandId: CommandId;
        readonly taskId: NodeId;
        readonly result: Orchestrator.OrchestratorV2DispatchResult;
      },
      Orchestrator.OrchestratorDispatchError
    >;
  }
>()("t3/orchestration-v2/MissionAdmissionRuntime") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const configuration = yield* Configuration.MissionAdmissionConfiguration;
  const providers = yield* Providers.ProviderRegistry;
  const museUsage = yield* Effect.serviceOption(MuseUsage.MuseUsage);
  // The policy resolver is optional only so the server can boot unconfigured.
  // There is no authority fallback for a mission request.
  const resolver = yield* Effect.serviceOption(McpAuthority.MissionMcpAuthorityPort);
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Events.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  return MissionAdmissionRuntime.of({
    dispatch: (caller, selector, proposal) =>
      Effect.gen(function* () {
        const command = structuredClone(proposal);
        const selected = structuredClone(selector);
        const scope = {
          ...caller,
          thread: { ...caller.thread },
          capabilities: new Set(caller.capabilities),
        };
        const rejected = () =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Mission admission authority or canonical facts are unavailable.",
          });
        // No worktree may have been prepared by this binding. A dedicated
        // admitted workspace lifecycle is required before accepting that shape.
        if (
          Option.isNone(resolver) ||
          command.parentThreadId !== scope.thread.threadId ||
          command.workspaceBinding !== undefined
        )
          return yield* rejected();
        const requestKey = {};
        const facts = yield* resolver.value
          .resolve({
            scope,
            operation: "read",
            missionId: MissionId.make(selected.missionId),
            requestKey,
          })
          .pipe(Effect.mapError(rejected));
        if (
          facts.transactionGuard === undefined ||
          facts.company !== "nofun" ||
          facts.companyVerified !== true ||
          facts.bindingVerified !== true ||
          facts.environmentId !== scope.environmentId ||
          facts.controllerThreadId !== scope.thread.threadId
        )
          return yield* rejected();
        const authority: Missions.MissionAuthority["Service"] = {
          teamId: facts.teamId,
          environmentId: facts.environmentId,
          controllerThreadId: facts.controllerThreadId,
          company: "No Fun",
          transactionGuard: facts.transactionGuard,
          requestKey,
        };
        const base = Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(Events.OrchestrationEventStore, events),
          Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, receipts),
          Layer.succeed(Missions.MissionAuthority, authority),
          Layer.succeed(Providers.ProviderRegistry, providers),
          // Preserve the same passive subscription source as capabilities.
          // A fresh request layer must not lose Muse's account-bound usage.
          Option.isSome(museUsage)
            ? Layer.succeed(MuseUsage.MuseUsage, museUsage.value)
            : Layer.empty,
          Layer.succeed(Configuration.MissionAdmissionConfiguration, configuration),
        );
        const missions = yield* Missions.MissionService.pipe(
          Effect.provide(Missions.layer.pipe(Layer.provide(base))),
        );
        const mission = Option.getOrUndefined(
          yield* missions.get(MissionId.make(selected.missionId)).pipe(Effect.mapError(rejected)),
        );
        const task = mission?.tasks.find((task) => task.id === selected.taskId);
        if (mission === undefined || task === undefined || command.modelSelection === undefined)
          return yield* rejected();
        const binding = mission.bindings.find((binding) => binding.projectId === task.projectId);
        if (binding === undefined) return yield* rejected();
        const observation = yield* configuration.read(authority).pipe(Effect.mapError(rejected));
        const attestations = observation.providers.filter(
          (provider) => provider.instanceId === command.modelSelection!.instanceId,
        );
        if (attestations.length !== 1) return yield* rejected();
        const attestation = attestations[0]!;
        const profiles =
          command.modelSelection.options?.filter((option) => option.id === "profile") ?? [];
        if (
          profiles.length > 1 ||
          (profiles.length === 1 && typeof profiles[0]!.value !== "string")
        )
          return yield* rejected();
        const profile = profiles.length === 0 ? "default" : String(profiles[0]!.value);
        const dispatchKey = dispatchKeyFor({
          teamId: authority.teamId,
          environmentId: authority.environmentId,
          missionId: mission.id,
          taskId: task.id,
          ...selected.attemptKey,
        });
        const commandId = missionBoundCommandId({
          dispatchKey,
          threadId: command.parentThreadId,
          commandType: command.type,
        });
        const store = yield* Store.MissionAdmissionStore.pipe(
          Effect.provide(
            Store.layer.pipe(
              Layer.provide(Facts.layer.pipe(Layer.provide(base))),
              Layer.provide(base),
            ),
          ),
        );
        const result = yield* threads
          .dispatch(command, {
            missionAdmissionRequest: {
              mission,
              taskId: task.id,
              specHash: task.specHash,
              dependencyHashes: [...task.dependencyHashes],
              attempt: selected.attemptKey,
              proposedAccountId: attestation.accountId,
              proposedProviderInstanceId: command.modelSelection.instanceId,
              proposedBillingMode: attestation.billingMode,
              modelId: command.modelSelection.model,
              profile,
              // ThreadManagement replaces these placeholders with hashes of the actual
              // encoded command/runtime before the store can prepare or reserve it.
              promptHash: "unbound",
              optionsHash: "unbound",
              workspaceRoot: binding.workspaceRoot,
              privilege: command.runtimeMode,
              rejectedRoutes: [],
            },
          })
          .pipe(
            Effect.provideService(Store.MissionAdmissionStore, store),
            Effect.mapError(rejected),
          );
        return { commandId, taskId: delegatedTaskNodeId({ commandId }), result };
      }),
  });
});

export const layer = Layer.effect(MissionAdmissionRuntime, make);
