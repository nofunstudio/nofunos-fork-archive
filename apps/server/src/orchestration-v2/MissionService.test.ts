import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  Mission,
  MissionCommand,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as MissionService from "./MissionService.ts";

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeCommand = Schema.decodeUnknownSync(MissionCommand);
const now = "2026-10-14T00:00:00.000Z";
const authorityRef = { source: "user", ref: "test-authorized-source" };
const scope = {
  teamId: TeamId.make("nofun"),
  environmentId: EnvironmentId.make("test-env"),
  controllerThreadId: ThreadId.make("test-root"),
};
const fixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: "test-mission",
    revision: 0,
    teamId: scope.teamId,
    authorityEnvironmentId: scope.environmentId,
    bindings: [
      {
        projectId: "test-project",
        workspaceRoot: "/tmp/source",
        baseCommit: "base",
        ancestry: ["base"],
      },
    ],
    intent: {
      outcome: "Deliver source",
      scope: ["test"],
      exclusions: [],
      authorityRefs: [authorityRef],
      acceptanceCriteria: [{ id: "acceptance", text: "durable CAS" }],
      decisions: [],
    },
    integrationTarget: { summary: "source candidate" },
    managers: { delivery: { threadId: "test-root", epoch: 1 } },
    status: "active",
    tasks: [],
    updatedAt: now,
  });
const create = () =>
  decodeCommand({ type: "mission.create", commandId: "create-mission", mission: fixture() });
const revise = (id: string, revision = 1) =>
  decodeCommand({
    type: "mission.replace",
    commandId: id,
    mission: { ...fixture(), revision },
    expectedRevision: revision - 1,
    epoch: 1,
    authority: authorityRef,
  });
const layerServices = Layer.mergeAll(
  MissionService.layer.pipe(
    Layer.provide(EventStore.layer),
    Layer.provide(Receipts.layer),
    Layer.provide(Layer.succeed(MissionService.MissionAuthority, scope)),
  ),
  EventStore.layer,
);
const memory = layerServices.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("rolls back event and projection when its command receipt cannot be reserved", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const result = yield* service.execute(create()).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(Option.isNone(yield* service.get(fixture().id)), true);
    const store = yield* EventStore.OrchestrationEventStore;
    assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 0);
  }).pipe(
    Effect.provide(
      MissionService.layer.pipe(
        Layer.provideMerge(EventStore.layer),
        Layer.provide(
          Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, {
            insertIfAbsent: () => Effect.succeed(false),
            upsert: () => Effect.void,
            getByCommandId: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.provide(Layer.succeed(MissionService.MissionAuthority, scope)),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect("commits concurrent duplicate commands once and detects changed requests", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const results = yield* Effect.all([service.execute(create()), service.execute(create())], {
      concurrency: 2,
    });
    assert.strictEqual(results.filter((r) => r.committed).length, 1);
    assert.strictEqual(results[0]!.receipt.resultSequence, results[1]!.receipt.resultSequence);
    const changed = decodeCommand({
      ...create(),
      mission: {
        ...fixture(),
        intent: {
          ...fixture().intent,
          outcome: "different request",
        },
      },
    });
    const conflict = yield* service.execute(changed).pipe(Effect.result);
    assert.strictEqual(conflict._tag, "Failure");
    if (conflict._tag === "Failure")
      assert.strictEqual(conflict.failure._tag, "MissionServiceError");
    const store = yield* EventStore.OrchestrationEventStore;
    assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects stale revisions and retains the canonical aggregate", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute(create());
    yield* service.execute(revise("revise-1"));
    const stale = yield* service.execute(revise("stale-revision")).pipe(Effect.result);
    assert.strictEqual(stale._tag, "Failure");
    if (stale._tag === "Failure") assert.strictEqual(stale.failure._tag, "MissionPlanError");
    const retry = yield* service.execute(revise("stale-revision")).pipe(Effect.result);
    assert.strictEqual(retry._tag, "Failure");
    const changedRejection = yield* service
      .execute(revise("stale-revision", 2))
      .pipe(Effect.result);
    assert.strictEqual(changedRejection._tag, "Failure");
    if (changedRejection._tag === "Failure")
      assert.strictEqual(changedRejection.failure._tag, "MissionServiceError");
    const current = yield* service.get(fixture().id);
    assert.strictEqual(Option.isSome(current) && current.value.revision, 1);
    const sql = yield* SqlClient.SqlClient;
    const events = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_kind = 'mission'`;
    assert.strictEqual(events[0]!.count, 2);
  }).pipe(Effect.provide(memory)),
);

it.effect("denies cross-team command receipt lookup before returning an existing result", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute(create());
    const forbidden = decodeCommand({
      ...create(),
      mission: { ...fixture(), teamId: "other-team" },
    });
    const denied = yield* service.execute(forbidden).pipe(Effect.result);
    assert.strictEqual(denied._tag, "Failure");
    if (denied._tag === "Failure" && denied.failure._tag === "MissionServiceError")
      assert.strictEqual(denied.failure.category, "scope_denied");
  }).pipe(Effect.provide(memory)),
);

it.effect("reopens file-backed state and recovers the same durable command receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "combined-v3-mission-" });
      const databasePath = `${directory}/state.sqlite`;
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          MissionService.MissionService | EventStore.OrchestrationEventStore
        >,
      ) =>
        effect.pipe(
          Effect.provide(
            layerServices.pipe(Layer.provideMerge(Sqlite.layerFromPath(databasePath))),
          ),
        );
      const first = yield* run(
        Effect.gen(function* () {
          const service = yield* MissionService.MissionService;
          return yield* service.execute(create());
        }),
      );
      // Each provide owns and closes its SQLite connection; no in-memory registry survives.
      const second = yield* run(
        Effect.gen(function* () {
          const service = yield* MissionService.MissionService;
          const result = yield* service.execute(create());
          assert.strictEqual(result.committed, false);
          const current = yield* service.get(MissionId.make("test-mission"));
          assert.strictEqual(Option.isSome(current), true);
          const store = yield* EventStore.OrchestrationEventStore;
          assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
          return result;
        }),
      );
      assert.strictEqual(first.receipt.resultSequence, second.receipt.resultSequence);
      assert.strictEqual(first.receipt.requestHash, second.receipt.requestHash);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps company and host observations off the persisted mission and out of scope", () =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const committed = yield* service.execute(create());
    assert.strictEqual(committed.committed, true);
    const loaded = yield* service.get(fixture().id);
    assert.strictEqual(Option.isSome(loaded), true);
    if (Option.isNone(loaded)) return;
    assert.strictEqual(loaded.value.teamId, scope.teamId);
    assert.strictEqual(loaded.value.authorityEnvironmentId, scope.environmentId);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM projection_missions`;
    const snapshot = rows[0]?.snapshot_json ?? "";
    assert.strictEqual(snapshot.includes("host-1"), false);
    assert.strictEqual(snapshot.includes("boot-1"), false);
    assert.strictEqual(snapshot.includes("No Fun"), false);
  }).pipe(
    Effect.provide(
      MissionService.layer.pipe(
        Layer.provide(EventStore.layer),
        Layer.provide(Receipts.layer),
        Layer.provide(
          Layer.succeed(MissionService.MissionAuthority, {
            ...scope,
            company: "No Fun",
            hostQualification: {
              hostId: "host-1",
              bootId: "boot-1",
              buildObserved: true,
              buildOk: true,
              toolchainObserved: true,
              toolchainOk: true,
              observedAtMs: 1,
            },
            repositoryObservations: [
              {
                projectId: "test-project",
                workspaceRootRealpath: "/tmp/source",
                observedAncestry: ["base"],
                observedAtMs: 1,
              },
            ],
          }),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect("cancellation during receipt reservation rolls back the single owning transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventStore.OrchestrationEventStore.pipe(Effect.provide(EventStore.layer));
    const actual = yield* Receipts.OrchestrationCommandReceiptRepository.pipe(
      Effect.provide(Receipts.layer),
    );
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const receipts = {
      ...actual,
      insertIfAbsent: (input: Receipts.OrchestrationCommandReceipt) =>
        Effect.gen(function* () {
          const reserved = yield* actual.insertIfAbsent(input);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          return reserved;
        }),
    };
    const service = yield* MissionService.MissionService.pipe(
      Effect.provide(Layer.fresh(MissionService.layer)),
      Effect.provideService(MissionService.MissionAuthority, scope),
      Effect.provideService(EventStore.OrchestrationEventStore, events),
      Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts),
    );
    const fiber = yield* Effect.forkChild(service.execute(create()));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert.deepStrictEqual(yield* events.readMissionEvents(fixture().id), []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_missions`, []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, []);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
