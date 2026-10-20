import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentId, Mission, TeamId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { type MissionAdmissionRequest, dispatchKeyFor } from "./MissionAdmission.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import * as MissionService from "./MissionService.ts";

/**
 * Dormant admission store acceptance: one transaction commits the event,
 * projection, claims, consumption, and command receipt together; exact
 * replay recovers the same receipt with no new writes and no launch.
 * No sleeps or polling; concurrency only via Effect.all like MissionService.
 */

const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const scope = {
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make("thread-1"),
};

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (id: string, taskId: string) =>
  decodeMission({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Ship admission reservations.",
      scope: ["admission"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reserve once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: [
      {
        id: taskId,
        projectId: "project-1",
        title: "Write attempt",
        specHash: "hash-1",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: iso(NOW_MS - 3_600_000),
      },
    ],
    updatedAt: iso(NOW_MS - 3_600_000),
  });

const trustedFacts = (
  overrides: Partial<MissionAdmissionStore.MissionAdmissionTrustedFacts> = {},
): MissionAdmissionStore.MissionAdmissionTrustedFacts => ({
  taskNecessary: true,
  nowMs: NOW_MS,
  teamId: "team-1",
  environmentId: "env-1",
  deliveryThreadId: "thread-1",
  deliveryEpoch: 3,
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
    projectId: "project-1",
    workspaceRootRealpath: "/tmp/project",
    observedAncestry: [BASE_COMMIT],
    observedAtMs: NOW_MS - 5_000,
  },
  writerScope: "/tmp/project/work",
  sharedManifestScopes: ["/tmp/shared"],
  guiScopes: ["/tmp/gui"],
  dependencyReceipts: [],
  ...overrides,
});

const requestFor = (
  mission: Mission,
  overrides: Partial<MissionAdmissionRequest> = {},
): MissionAdmissionRequest => ({
  mission,
  taskId: "task-a",
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
  workspaceRoot: "/tmp/project",
  privilege: "writer",
  rejectedRoutes: [],
  ...overrides,
});

const keyFor = (
  missionId: string,
  taskId = "task-a",
  attemptNumber = 1,
  operation = "write" as const,
) =>
  dispatchKeyFor({
    teamId: "team-1",
    environmentId: "env-1",
    missionId,
    taskId,
    attemptNumber,
    operation,
  });

interface Harness {
  readonly factsFn: (
    request: MissionAdmissionRequest,
  ) => MissionAdmissionStore.MissionAdmissionTrustedFacts;
  readonly calls: { count: number };
  readonly base: Layer.Layer<
    | MissionAdmissionStore.MissionAdmissionStore
    | MissionService.MissionService
    | EventStore.OrchestrationEventStore
    | Receipts.OrchestrationCommandReceiptRepository,
    never,
    SqlClient.SqlClient
  >;
}

const harness = (
  factsFn: (request: MissionAdmissionRequest) => MissionAdmissionStore.MissionAdmissionTrustedFacts,
  admissionAuthority: MissionService.MissionAuthority["Service"] = scope,
): Harness => {
  const calls = { count: 0 };
  const port = Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
    readFacts: (request: MissionAdmissionRequest) =>
      Effect.succeed(
        (() => {
          calls.count += 1;
          return factsFn(request);
        })(),
      ),
  });
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const base = Layer.mergeAll(
    MissionAdmissionStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, admissionAuthority)),
      Layer.provide(port),
    ),
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
    ),
    EventStore.layer,
    Receipts.layer,
  );
  return { factsFn, calls, base };
};

const memory = (h: Harness) => h.base.pipe(Layer.provideMerge(Sqlite.layerMemory));

const seed = (mission: Mission) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`seed-${mission.id}`),
      mission,
    });
  });

const ok = (
  result: MissionAdmissionStore.MissionAdmissionReserveResult,
): MissionAdmissionStore.MissionAdmissionReservation => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};
const rejectionCode = (result: MissionAdmissionStore.MissionAdmissionReserveResult): string => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.code : assert.fail("expected rejection");
};

describe("MissionAdmissionStore", () => {
  it.effect("rechecks opaque request authority inside reservation after facts were prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mission = missionFixture("mission-revoked", "task-a");
      const requestKey = {};
      let active = true;
      const guard = MissionService.MissionTransactionGuard.make({
        sql,
        requestKey,
        authority: scope,
        request: { operation: "read", missionId: mission.id },
        check: () =>
          Effect.suspend(() =>
            active
              ? Effect.void
              : Effect.fail(
                  new MissionService.MissionServiceError({
                    operation: "read",
                    category: "scope_denied",
                  }),
                ),
          ),
      });
      const h = harness(() => trustedFacts(), { ...scope, requestKey, transactionGuard: guard });
      yield* Effect.gen(function* () {
        yield* seed(mission);
        const store = yield* MissionAdmissionStore.MissionAdmissionStore;
        const prepared = yield* store.prepare(requestFor(mission));
        active = false;
        assert.equal((yield* prepared.reserve.pipe(Effect.flip)).category, "scope_denied");
        const canonical = Option.getOrThrow(
          yield* (yield* MissionService.MissionService).get(mission.id),
        );
        assert.deepEqual(canonical.execution?.admissions ?? [], []);
        assert.equal(canonical.revision, 0);
        assert.equal(
          (yield* (yield* EventStore.OrchestrationEventStore).readMissionEvents(mission.id)).length,
          1,
        );
      }).pipe(Effect.provide(h.base));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("binds prepared request and facts snapshots without rereading the port", () => {
    const facts = trustedFacts();
    const h = harness(() => facts);
    return Effect.gen(function* () {
      const mission = missionFixture("mission-1", "task-a");
      const request = requestFor(mission);
      yield* seed(mission);
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const prepared = yield* store.prepare(request);
      Object.assign(request, { promptHash: "caller-mutated" });
      Object.assign(facts.route, { modelId: "caller-mutated" });
      const reserved = ok(yield* prepared.reserve);
      Object.assign(facts.route, { modelId: "model-a" });
      const original = requestFor(mission);
      const replay = ok(yield* store.reserve(original));
      assert.deepStrictEqual(reserved.receipt, replay.receipt);
      assert.strictEqual(reserved.receipt.chosenRoute.modelId, "model-a");
      assert.isFalse(replay.dispatchAuthorized);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("refuses preparation inside a transaction before reading trusted facts", () => {
    const h = harness(() => trustedFacts());
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      assert.isTrue(
        Result.isFailure(
          yield* sql
            .withTransaction(store.prepare(requestFor(missionFixture("mission-1", "task-a"))))
            .pipe(Effect.result),
        ),
      );
      assert.strictEqual(h.calls.count, 0);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("prepares without writes and ages observations before reservation", () => {
    const h = harness(() => trustedFacts({ maxFactAgeMs: 10_000 }));
    return Effect.gen(function* () {
      const mission = missionFixture("mission-1", "task-a");
      yield* seed(mission);
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const prepared = yield* store.prepare(requestFor(mission));
      const events = yield* EventStore.OrchestrationEventStore;
      assert.lengthOf(yield* events.readMissionEvents(mission.id), 1);
      yield* TestClock.adjust(10_001);
      assert.strictEqual(rejectionCode(yield* prepared.reserve), "account_mismatch");
      assert.strictEqual(h.calls.count, 1);
      assert.lengthOf(yield* events.readMissionEvents(mission.id), 1);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("expires a prepared one-use exception before it can be consumed", () =>
    Effect.gen(function* () {
      const mission = missionFixture("mission-1", "task-a");
      yield* seed(mission);
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const prepared = yield* store.prepare(requestFor(mission));
      yield* TestClock.adjust(1_001);
      assert.strictEqual(rejectionCode(yield* prepared.reserve), "usage_unknown");
      const service = yield* MissionService.MissionService;
      const current = Option.getOrThrow(yield* service.get(mission.id));
      assert.strictEqual(current.revision, 0);
      assert.strictEqual(current.execution, undefined);
    }).pipe(
      Effect.provide(
        memory(
          harness(() =>
            trustedFacts({
              usageLimits: undefined,
              unknownUsageException: {
                exceptionId: "prepared-ex",
                authorityRef: "decision",
                accountId: "acct-1",
                taskId: "task-a",
                attemptNumber: 1,
                issuedAtMs: NOW_MS - 1000,
                expiresAtMs: NOW_MS + 1000,
                reason: "unknown",
                remainingAssignments: 1,
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("reserves once and commits event, projection, claim, and receipt together", () =>
    Effect.gen(function* () {
      const h = harness(() => trustedFacts());
      void h;
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      const out = ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
      assert.isFalse(out.recovered);
      assert.isTrue(out.dispatchAuthorized);
      assert.strictEqual(out.dispatcherStatus, "unregistered");
      assert.strictEqual(out.exceptionConsumptionRef, null);
      assert.strictEqual(out.receipt.dispatchKey, keyFor("mission-1"));
      const service = yield* MissionService.MissionService;
      const current = yield* service.get(missionFixture("mission-1", "task-a").id);
      assert.isTrue(Option.isSome(current));
      if (Option.isSome(current)) {
        assert.strictEqual(current.value.revision, 1);
        assert.strictEqual(current.value.execution?.admissions.length, 1);
        assert.strictEqual(
          current.value.execution?.admissions[0]?.requestDigest,
          out.receipt.requestDigest,
        );
        assert.deepStrictEqual(
          current.value.execution?.writerClaims.map((claim) => claim.scope),
          ["/tmp/project/work"],
        );
      }
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const committed = Option.getOrThrow(
        yield* receipts.getByCommandId({
          commandId: CommandId.make(`mission-admission:${out.receipt.dispatchKey}`),
        }),
      );
      assert.strictEqual(committed.requestHash, out.receipt.requestDigest);
      const events = yield* EventStore.OrchestrationEventStore;
      const logged = yield* events.readMissionEvents(missionFixture("mission-1", "task-a").id);
      assert.strictEqual(logged.length, 2);
      assert.strictEqual(logged[1]?.type, "mission.admission-reserved");
    }).pipe(Effect.provide(memory(harness(() => trustedFacts())))),
  );

  it.effect("commits concurrent duplicates once and recovers the same receipt", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      const request = requestFor(missionFixture("mission-1", "task-a"));
      const results = yield* Effect.all([store.reserve(request), store.reserve(request)], {
        concurrency: 2,
      });
      const outs = results.map(ok);
      assert.strictEqual(outs.filter((o) => o.dispatchAuthorized).length, 1);
      assert.strictEqual(outs.filter((o) => o.recovered).length, 1);
      assert.deepStrictEqual(outs[0]!.receipt, outs[1]!.receipt);
      assert.isFalse(outs.find((out) => out.recovered)!.dispatchAuthorized);
      const service = yield* MissionService.MissionService;
      const current = yield* service.get(missionFixture("mission-1", "task-a").id);
      assert.isTrue(Option.isSome(current) && current.value.revision === 1);
      const events = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual(
        (yield* events.readMissionEvents(missionFixture("mission-1", "task-a").id)).length,
        2,
      );
    }).pipe(Effect.provide(memory(harness(() => trustedFacts())))),
  );

  it.effect("conflicts on same key with changed bytes and writes nothing new", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
      const service = yield* MissionService.MissionService;
      const current = yield* service.get(missionFixture("mission-1", "task-a").id);
      assert.isTrue(Option.isSome(current));
      const changed =
        Option.isSome(current) && current.value.revision === 1
          ? requestFor(current.value, { optionsHash: "options-2" })
          : requestFor(missionFixture("mission-1", "task-a"), { optionsHash: "options-2" });
      assert.strictEqual(rejectionCode(yield* store.reserve(changed)), "digest_conflict");
      const reread = yield* service.get(missionFixture("mission-1", "task-a").id);
      assert.isTrue(Option.isSome(reread) && reread.value.revision === 1);
      const events = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual(
        (yield* events.readMissionEvents(missionFixture("mission-1", "task-a").id)).length,
        2,
      );
    }).pipe(Effect.provide(memory(harness(() => trustedFacts())))),
  );

  it.effect("denies overlapping writer claims across two mission IDs", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      yield* seed(missionFixture("mission-2", "task-b"));
      ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
      const second = requestFor(missionFixture("mission-2", "task-b"), { taskId: "task-b" });
      const facts = harness((request) =>
        trustedFacts(
          request.mission.id === "mission-2" ? { writerScope: "/tmp/project/work/sub" } : {},
        ),
      );
      void facts;
      assert.strictEqual(rejectionCode(yield* store.reserve(second)), "scope_conflict");
    }).pipe(
      Effect.provide(
        memory(
          harness((request) =>
            trustedFacts(
              request.mission.id === "mission-2" ? { writerScope: "/tmp/project/work/sub" } : {},
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("consumes a one-use unknown-usage exception once across missions", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      yield* seed(missionFixture("mission-2", "task-b"));
      const exceptionFor = (taskId: string) => ({
        exceptionId: "ex-1",
        authorityRef: "decision-2026-001",
        accountId: "acct-1",
        taskId,
        attemptNumber: 1,
        issuedAtMs: NOW_MS - 5 * 60_000,
        expiresAtMs: NOW_MS + 10 * 60_000,
        reason: "probe failed",
        remainingAssignments: 1,
      });
      void exceptionFor;
      const first = ok(
        yield* store.reserve(
          requestFor(missionFixture("mission-1", "task-a"), {
            attempt: { attemptNumber: 1, operation: "read" },
          }),
        ),
      );
      assert.isTrue(first.dispatchAuthorized);
      const second = requestFor(missionFixture("mission-2", "task-b"), {
        taskId: "task-b",
        attempt: { attemptNumber: 1, operation: "read" },
      });
      assert.strictEqual(rejectionCode(yield* store.reserve(second)), "usage_unknown");
    }).pipe(
      Effect.provide(
        memory(
          harness((request) =>
            trustedFacts({
              usageLimits: undefined,
              unknownUsageException: {
                exceptionId: "ex-1",
                authorityRef: "decision-2026-001",
                accountId: "acct-1",
                taskId: request.taskId,
                attemptNumber: 1,
                issuedAtMs: NOW_MS - 5 * 60_000,
                expiresAtMs: NOW_MS + 10 * 60_000,
                reason: "probe failed",
                remainingAssignments: 1,
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "rolls back projection, event, claims, and consumption when the receipt insert fails",
    () =>
      Effect.gen(function* () {
        const store = yield* MissionAdmissionStore.MissionAdmissionStore;
        yield* seed(missionFixture("mission-1", "task-a"));
        const failed = yield* store
          .reserve(requestFor(missionFixture("mission-1", "task-a")))
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(failed));
        const service = yield* MissionService.MissionService;
        const current = yield* service.get(missionFixture("mission-1", "task-a").id);
        assert.isTrue(Option.isSome(current) && current.value.revision === 0);
        assert.strictEqual(Option.isSome(current) ? current.value.execution : undefined, undefined);
        const events = yield* EventStore.OrchestrationEventStore;
        assert.strictEqual(
          (yield* events.readMissionEvents(missionFixture("mission-1", "task-a").id)).length,
          1,
        );
      }).pipe(
        Effect.provide(
          (() => {
            const failingReceipts = Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, {
              insertIfAbsent: () => Effect.succeed(false),
              upsert: () => Effect.void,
              getByCommandId: () => Effect.succeed(Option.none()),
            });
            const authority = Layer.succeed(MissionService.MissionAuthority, scope);
            const port = Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
              readFacts: () =>
                Effect.succeed(
                  trustedFacts({
                    usageLimits: undefined,
                    unknownUsageException: {
                      exceptionId: "rollback-ex",
                      authorityRef: "decision",
                      accountId: "acct-1",
                      taskId: "task-a",
                      attemptNumber: 1,
                      issuedAtMs: NOW_MS - 1000,
                      expiresAtMs: NOW_MS + 1000,
                      reason: "unknown",
                      remainingAssignments: 1,
                    },
                  }),
                ),
            });
            return Layer.mergeAll(
              MissionAdmissionStore.layer.pipe(
                Layer.provide(EventStore.layer),
                Layer.provide(failingReceipts),
                Layer.provide(authority),
                Layer.provide(port),
              ),
              MissionService.layer.pipe(
                Layer.provide(EventStore.layer),
                Layer.provide(Receipts.layer),
                Layer.provide(authority),
              ),
              EventStore.layer,
            ).pipe(Layer.provideMerge(Sqlite.layerMemory));
          })(),
        ),
      ),
  );

  it.effect("denies foreign team/env before facts and revalidates epoch on replay", () => {
    let epoch = 3;
    const h = harness(() => trustedFacts({ deliveryEpoch: epoch }));
    return Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const mission = missionFixture("mission-1", "task-a");
      yield* seed(mission);
      ok(yield* store.reserve(requestFor(mission)));
      const count = h.calls.count;
      for (const foreign of [
        { teamId: TeamId.make("foreign") },
        { authorityEnvironmentId: EnvironmentId.make("foreign") },
      ]) {
        const denied = yield* store
          .reserve(requestFor({ ...mission, ...foreign }))
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
        if (Result.isFailure(denied)) assert.strictEqual(denied.failure.category, "scope_denied");
      }
      assert.strictEqual(h.calls.count, count);
      epoch = 2;
      assert.strictEqual(
        rejectionCode(yield* store.reserve(requestFor(mission))),
        "thread_epoch_mismatch",
      );
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("restores the committed receipt across close/reopen with no repeats", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "combined-v3-admission-" });
        const databasePath = `${directory}/state.sqlite`;
        const h = harness(() => trustedFacts());
        const run = <A, E>(
          effect: Effect.Effect<
            A,
            E,
            MissionAdmissionStore.MissionAdmissionStore | MissionService.MissionService
          >,
        ) =>
          effect.pipe(
            Effect.provide(h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(databasePath)))),
          );
        const first = yield* run(
          Effect.gen(function* () {
            const service = yield* MissionService.MissionService;
            yield* service.execute({
              type: "mission.create",
              commandId: CommandId.make("seed-mission-1"),
              mission: missionFixture("mission-1", "task-a"),
            });
            const store = yield* MissionAdmissionStore.MissionAdmissionStore;
            return ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
          }),
        );
        assert.isTrue(first.dispatchAuthorized);
        const second = yield* run(
          Effect.gen(function* () {
            const store = yield* MissionAdmissionStore.MissionAdmissionStore;
            const out = ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
            assert.isTrue(out.recovered);
            assert.isFalse(out.dispatchAuthorized);
            return out;
          }),
        );
        assert.deepStrictEqual(second.receipt, first.receipt);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks attempt-counter and operation bypass on an unsettled reservation", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
      const service = yield* MissionService.MissionService;
      const current = Option.getOrThrow(
        yield* service.get(missionFixture("mission-1", "task-a").id),
      );
      const bumped = requestFor(current, {
        attempt: { attemptNumber: 2, operation: "write" },
      });
      assert.strictEqual(rejectionCode(yield* store.reserve(bumped)), "lease_uncertain");
      const changedOp = requestFor(current, {
        attempt: { attemptNumber: 1, operation: "read" },
      });
      assert.strictEqual(rejectionCode(yield* store.reserve(changedOp)), "lease_uncertain");
    }).pipe(Effect.provide(memory(harness(() => trustedFacts())))),
  );

  it.effect("rejects non-normalized writer scopes for writes but admits reads", () =>
    Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      const traversal = requestFor(missionFixture("mission-1", "task-a"));
      assert.strictEqual(rejectionCode(yield* store.reserve(traversal)), "scope_conflict");
      const read = requestFor(missionFixture("mission-1", "task-a"), {
        attempt: { attemptNumber: 1, operation: "read" },
      });
      const out = ok(yield* store.reserve(read));
      assert.isTrue(out.dispatchAuthorized);
    }).pipe(
      Effect.provide(
        memory(harness(() => trustedFacts({ writerScope: "/tmp/project/../escape" }))),
      ),
    ),
  );

  it.effect("reads trusted facts once per reservation with no external dispatch", () => {
    const h = harness(() => trustedFacts());
    return Effect.gen(function* () {
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      yield* seed(missionFixture("mission-1", "task-a"));
      ok(yield* store.reserve(requestFor(missionFixture("mission-1", "task-a"))));
      assert.strictEqual(h.calls.count, 1);
    }).pipe(Effect.provide(memory(h)));
  });
  it.effect("serializes competing writers across canonical missions", () =>
    Effect.gen(function* () {
      yield* seed(missionFixture("mission-1", "task-a"));
      yield* seed(missionFixture("mission-2", "task-b"));
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const results = yield* Effect.all(
        [
          store.reserve(requestFor(missionFixture("mission-1", "task-a"))),
          store.reserve(requestFor(missionFixture("mission-2", "task-b"), { taskId: "task-b" })),
        ],
        { concurrency: 2 },
      );
      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
      assert.strictEqual(results.filter(Result.isFailure).length, 1);
      assert.strictEqual(rejectionCode(results.find(Result.isFailure)!), "scope_conflict");
    }).pipe(Effect.provide(memory(harness(() => trustedFacts())))),
  );

  it.effect("denies changed trusted writer scope during receipt recovery", () => {
    let writerScope = "/tmp/project/work";
    const h = harness(() => trustedFacts({ writerScope }));
    return Effect.gen(function* () {
      const mission = missionFixture("mission-1", "task-a");
      yield* seed(mission);
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      ok(yield* store.reserve(requestFor(mission)));
      writerScope = "/tmp/project/other";
      assert.strictEqual(
        rejectionCode(yield* store.reserve(requestFor(mission))),
        "digest_conflict",
      );
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("denies a nominal one-use quota exception with capacity above one", () =>
    Effect.gen(function* () {
      const mission = missionFixture("mission-1", "task-a");
      yield* seed(mission);
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      assert.strictEqual(rejectionCode(yield* store.reserve(requestFor(mission))), "usage_unknown");
    }).pipe(
      Effect.provide(
        memory(
          harness(() =>
            trustedFacts({
              usageLimits: undefined,
              unknownUsageException: {
                exceptionId: "ex-2",
                authorityRef: "decision",
                accountId: "acct-1",
                taskId: "task-a",
                attemptNumber: 1,
                issuedAtMs: NOW_MS - 1000,
                expiresAtMs: NOW_MS + 1000,
                reason: "unknown",
                remainingAssignments: 2,
              },
            }),
          ),
        ),
      ),
    ),
  );
});
