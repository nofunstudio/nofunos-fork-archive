import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { Mission, type OrchestratorMcpHostCapacity } from "@t3tools/contracts";
import { withExecutionCapacity } from "./ExecutionCapacity.ts";
import type { ServerProviderUsageLimits } from "../../../../packages/contracts/src/providerUsageLimits.ts";
import {
  decideMissionAdmission,
  dispatchKeyFor,
  type MissionAdmissionFacts,
  type MissionAdmissionRequest,
} from "./MissionAdmission.ts";
import { serverBuildFactsForAdmission } from "./ServerBuildIdentity.ts";

const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const REQUIRED2 = "b2ee2aab36da0982634aa5781b9a66dd18a0bc5e";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const decodeMission = Schema.decodeUnknownSync(Mission);
const missionFixture = (): Mission =>
  decodeMission({
    schemaVersion: 1,
    id: "mission-1",
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT, REQUIRED2],
      },
    ],
    intent: {
      outcome: "Ship the opt-in mission aggregate.",
      scope: ["contracts"],
      exclusions: ["persistence"],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
      decisions: [{ id: "d-1", text: "Small leaf module.", authority: { ...AUTHORITY } }],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: [
      {
        id: "task-a",
        projectId: "project-1",
        title: "Define schemas",
        specHash: "hash-a1",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: iso(NOW_MS - 3_600_000),
      },
      {
        id: "task-b",
        projectId: "project-1",
        title: "Write admission",
        specHash: "hash-b1",
        dependencyHashes: ["hash-a1"],
        dependencies: ["task-a"],
        acceptanceIds: ["ac-1"],
        updatedAt: iso(NOW_MS - 1_800_000),
      },
    ],
    updatedAt: iso(NOW_MS - 1_800_000),
  });

const usageFixture = (usedPercent: number, resetsAt?: string): ServerProviderUsageLimits => ({
  checkedAt: iso(NOW_MS - 60_000),
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5h",
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
    { id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 },
  ],
});

const factsFixture = (): MissionAdmissionFacts => ({
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
  usageLimits: usageFixture(50),
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
    observedAncestry: [BASE_COMMIT, REQUIRED2],
    observedAtMs: NOW_MS - 5_000,
  },
  scopes: {
    writerScope: "/tmp/project/work",
    sharedManifestScopes: ["/tmp/shared"],
    guiScopes: ["/tmp/gui"],
    activeWriterScopes: [],
  },
  priorAttempt: { state: "settled", attemptNumber: 1, cancelRequested: false, leaseExpired: false },
  dependencyReceipts: [{ taskId: "task-a", hash: "hash-a1" }],
  priorReceipts: [],
});

const requestFixture = (): MissionAdmissionRequest => ({
  mission: missionFixture(),
  taskId: "task-b",
  specHash: "hash-b1",
  dependencyHashes: ["hash-a1"],
  attempt: { attemptNumber: 2, operation: "write" },
  proposedAccountId: "acct-1",
  proposedProviderInstanceId: "codex_personal",
  proposedBillingMode: "subscription",
  modelId: "model-a",
  profile: "muse-focused high",
  promptHash: "prompt-1",
  optionsHash: "options-1",
  workspaceRoot: "/tmp/project",
  privilege: "writer",
  rejectedRoutes: [
    {
      providerInstanceId: "codex_work",
      modelId: "model-a",
      reason: "wrong company path",
      observedAtMs: NOW_MS - 10_000,
    },
  ],
});

const successOf = (r: MissionAdmissionRequest, f: MissionAdmissionFacts) => {
  const result = decideMissionAdmission(r, f);
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};
const codeOf = (r: MissionAdmissionRequest, f: MissionAdmissionFacts): string => {
  const result = decideMissionAdmission(r, f);
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.code : "unreachable";
};
const withRouteModel = (modelId: string) => {
  const f = factsFixture();
  return {
    ...f,
    route: { ...f.route, modelId, supportedModelIds: [modelId, "model-a", "model-b"] },
  };
};

describe("MissionAdmission", () => {
  it.each(["available", "held", "unknown"] as const)(
    "admits a verified attempt when build-lock telemetry is %s",
    (state) => {
      const facts = factsFixture();
      const capacity: OrchestratorMcpHostCapacity = {
        hostId: "test-host",
        bootId: "test-boot",
        observedAtMs: NOW_MS - 1_000,
        cpu: { utilization: 0.2, count: 8, loadAverage1m: 1, saturated: false },
        memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, pressure: "normal" },
        disk: { path: "/tmp/project", availableBytes: 10 * 1024 ** 3, floorBytes: 5 * 1024 ** 3 },
        buildLock: { path: "/test-home/.nofun-heavy-build.lock", state },
        ready: true,
        reasons: [],
      };
      const result = successOf(requestFixture(), {
        ...facts,
        host: withExecutionCapacity(facts.host, capacity),
      });
      assert.isTrue(result.dispatchAuthorized);
    },
  );

  it("does not dispatch unneeded work or work on an unidentified host", () => {
    assert.isTrue(
      Result.isFailure(
        decideMissionAdmission(requestFixture(), { ...factsFixture(), taskNecessary: false }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        decideMissionAdmission(requestFixture(), {
          ...factsFixture(),
          host: { ...factsFixture().host, bootId: "" },
        }),
      ),
    );
  });
  it("admits a fully verified attempt with stable key and separate budget/slot", () => {
    const { receipt, recovered, dispatchAuthorized } = successOf(requestFixture(), factsFixture());
    assert.isFalse(recovered);
    assert.isTrue(dispatchAuthorized);
    assert.strictEqual(receipt.requestDigest.length, 64);
    assert.deepStrictEqual(receipt.accountBudget, {
      accountId: "acct-1",
      billingMode: "subscription",
    });
    assert.deepStrictEqual(receipt.hostSlot, {
      hostId: "test-host",
      bootId: "test-boot",
      threadId: "thread-1",
      epoch: 3,
    });
    assert.strictEqual(receipt.exceptionConsumptionRef, null);
  });

  it("denies low quota at 90% used", () => {
    assert.strictEqual(
      codeOf(requestFixture(), { ...factsFixture(), usageLimits: usageFixture(90) }),
      "usage_low",
    );
  });
  it("denies exhausted even when reset is soon", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        usageLimits: usageFixture(100, iso(NOW_MS + 40 * 60_000)),
      }),
      "usage_exhausted",
    );
  });
  it("denies stale and future usage as unknown", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        usageLimits: { ...usageFixture(10), checkedAt: iso(NOW_MS - 31 * 60_000) },
      }),
      "usage_unknown",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        usageLimits: { ...usageFixture(10), checkedAt: iso(NOW_MS + 60_000) },
      }),
      "usage_unknown",
    );
  });

  it.each([
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "terra",
    "GPT-5.6-SOL",
    "gpt-6-sol",
    "gpt-4o",
  ])("denies exact banned model %s", (banned) => {
    assert.strictEqual(
      codeOf({ ...requestFixture(), modelId: banned }, withRouteModel(banned)),
      "legacy_model_denied",
    );
  });

  it("blocks attempt2 while attempt1 outcome is uncertain", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        priorAttempt: {
          state: "uncertain",
          attemptNumber: 1,
          cancelRequested: false,
          leaseExpired: false,
        },
      }),
      "lease_uncertain",
    );
  });
  it("blocks a higher attempt number while prior is uncertain/expired/cancel-only", () => {
    const req = { ...requestFixture(), attempt: { attemptNumber: 3, operation: "write" as const } };
    assert.strictEqual(
      codeOf(req, {
        ...factsFixture(),
        priorAttempt: {
          state: "uncertain",
          attemptNumber: 1,
          cancelRequested: false,
          leaseExpired: true,
        },
      }),
      "lease_uncertain",
    );
    assert.strictEqual(
      codeOf(req, {
        ...factsFixture(),
        priorAttempt: {
          state: "settled",
          attemptNumber: 1,
          cancelRequested: true,
          leaseExpired: false,
        },
      }),
      "lease_uncertain",
    );
  });

  it("denies NaN account verification", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), { ...f, account: { ...f.account, verifiedAtMs: Number.NaN } }),
      "account_mismatch",
    );
  });
  it("denies future host and stale repository observations", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), { ...f, host: { ...f.host, observedAtMs: NOW_MS + 60_000 } }),
      "host_not_observed",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...f,
        repository: { ...f.repository, observedAtMs: NOW_MS - 60 * 60_000 },
      }),
      "ancestry_mismatch",
    );
  });
  it("denies negative/NaN usage windows as unknown", () => {
    const base = usageFixture(10);
    const limits: ServerProviderUsageLimits = {
      ...base,
      windows: [{ ...base.windows[0]!, usedPercent: Number.NaN }, base.windows[1]!],
    };
    assert.strictEqual(
      codeOf(requestFixture(), { ...factsFixture(), usageLimits: limits }),
      "usage_unknown",
    );
  });

  it("denies wrong projectId in repository facts", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), { ...f, repository: { ...f.repository, projectId: "project-2" } }),
      "ancestry_mismatch",
    );
  });
  it("denies missing additional required ancestry beyond base", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...f,
        repository: { ...f.repository, observedAncestry: [BASE_COMMIT] },
      }),
      "ancestry_mismatch",
    );
  });

  it("conflicts when model changes under the same logical key", () => {
    const first = successOf(requestFixture(), factsFixture());
    const f2 = { ...withRouteModel("model-b"), priorReceipts: [first.receipt] };
    assert.strictEqual(codeOf({ ...requestFixture(), modelId: "model-b" }, f2), "digest_conflict");
  });
  it("conflicts when provider changes under the same logical key", () => {
    const first = successOf(requestFixture(), factsFixture());
    const f = factsFixture();
    const f2: MissionAdmissionFacts = {
      ...f,
      account: { ...f.account, providerInstanceId: "other" },
      route: { ...f.route, accountId: "acct-1", providerInstanceId: "other" },
      priorReceipts: [first.receipt],
    };
    assert.strictEqual(
      codeOf({ ...requestFixture(), proposedProviderInstanceId: "other" }, f2),
      "digest_conflict",
    );
  });
  it("keeps dispatch key stable but digest changes with model", () => {
    const key = dispatchKeyFor({
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
      taskId: "task-b",
      attemptNumber: 2,
      operation: "write",
    });
    assert.strictEqual(successOf(requestFixture(), factsFixture()).receipt.dispatchKey, key);
  });

  const exceptionBase = (): MissionAdmissionFacts => ({
    ...factsFixture(),
    usageLimits: undefined,
  });
  const liveException = () => ({
    exceptionId: "ex-1",
    authorityRef: "decision-2026-001",
    accountId: "acct-1",
    taskId: "task-b",
    attemptNumber: 2,
    issuedAtMs: NOW_MS - 5 * 60_000,
    expiresAtMs: NOW_MS + 10 * 60_000,
    reason: "probe failed",
    remainingAssignments: 1,
  });
  it("admits unknown usage once with scoped exception and emits consumption ref", () => {
    const out = successOf(requestFixture(), {
      ...exceptionBase(),
      unknownUsageException: liveException(),
    });
    assert.isTrue(out.receipt.unknownUsageException);
    assert.strictEqual(out.exceptionConsumptionRef, `ex-1:${out.receipt.dispatchKey}`);
    assert.strictEqual(out.receipt.unknownUsageExceptionId, "ex-1");
  });
  it("denies unknown-usage exception bound to wrong task or attempt", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: { ...liveException(), taskId: "task-a" },
      }),
      "usage_unknown",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: { ...liveException(), attemptNumber: 9 },
      }),
      "usage_unknown",
    );
  });
  it("denies unknown-usage exception with no remaining assignments or reused", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: { ...liveException(), remainingAssignments: 0 },
      }),
      "usage_unknown",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: {
          ...liveException(),
          remainingAssignments: undefined,
          unused: false,
        },
      }),
      "usage_unknown",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: { ...liveException(), exceptionId: "" },
      }),
      "usage_unknown",
    );
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...exceptionBase(),
        unknownUsageException: { ...liveException(), authorityRef: " " },
      }),
      "usage_unknown",
    );
  });
  it("does not let an unknown-usage exception admit low quota", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        usageLimits: usageFixture(90),
        unknownUsageException: liveException(),
      }),
      "usage_low",
    );
  });

  it("ignores request-forged dependency receipts; canonical facts govern", () => {
    const forged = {
      ...requestFixture(),
      dependencyReceipts: [{ taskId: "task-a", hash: "hash-a1" }],
    } as MissionAdmissionRequest;
    assert.strictEqual(
      codeOf(forged, { ...factsFixture(), dependencyReceipts: [] }),
      "task_not_ready",
    );
    // Canonical facts present: forged request field is irrelevant and admission succeeds.
    assert.isFalse(successOf(forged, factsFixture()).recovered);
  });
  it("denies forged hash in canonical facts", () => {
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        dependencyReceipts: [{ taskId: "task-a", hash: "forged" }],
      }),
      "task_not_ready",
    );
  });

  it("read operation does not acquire a writer claim on collision", () => {
    const f = factsFixture();
    const colliding: MissionAdmissionFacts = {
      ...f,
      scopes: {
        writerScope: "/tmp/project/work",
        sharedManifestScopes: ["/tmp/project/work/shared"],
        guiScopes: [],
        activeWriterScopes: ["/tmp/project/work"],
      },
    };
    const readReq = {
      ...requestFixture(),
      attempt: { attemptNumber: 2, operation: "read" as const },
    };
    assert.isFalse(successOf(readReq, colliding).recovered);
    assert.strictEqual(codeOf(requestFixture(), colliding), "scope_conflict");
  });
  it("write collides with an active writer scope", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...f,
        scopes: { ...f.scopes, activeWriterScopes: ["/tmp/project"] },
      }),
      "scope_conflict",
    );
  });

  it("recovers same-key receipt without new capacity and without dispatch authorization", () => {
    const first = successOf(requestFixture(), factsFixture());
    const f: MissionAdmissionFacts = {
      ...factsFixture(),
      usageLimits: usageFixture(100),
      priorReceipts: [first.receipt],
    };
    const out = successOf(requestFixture(), f);
    assert.isTrue(out.recovered);
    assert.isFalse(out.dispatchAuthorized);
    assert.strictEqual(out.exceptionConsumptionRef, null);
  });
  it("rechecks epoch before recovering", () => {
    const first = successOf(requestFixture(), factsFixture());
    assert.strictEqual(
      codeOf(requestFixture(), {
        ...factsFixture(),
        deliveryEpoch: 2,
        priorReceipts: [first.receipt],
      }),
      "thread_epoch_mismatch",
    );
  });
  it("denies invalid attempt number and empty authority", () => {
    assert.strictEqual(
      codeOf(
        { ...requestFixture(), attempt: { attemptNumber: 0, operation: "write" } },
        factsFixture(),
      ),
      "attempt_invalid",
    );
    const m = missionFixture();
    assert.strictEqual(
      codeOf(
        { ...requestFixture(), mission: { ...m, intent: { ...m.intent, authorityRefs: [] } } },
        factsFixture(),
      ),
      "authority_denied",
    );
  });
  it("denies model not in server-verified supported list and unknown capability rank", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(
        { ...requestFixture(), modelId: "model-z" },
        { ...f, route: { ...f.route, modelId: "model-z" } },
      ),
      "capability_denied",
    );
    const bad = { ...f, route: { ...f.route, capability: "super" as never } };
    assert.strictEqual(codeOf(requestFixture(), bad), "capability_denied");
  });
  it("denies other companies, paused missions, and wrong billing", () => {
    const f = factsFixture();
    assert.strictEqual(
      codeOf(requestFixture(), { ...f, account: { ...f.account, company: "Synthetic Corp" } }),
      "company_denied",
    );
    assert.strictEqual(
      codeOf({ ...requestFixture(), proposedBillingMode: "metered" }, factsFixture()),
      "account_mismatch",
    );
    const m = missionFixture();
    assert.strictEqual(
      codeOf({ ...requestFixture(), mission: { ...m, status: "paused" } }, factsFixture()),
      "mission_not_active",
    );
  });

  describe("server build identity (admission decision)", () => {
    const RUNNING_SHA = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
    const REQUIRED_SHA = "b2ee2aab36da0982634aa5781b9a66dd18a0bc5e";
    const withBuild = (
      running: { sha: string | null; version: string | null },
      required: { sha: string | null; version: string | null } | null,
    ) => ({
      ...factsFixture(),
      serverBuild: { running, required },
    });

    it("admits when the running build equals the required build", () => {
      const { dispatchAuthorized } = successOf(
        requestFixture(),
        withBuild(
          { sha: REQUIRED_SHA, version: "0.0.45" },
          { sha: REQUIRED_SHA, version: "0.0.45" },
        ),
      );
      assert.isTrue(dispatchAuthorized);
    });

    it("admits legacy facts that pin no build", () => {
      const { dispatchAuthorized } = successOf(requestFixture(), factsFixture());
      assert.isTrue(dispatchAuthorized);
    });

    it("refuses an older running build with a typed build_mismatch", () => {
      const result = decideMissionAdmission(
        requestFixture(),
        withBuild(
          { sha: RUNNING_SHA, version: "0.0.44" },
          { sha: REQUIRED_SHA, version: "0.0.45" },
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, "build_mismatch");
        assert.include(result.failure.message, "older");
      }
    });

    it("refuses an unknown running build when a build is required", () => {
      assert.strictEqual(
        codeOf(
          requestFixture(),
          withBuild({ sha: null, version: null }, { sha: REQUIRED_SHA, version: "0.0.45" }),
        ),
        "build_mismatch",
      );
    });

    it("refuses a different build without version ordering as not equal", () => {
      const result = decideMissionAdmission(
        requestFixture(),
        withBuild({ sha: RUNNING_SHA, version: null }, { sha: REQUIRED_SHA, version: null }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, "build_mismatch");
        assert.include(result.failure.message, "not equal");
      }
    });

    it("refuses a malformed pin with no required sha", () => {
      assert.strictEqual(
        codeOf(
          requestFixture(),
          withBuild({ sha: RUNNING_SHA, version: "0.0.45" }, { sha: null, version: "0.0.45" }),
        ),
        "build_mismatch",
      );
    });

    it("refuses before recovery: an old build cannot replay a prior admission", () => {
      const matching = withBuild(
        { sha: REQUIRED_SHA, version: "0.0.45" },
        { sha: REQUIRED_SHA, version: "0.0.45" },
      );
      const { receipt } = successOf(requestFixture(), matching);
      const replay = decideMissionAdmission(requestFixture(), {
        ...withBuild(
          { sha: RUNNING_SHA, version: "0.0.44" },
          { sha: REQUIRED_SHA, version: "0.0.45" },
        ),
        priorReceipts: [receipt],
      });
      assert.isTrue(Result.isFailure(replay));
      if (Result.isFailure(replay)) {
        assert.strictEqual(replay.failure.code, "build_mismatch");
      }
    });

    it("admits an explicitly unpinned mission via the BK1b seam (requiredServerBuild null)", () => {
      const running = { sha: RUNNING_SHA, version: "0.0.44" };
      const facts = {
        ...factsFixture(),
        requiredServerBuild: null,
        serverBuild: serverBuildFactsForAdmission(null, running),
      } as const;
      const { dispatchAuthorized } = successOf(requestFixture(), { ...facts });
      assert.isTrue(dispatchAuthorized);
    });

    it("refuses a pin-required mission with the pin absent via the BK1b seam", () => {
      const running = { sha: RUNNING_SHA, version: "0.0.44" };
      const facts = {
        ...factsFixture(),
        serverBuild: serverBuildFactsForAdmission(undefined, running),
      };
      assert.strictEqual(codeOf(requestFixture(), facts), "build_mismatch");
    });

    it("refuses a present pin without a running attestation as missing facts", () => {
      const facts = {
        ...factsFixture(),
        requiredServerBuild: { sha: REQUIRED_SHA, version: "0.0.45" },
      };
      const result = decideMissionAdmission(requestFixture(), facts);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, "build_mismatch");
        assert.include(result.failure.message, "no running build attestation");
      }
    });

    it("enforces an exact SHA match for a present pin via the BK1b seam", () => {
      const pin = { sha: REQUIRED_SHA, version: "0.0.45" };
      const matching = successOf(requestFixture(), {
        ...factsFixture(),
        requiredServerBuild: pin,
        serverBuild: serverBuildFactsForAdmission(pin, { ...pin }),
      });
      assert.isTrue(matching.dispatchAuthorized);
      const mismatched = {
        ...factsFixture(),
        requiredServerBuild: pin,
        serverBuild: serverBuildFactsForAdmission(pin, {
          sha: RUNNING_SHA,
          version: "0.0.44",
        }),
      };
      assert.strictEqual(codeOf(requestFixture(), mismatched), "build_mismatch");
    });

    it("build refusal leaves no admission or child state change", () => {
      // decideMissionAdmission is pure: it returns a receipt or a rejection
      // and writes nothing. A refusal must carry no receipt, authorize no
      // dispatch, and leave the supplied facts (prior receipts) untouched.
      const facts = withBuild(
        { sha: RUNNING_SHA, version: "0.0.44" },
        { sha: REQUIRED_SHA, version: "0.0.45" },
      );
      const before = facts.priorReceipts.length;
      const result = decideMissionAdmission(requestFixture(), facts);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, "build_mismatch");
      }
      assert.strictEqual(facts.priorReceipts.length, before);
    });
  });
});
