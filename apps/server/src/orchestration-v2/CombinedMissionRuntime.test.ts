// @effect-diagnostics nodeBuiltinImport:off -- offline executor fixture and independent artifact digests.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  Mission,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as ServerConfig from "../config.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as MissionMcpRuntime from "../mcp/MissionMcpRuntime.ts";
import * as MissionMcpAuthority from "../mcp/MissionMcpAuthority.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Combined from "./CombinedMissionRuntime.ts";
import { emptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as Runner from "./MissionRetroReplayRunner.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { withActualReportHash } from "./MissionRetroReportReconciliation.ts";
import { commitArtifactBytes } from "./MissionRetroReportArtifacts.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

const envId = EnvironmentId.make("env-startup");
const projectId = ProjectId.make("project-startup");
const delivery = ThreadId.make("delivery");
const retro = ThreadId.make("retro");
const successor = ThreadId.make("successor");
const worker = ThreadId.make("worker");
const modelSelection = {
  instanceId: ProviderInstanceId.make("offline-codex"),
  model: "offline-fixture",
};
const now = "2026-10-14T12:00:00.000Z";
const digest = "a".repeat(64);
const decodeMission = Schema.decodeUnknownSync(Mission);
const encodeMission = Schema.encodeSync(Schema.fromJsonString(Mission));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMissionJson = Schema.decodeUnknownSync(Schema.fromJsonString(Mission));
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const milestone = (name: string, revision: number) => ({
  commandId: name,
  evidenceDigest: digest,
  revision,
  confirmedAt: now,
});
const reservation = (routed = false) => ({
  reservationId: "reservation",
  successorThreadId: successor,
  role: "delivery",
  currentThreadId: delivery,
  currentEpoch: 3,
  observedRevision: 0,
  timezone: "America/New_York",
  localDate: "2026-10-14",
  ordinal: 0,
  reason: "first_slot",
  artifactRef: `manager-handoff:${digest}`,
  artifactSha256: digest,
  commandId: "reserve",
  requestDigest: digest,
  reservedAt: now,
  ...(routed
    ? {
        lifecycle: {
          state: "routing_confirmed",
          standby: milestone("standby", 2),
          quiesce: milestone("quiesce", 3),
          transfer: { ...milestone("transfer", 4), previousEpoch: 3, newEpoch: 4 },
          routing: { ...milestone("routing", 5), epoch: 4 },
        },
      }
    : {}),
});
const mission = (routed = false) =>
  decodeMission({
    schemaVersion: 1,
    id: "mission",
    revision: 0,
    teamId: "nofun-team",
    authorityEnvironmentId: envId,
    projectTimezone: "America/New_York",
    bindings: [
      {
        projectId,
        workspaceRoot: process.cwd(),
        baseCommit: "a".repeat(40),
        ancestry: ["a".repeat(40)],
      },
    ],
    intent: {
      outcome: "Offline composition",
      scope: ["startup"],
      exclusions: [],
      authorityRefs: [{ source: "mission-council", ref: "offline" }],
      acceptanceCriteria: [{ id: "ac", text: "Compose real cores" }],
      decisions: [],
    },
    integrationTarget: { summary: "Offline" },
    managers: {
      delivery: { threadId: routed ? successor : delivery, epoch: routed ? 4 : 3 },
      retro: { threadId: retro, epoch: 2 },
    },
    status: "active",
    tasks: [],
    execution: { ...emptyMissionExecution(), managerReservations: [reservation(routed)] },
    updatedAt: now,
  });

const withHarness = <A, E, R>(
  options: { policy?: boolean; config?: "invalid" | "configured"; catches?: boolean },
  use: (h: {
    replayProbe: { spawned: number; afterExit: Effect.Effect<void> };
    opened: string[];
    closed: string[];
    seed: (
      routed?: boolean,
    ) => Effect.Effect<
      void,
      never,
      Orchestrator.OrchestratorV2 | Projects.ProjectStoreV2 | SqlClient.SqlClient
    >;
    issue: (
      id: ThreadId,
    ) => Effect.Effect<
      import("../mcp/McpInvocationContext.ts").McpThreadInvocationScope,
      never,
      McpSessionRegistry.McpSessionRegistry
    >;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "combined-startup-" });
      const policyFile = path.join(root, "policy.json");
      const configFile = path.join(root, "config.json");
      const settings: Record<string, string> = {};
      if (options.policy !== false) {
        yield* fs.writeFileString(
          policyFile,
          encodeJson({
            company: "nofun",
            companyVerified: true,
            bindingVerified: true,
            policyRef: "offline-policy",
            teamId: "nofun-team",
            environmentId: envId,
            allowedProjectIds: [projectId],
            bootstrapControllerThreadIds: [delivery],
          }),
        );
        yield* fs.chmod(policyFile, 0o600);
        settings.T3CODE_NOFUN_MISSION_POLICY_FILE = policyFile;
      }
      if (options.config === "invalid") {
        yield* fs.writeFileString(configFile, "{}");
        yield* fs.chmod(configFile, 0o600);
        settings.T3CODE_NOFUN_COMBINED_MISSION_CONFIG_FILE = configFile;
      }
      let replayReceipt: unknown;
      if (options.config === "configured") {
        const script = path.join(root, "executor.mjs");
        yield* fs.writeFileString(
          script,
          `import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const dir = process.env.NOFUN_REPLAY_SKILL_DIR;
const input = fs.readFileSync(path.join(process.env.NOFUN_REPLAY_INPUT_DIR, 'task.txt'), 'utf8');
const bytes = input === 'negative' ? Buffer.from('') : fs.readFileSync(path.join(dir, 'SKILL.md'));
const answer = input === 'failure' && !bytes.toString().includes('FIXED') ? 'old failure' : input.split('').reverse().join('') + '-expected';
fs.writeFileSync(path.join(process.env.NOFUN_REPLAY_OUT_DIR, "result.json"), JSON.stringify({completed:true, answer, skillReads:input === 'negative' ? [] : [{path:'SKILL.md', sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]}));`,
        );
        const snapshots = { old: path.join(root, "old"), new: path.join(root, "new") };
        for (const [side, dir] of Object.entries(snapshots)) {
          yield* fs.makeDirectory(dir);
          yield* fs.writeFileString(
            path.join(dir, "SKILL.md"),
            side === "old" ? "# Offline skill" : "# Offline skill FIXED",
          );
        }
        const fixtures = {
          failure: path.join(root, "failure"),
          positive: path.join(root, "positive"),
          negative: path.join(root, "negative"),
        };
        for (const [kind, dir] of Object.entries(fixtures)) {
          yield* fs.makeDirectory(path.join(dir, "input"), { recursive: true });
          yield* fs.writeFileString(path.join(dir, "input", "task.txt"), kind);
          yield* fs.writeFileString(
            path.join(dir, "spec.json"),
            encodeJson({
              fixtureId: kind,
              expect: {
                mustContain: [kind.split("").toReversed().join("") + "-expected"],
                mustNotContain: [],
              },
              allowedSkillLoads: ["SKILL.md"],
            }),
          );
        }
        const report = withActualReportHash({
          checkpointId: "checkpoint",
          teamId: "nofun-team",
          environmentId: envId,
          missionId: "mission",
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: digest,
          coveredFromInclusive: 1,
          coveredToExclusive: 2,
          reporterChildThreadId: "reporter",
          reporterRunId: "report-run",
          reportRevision: 1,
          assignmentToken: digest,
          managerEpoch: 2,
          model: "muse-spark-1.3",
          profile: "muse-review",
          sourceRefs: [],
          claimedReadRefs: [],
          summary: "Offline report fixture",
          verdict: "candidates",
          shortlist: [
            {
              candidateId: "candidate",
              concernId: "concern",
              incidentRefs: ["incident"],
              summary: "Fixture candidate",
              destinationOwner: "project_guidance",
              alreadyFixed: false,
            },
          ],
          incidents: [],
          skillEvidence: [],
          omissions: [],
        });
        const bytes = stableStringify(report);
        const reportRoot = path.join(root, "reports");
        yield* commitArtifactBytes({
          artifactDirectory: reportRoot,
          namespace: "retro-normalized",
          sha: report.reportHash,
          bytes: Buffer.from(bytes),
        });
        replayReceipt = {
          checkpointId: "checkpoint",
          teamId: "nofun-team",
          environmentId: envId,
          missionId: "mission",
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: digest,
          coveredFromInclusive: 1,
          coveredToExclusive: 2,
          reporterChildThreadId: "reporter",
          reporterRunId: "report-run",
          assignmentToken: digest,
          fence: 1,
          attemptNumber: 1,
          reportRevision: 1,
          accountId: "offline",
          providerInstanceId: "muse-personal",
          modelId: "muse-spark-1.3",
          profile: "muse-review",
          company: "No Fun",
          originalArtifactRef: "retro-original:offline",
          originalArtifactSha: sha(bytes),
          claimedSourceReportHash: report.reportHash,
          sourceReportHash: report.reportHash,
          normalizedArtifactRef: `retro-normalized:${report.reportHash}`,
          normalizedArtifactSha: sha(bytes),
          coverageEvidenceRef: "retro-coverage:offline",
          coverageEvidenceSha: digest,
          normalizedReportHash: report.reportHash,
          verdict: "candidates",
          disposition: "queued_for_triage",
          coverageFull: true,
          coverageReasonRefs: [],
          incidentCount: 0,
          shortlistCount: 1,
          incidentArtifactRef: "retro-normalized:offline",
          receivedAt: now,
          quarantine: [],
        };
        const runnerConfig: Runner.MissionRetroReplayRunnerConfig = {
          executor: {
            kind: "deterministic_executable",
            executable: process.execPath,
            args: [script],
            pinnedFiles: [script],
            timeoutMs: 30000,
          },
          reviewerId: "reviewer-independent",
          sandboxRoot: path.join(root, "sandboxes"),
          artifactDirectory: path.join(root, "artifacts"),
          repeatCount: 1,
        };
        const approvedConfigDigest = yield* Effect.gen(function* () {
          return yield* (yield* Runner.MissionRetroReplayRunner).configDigest;
        }).pipe(Effect.provide(Runner.layer(runnerConfig)));
        yield* fs.writeFileString(
          configFile,
          encodeJson({
            runner: runnerConfig,
            approvedConfigDigest,
            reportArtifactDirectory: reportRoot,
            plans: {
              plan: {
                missionId: "mission",
                candidateId: "candidate",
                targetSkillRef: "skills/offline/SKILL.md",
                sourceReportHash: report.reportHash,
                authorId: "candidate-author",
                targetOwnership: "owned",
                candidateClaim: {
                  candidateId: "candidate",
                  targetSkillRef: "skills/offline/SKILL.md",
                  sourceReportHash: report.reportHash,
                  claimedPass: true,
                },
                snapshots,
                fixtures,
              },
            },
          }),
        );
        yield* fs.chmod(configFile, 0o600);
        settings.T3CODE_NOFUN_COMBINED_MISSION_CONFIG_FILE = configFile;
      }
      const opened: string[] = [],
        closed: string[] = [];
      const driver = ProviderDriverKind.make("codex");
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        sessions: {
          ...CodexProviderCapabilitiesV2.sessions,
          supportsMultipleProviderThreadsPerSession: false,
        },
      };
      const adapter = {
        instanceId: modelSelection.instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: (input: Parameters<ProviderAdapterV2Shape["openSession"]>[0]) =>
          Effect.gen(function* () {
            opened.push(input.providerSessionId);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed.push(input.providerSessionId);
              }),
            );
            const date = yield* DateTime.now;
            return {
              instanceId: modelSelection.instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: modelSelection.instanceId,
                status: "ready" as const,
                cwd: root,
                model: modelSelection.model,
                capabilities,
                createdAt: date,
                updatedAt: date,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: () => Effect.die("no provider child in this test"),
              resumeThread: (i: Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0]) =>
                Effect.succeed(i.providerThread),
              startTurn: () => Effect.die("no provider child in this test"),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            } satisfies ProviderAdapterV2SessionRuntime;
          }),
      } as ProviderAdapterV2Shape;
      const instance = {
        instanceId: modelSelection.instanceId,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: "offline" },
        displayName: "Offline",
        enabled: true,
        snapshot: { getSnapshot: Effect.succeed({}) },
        orchestrationAdapter: adapter,
        textGeneration: {},
      } as unknown as ProviderInstance;
      const providerRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const configLayer = ServerConfig.layerTest(root, { prefix: "combined-state-" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayProbe = { spawned: 0, afterExit: Effect.void };
      const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (command) =>
        Effect.gen(function* () {
          replayProbe.spawned++;
          const child = yield* spawner.spawn(command);
          const exitCode = child.exitCode.pipe(Effect.tap(() => replayProbe.afterExit));
          return new Proxy(child, {
            get: (target, key, receiver) =>
              key === "exitCode" ? exitCode : Reflect.get(target, key, receiver),
          });
        });
      const platform = Layer.mergeAll(
        NodeServices.layer,
        // These tests drive requests directly. Park background reconciliation so
        // the seeded pending reservation cannot advance the revision mid-replay.
        Layer.succeed(ServerActivation, Effect.never),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("unused"),
        }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, { ...spawner, spawn }),
      );
      const vcs = VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provide(configLayer),
        Layer.provide(platform),
      );
      const infrastructure = Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        ProviderRegistryMock.layer(),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
          peek: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          invalidate: () => Effect.void,
        }),
        Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: (x) => Effect.succeed(x),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree: () => Effect.succeed({} as never),
        }),
        CheckpointStore.layer.pipe(Layer.provide(vcs)),
        ServerSettings.layerTest(),
        providerRegistry,
      );
      const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(envId),
        getDescriptor: Effect.die("unused"),
      });
      const registry = McpSessionRegistry.layer.pipe(
        Layer.provide(environment),
        Layer.provide(
          Layer.succeed(HttpServer.HttpServer, {
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43131),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      const live = MissionMcpRuntime.layerCombined.pipe(
        Layer.provideMerge(RuntimeLayer.layerProduction),
        Layer.provideMerge(Projects.layer),
        Layer.provideMerge(Projections.layer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(infrastructure),
        Layer.provideMerge(registry),
        Layer.provide(environment),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(configLayer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: settings }))),
        Layer.provide(
          Layer.succeed(
            HostProcessEnvironment,
            options.catches ? { T3CODE_PERSONA: "catches" } : {},
          ),
        ),
        Layer.provide(platform),
      );
      const seed = (routed = false) =>
        Effect.gen(function* () {
          const projects = yield* Projects.ProjectStoreV2;
          yield* projects.apply({
            sequence: 0,
            eventId: EventId.make("project-seed"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Offline",
              workspaceRoot: process.cwd(),
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (const id of [delivery, retro, worker, ...(routed ? [successor] : [])])
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`create-${id}`),
              threadId: id,
              projectId,
              title: id,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
          const sql = yield* SqlClient.SqlClient;
          const fixture = mission(routed);
          const snapshot = encodeMission(
            replayReceipt === undefined
              ? fixture
              : decodeMission({
                  ...fixture,
                  execution: { ...fixture.execution, retroReportReceipts: [replayReceipt] },
                }),
          );
          yield* sql`INSERT INTO projection_missions (mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at) VALUES ('mission', 'nofun-team', ${envId}, 0, ${snapshot}, ${now})`;
        });
      const safeSeed = (routed = false) => seed(routed).pipe(Effect.orDie);
      const issue = (id: ThreadId) =>
        Effect.gen(function* () {
          const r = yield* McpSessionRegistry.McpSessionRegistry;
          const issued = yield* r.issue({
            threadId: id,
            providerInstanceId: modelSelection.instanceId,
          });
          return (yield* r.resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, "")))!;
        });
      return yield* use({ opened, closed, seed: safeSeed, issue, replayProbe }).pipe(
        Effect.provide(live),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("production startup creates no child; missing replay config refuses finitely", () =>
  withHarness({}, (h) =>
    Effect.gen(function* () {
      const runtime = yield* Combined.CombinedMissionRuntime;
      assert.deepEqual(yield* runtime.status, { authority: "available", replay: "unconfigured" });
      assert.deepEqual(h.opened, []);
      yield* h.seed();
      const scope = yield* h.issue(retro);
      const result = yield* runtime
        .withRequest(scope, { missionId: "mission", role: "retro" }, (r) =>
          r.replayAndRecord({
            commandId: CommandId.make("replay"),
            expectedRevision: 0,
            evaluationId: "evaluation",
            planId: "plan",
          }),
        )
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(
          result.failure._tag === "CombinedMissionRuntimeError" && result.failure.code,
          "replay_unconfigured",
        );
      assert.deepEqual(h.opened, []);
      assert.deepEqual(h.closed, []);
    }),
  ),
);

it.effect("absent policy and rejected config leave production runtime operational", () =>
  withHarness({ policy: false, config: "invalid" }, (h) =>
    Effect.gen(function* () {
      const runtime = yield* Combined.CombinedMissionRuntime;
      assert.deepEqual(yield* runtime.status, {
        authority: "authority_unavailable",
        replay: "unconfigured",
      });
      yield* h.seed();
      const scope = yield* h.issue(delivery);
      const refusal = yield* runtime
        .withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
          r.launchStandby("reservation"),
        )
        .pipe(Effect.result);
      assert.equal(refusal._tag, "Failure");
      if (refusal._tag === "Failure")
        assert.equal(
          refusal.failure._tag === "CombinedMissionRuntimeError" && refusal.failure.code,
          "authority_unavailable",
        );
    }),
  ),
);

it.effect(
  "standby uses the production launch; missing boundary holds; request capabilities expire",
  () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        const scope = yield* h.issue(delivery);
        const escaped = yield* runtime.withRequest(
          scope,
          { missionId: "mission", role: "delivery" },
          (r) =>
            Effect.gen(function* () {
              const standby = yield* r.launchStandby("reservation");
              assert.equal(standby.kind, "standby");
              const facts = yield* r.readLifecycleFacts("reservation", "quiesce");
              assert.isNull(facts.quiesce);
              const ready = yield* r.advance({
                commandId: CommandId.make("standby"),
                expectedRevision: 0,
                reservationId: "reservation",
                step: "standby",
              });
              assert.equal(ready._tag, "Success");
              const held = yield* r.advance({
                commandId: CommandId.make("quiesce"),
                expectedRevision: 1,
                reservationId: "reservation",
                step: "quiesce",
              });
              assert.equal(held._tag, "Failure");
              if (held._tag === "Failure") assert.equal(held.failure.code, "facts_unknown");
              return r;
            }),
        );
        const expired = yield* escaped
          .readLifecycleFacts("reservation", "standby")
          .pipe(Effect.result);
        assert.equal(expired._tag, "Failure");
        assert.deepEqual(h.opened, []);
      }),
    ),
);

it.effect("cleanup observes the real production session manager and preserves workers", () =>
  withHarness({}, (h) =>
    Effect.gen(function* () {
      yield* h.seed(true);
      const sessions = yield* Sessions.ProviderSessionManagerV2;
      for (const id of [delivery, worker])
        yield* sessions.open({
          threadId: id,
          providerSessionId: ProviderSessionId.make(`session-${id}`),
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
      const runtime = yield* Combined.CombinedMissionRuntime;
      const scope = yield* h.issue(successor);
      yield* runtime.withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
        Effect.gen(function* () {
          const before = yield* r.readLifecycleFacts("reservation", "retire");
          assert.isFalse(before.cleanup?.providerSession.released);
          const cleanup = yield* r.cleanupIncumbent("reservation");
          assert.equal(cleanup.kind, "released");
          assert.isTrue(
            Option.isNone(yield* sessions.get(ProviderSessionId.make("session-delivery"))),
          );
          assert.isTrue(
            Option.isSome(yield* sessions.get(ProviderSessionId.make("session-worker"))),
          );
        }),
      );
      assert.deepEqual(h.closed, ["session-delivery"]);
    }),
  ),
);

it.live(
  "configured startup invokes the real replay, artifact producer and recorder on shared SQLite",
  () =>
    withHarness({ config: "configured" }, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        assert.deepEqual(yield* runtime.status, { authority: "available", replay: "configured" });
        const scope = yield* h.issue(retro);
        const outcome = yield* runtime.withRequest(
          scope,
          { missionId: "mission", role: "retro" },
          (r) =>
            r.replayAndRecord({
              commandId: CommandId.make("replay"),
              expectedRevision: 0,
              evaluationId: "evaluation",
              planId: "plan",
            }),
        );
        assert.equal(outcome._tag, "Success");
        if (outcome._tag === "Success") {
          assert.equal(outcome.success.record.kind, "review_ready", outcome.success.record.reason);
          assert.isTrue(outcome.success.committed);
        }
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          revision: number;
          snapshot_json: string;
        }>`SELECT revision, snapshot_json FROM projection_missions WHERE mission_id = 'mission'`;
        assert.equal(rows[0]?.revision, 1);
        const saved = decodeMissionJson(rows[0]!.snapshot_json);
        assert.equal(saved.execution?.retroSkillEvaluations?.length, 1);
        const retry = yield* runtime.withRequest(
          scope,
          { missionId: "mission", role: "retro" },
          (r) =>
            r.replayAndRecord({
              commandId: CommandId.make("replay"),
              expectedRevision: 0,
              evaluationId: "evaluation",
              planId: "plan",
            }),
        );
        assert.equal(retry._tag, "Success");
        if (retry._tag === "Success") assert.isFalse(retry.success.committed);
        assert.equal(h.replayProbe.spawned, 6);
        assert.deepEqual(h.opened, []);
      }),
    ),
);

it.effect.each(["paused", "stopped"] as const)(
  "canonical %s mission refuses before any replay or provider action",
  (status) =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeMission(decodeMission({ ...mission(), status }))} WHERE mission_id = 'mission'`;
        const runtime = yield* Combined.CombinedMissionRuntime;
        for (const [thread, role] of [
          [delivery, "delivery"],
          [retro, "retro"],
        ] as const) {
          const scope = yield* h.issue(thread);
          const result = yield* runtime
            .withRequest(scope, { missionId: "mission", role }, (r) =>
              role === "retro"
                ? r
                    .replayAndRecord({
                      commandId: CommandId.make("no-run"),
                      expectedRevision: 0,
                      evaluationId: "no-eval",
                      planId: "plan",
                    })
                    .pipe(Effect.asVoid)
                : r.launchStandby("reservation").pipe(Effect.asVoid),
            )
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(
              result.failure._tag === "CombinedMissionRuntimeError" && result.failure.code,
              "mission_inactive",
            );
        }
        assert.deepEqual(h.opened, []);
        assert.deepEqual(h.closed, []);
      }),
    ),
);

it.effect("a later caller uses its own role; wake with changed expected owner stays held", () =>
  withHarness({}, (h) =>
    Effect.gen(function* () {
      yield* h.seed();
      const runtime = yield* Combined.CombinedMissionRuntime;
      const d = yield* h.issue(delivery);
      const r = yield* h.issue(retro);
      yield* runtime.withRequest(d, { missionId: "mission", role: "delivery" }, (c) =>
        c.readLifecycleFacts("reservation", "quiesce"),
      );
      const wrong = yield* runtime
        .withRequest(r, { missionId: "mission", role: "delivery" }, () => Effect.void)
        .pipe(Effect.result);
      assert.equal(wrong._tag, "Failure");
      const own = yield* runtime.withRequest(r, { missionId: "mission", role: "retro" }, (c) =>
        c.wakeCurrentRole({
          wakeKey: "stale",
          instruction: "offline",
          expectedOwner: { threadId: delivery, epoch: 3 },
        }),
      );
      assert.deepEqual(own, { kind: "hold", code: "owner_changed" });
      assert.deepEqual(h.opened, []);
    }),
  ),
);

it.effect(
  "policy revocation after facts capture invalidates this request on the exact shared policy",
  () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        const scope = yield* h.issue(delivery);
        const policy = yield* MissionMcpAuthority.MissionMcpTrustedPolicy;
        const original = policy.current;
        yield* runtime.withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
          Effect.gen(function* () {
            yield* r.readLifecycleFacts("reservation", "quiesce");
            // Test-only revocation of the same private policy instance all cores consume.
            Object.defineProperty(policy, "current", {
              configurable: true,
              value: () => ({ enabled: false }),
            });
            const denied = yield* r
              .advance({
                commandId: CommandId.make("revoked"),
                expectedRevision: 0,
                reservationId: "reservation",
                step: "standby",
              })
              .pipe(Effect.result);
            assert.equal(denied._tag, "Failure");
            Object.defineProperty(policy, "current", { configurable: true, value: original });
          }),
        );
        assert.deepEqual(h.opened, []);
      }),
    ),
);

it.effect(
  "canonical epoch drift and registry revocation after facts capture refuse further actions",
  () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        const scope = yield* h.issue(delivery);
        const sql = yield* SqlClient.SqlClient;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        yield* runtime
          .withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
            Effect.gen(function* () {
              yield* r.readLifecycleFacts("reservation", "quiesce");
              const changed = mission();
              yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeMission(decodeMission({ ...changed, managers: { ...changed.managers, delivery: { threadId: delivery, epoch: 4 } } }))} WHERE mission_id = 'mission'`;
              assert.equal(
                (yield* r.launchStandby("reservation").pipe(Effect.result))._tag,
                "Failure",
              );
              yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeMission(changed)} WHERE mission_id = 'mission'`;
              yield* registry.revokeThread(delivery);
              assert.equal(
                (yield* r.launchStandby("reservation").pipe(Effect.result))._tag,
                "Failure",
              );
            }),
          )
          .pipe(
            Effect.result,
            Effect.tap((result) => Effect.sync(() => assert.equal(result._tag, "Failure"))),
          );
        assert.deepEqual(h.opened, []);
      }),
    ),
);

it.effect.each(["policy", "credential"] as const)(
  "%s revocation after the actual lifecycle event append rolls back event, CAS and receipt",
  (revoke) =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const policy = yield* MissionMcpAuthority.MissionMcpTrustedPolicy;
        const events = yield* Events.OrchestrationEventStore;
        const scope = yield* h.issue(delivery);
        const sql = yield* SqlClient.SqlClient;
        const counts = sql<{
          events: number;
          receipts: number;
          revision: number;
        }>`SELECT (SELECT COUNT(*) FROM orchestration_events) AS events, (SELECT COUNT(*) FROM orchestration_command_receipts) AS receipts, revision FROM projection_missions WHERE mission_id = 'mission'`;
        yield* runtime.withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
          r.launchStandby("reservation"),
        );
        const before = yield* counts;
        const original = events.appendMissionEvent;
        const originalPolicy = policy.current;
        Object.defineProperty(events, "appendMissionEvent", {
          configurable: true,
          value: (event: Parameters<typeof original>[0]) =>
            original(event).pipe(
              Effect.tap(() =>
                revoke === "credential"
                  ? registry.revokeThread(delivery)
                  : Effect.sync(() => {
                      Object.defineProperty(policy, "current", {
                        configurable: true,
                        value: () => ({ enabled: false }),
                      });
                    }),
              ),
            ),
        });
        const result = yield* runtime
          .withRequest(scope, { missionId: "mission", role: "delivery" }, (r) =>
            r.advance({
              commandId: CommandId.make("revoked-in-tx"),
              expectedRevision: 0,
              reservationId: "reservation",
              step: "standby",
            }),
          )
          .pipe(Effect.result);
        Object.defineProperty(events, "appendMissionEvent", {
          configurable: true,
          value: original,
        });
        Object.defineProperty(policy, "current", { configurable: true, value: originalPolicy });
        assert.equal(result._tag, "Failure");
        assert.deepEqual(yield* counts, before);
        assert.deepEqual(h.opened, []);
      }),
    ),
);

it.effect("a rejected executor config refuses before subprocess use", () =>
  withHarness({ config: "invalid" }, (h) =>
    Effect.gen(function* () {
      yield* h.seed();
      const runtime = yield* Combined.CombinedMissionRuntime;
      assert.deepEqual(yield* runtime.status, { authority: "available", replay: "unavailable" });
      const scope = yield* h.issue(retro);
      const refusal = yield* runtime
        .withRequest(scope, { missionId: "mission", role: "retro" }, (r) =>
          r.replayAndRecord({
            commandId: CommandId.make("bad-config"),
            expectedRevision: 0,
            evaluationId: "evaluation",
            planId: "plan",
          }),
        )
        .pipe(Effect.result);
      assert.equal(refusal._tag, "Failure");
      if (refusal._tag === "Failure")
        assert.equal(
          refusal.failure._tag === "CombinedMissionRuntimeError" && refusal.failure.code,
          "replay_unavailable",
        );
      assert.deepEqual(h.opened, []);
    }),
  ),
);

it.effect("CATCHES keeps the combined runtime without NoFun authority", () =>
  withHarness({ catches: true }, (h) =>
    Effect.gen(function* () {
      const runtime = yield* Combined.CombinedMissionRuntime;
      assert.deepEqual(yield* runtime.status, {
        authority: "authority_unavailable",
        replay: "unconfigured",
      });
      assert.deepEqual(h.opened, []);
    }),
  ),
);

it.live.each(["credential revocation", "canonical revision drift"] as const)(
  "%s after the first real replay process prevents all remaining process starts and recording",
  (invalidation) =>
    withHarness({ config: "configured" }, (h) =>
      Effect.gen(function* () {
        yield* h.seed();
        const runtime = yield* Combined.CombinedMissionRuntime;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const scope = yield* h.issue(retro);
        const sql = yield* SqlClient.SqlClient;
        h.replayProbe.afterExit =
          invalidation === "credential revocation"
            ? registry.revokeThread(retro)
            : Effect.gen(function* () {
                const rows = yield* sql<{
                  snapshot_json: string;
                }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = 'mission'`;
                const current = decodeMissionJson(rows[0]!.snapshot_json);
                const changed = decodeMission({ ...current, revision: current.revision + 1 });
                yield* sql`UPDATE projection_missions SET revision = ${changed.revision}, snapshot_json = ${encodeMission(changed)} WHERE mission_id = 'mission'`;
              }).pipe(Effect.orDie);
        const result = yield* runtime
          .withRequest(scope, { missionId: "mission", role: "retro" }, (r) =>
            r.replayAndRecord({
              commandId: CommandId.make("revoke-during-replay"),
              expectedRevision: 0,
              evaluationId: "evaluation",
              planId: "plan",
            }),
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "MissionRetroReplayRunError");
          if (result.failure._tag === "MissionRetroReplayRunError")
            assert.equal(result.failure.category, "executor_failed");
        }
        assert.equal(h.replayProbe.spawned, 1);
        const rows = yield* sql<{
          revision: number;
          snapshot_json: string;
        }>`SELECT revision, snapshot_json FROM projection_missions WHERE mission_id = 'mission'`;
        assert.equal(rows[0]?.revision, invalidation === "credential revocation" ? 0 : 1);
        assert.deepEqual(
          decodeMissionJson(rows[0]!.snapshot_json).execution?.retroSkillEvaluations,
          [],
        );
        assert.deepEqual(h.opened, []);
      }),
    ),
);
