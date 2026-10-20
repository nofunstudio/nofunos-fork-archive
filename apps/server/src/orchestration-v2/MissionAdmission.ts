// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds the canonical request digest to the admission receipt.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { Mission } from "../../../../packages/contracts/src/mission.ts";
import type { OrchestratorMcpHostCapacity } from "@t3tools/contracts";
import type { ServerProviderUsageLimits } from "../../../../packages/contracts/src/providerUsageLimits.ts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { usageHeadroom } from "../mcp/usageHeadroom.ts";

/**
 * Pure single-host admission decision at the server domain seam.
 * No I/O, no clock reads, no atomic reservation. All canonical facts
 * (dependency receipts, prior receipts, writer/GUI/shared claims, route
 * verification, usage exception state) are server-supplied via `facts`,
 * never self-attested by the worker proposing the attempt. Root later
 * commits the returned receipt and atomically reserves any exception
 * consumption reference contained in it.
 */

export const MissionAdmissionRejectionCode = Schema.Literals([
  "mission_not_active",
  "thread_epoch_mismatch",
  "scope_mismatch",
  "task_unknown",
  "task_not_ready",
  "hash_mismatch",
  "account_mismatch",
  "company_denied",
  "capability_denied",
  "legacy_model_denied",
  "usage_exhausted",
  "usage_low",
  "usage_unknown",
  "host_not_observed",
  "host_not_ready",
  "ancestry_mismatch",
  "scope_conflict",
  "lease_uncertain",
  "digest_conflict",
  "attempt_invalid",
  "authority_denied",
]);
export type MissionAdmissionRejectionCode = typeof MissionAdmissionRejectionCode.Type;

export class MissionAdmissionRejection extends Schema.TaggedError<MissionAdmissionRejection>()(
  "MissionAdmissionRejection",
  {
    code: MissionAdmissionRejectionCode,
    message: Schema.String,
    dispatchKey: Schema.optional(Schema.String),
  },
) {}

export const MissionAdmissionOperation = Schema.Literals(["read", "test", "write"]);
export type MissionAdmissionOperation = typeof MissionAdmissionOperation.Type;

export const MissionAdmissionCapability = Schema.Literals(["read_only", "executable", "writer"]);
export type MissionAdmissionCapability = typeof MissionAdmissionCapability.Type;

export interface MissionAdmissionAttemptIdentity {
  readonly attemptNumber: number;
  readonly operation: MissionAdmissionOperation;
}

export interface MissionAdmissionDependencyReceipt {
  readonly taskId: string;
  readonly hash: string;
}

export interface MissionAdmissionRejectedRoute {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly reason: string;
  readonly observedAtMs: number;
}

export interface MissionAdmissionRoute {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly profile: string;
}

/** Worker proposal only. Every field is checked against server facts. */
export interface MissionAdmissionRequest {
  readonly mission: Mission;
  readonly taskId: string;
  readonly specHash: string;
  readonly dependencyHashes: ReadonlyArray<string>;
  readonly attempt: MissionAdmissionAttemptIdentity;
  readonly proposedAccountId: string;
  readonly proposedProviderInstanceId: string;
  readonly proposedBillingMode: string;
  readonly modelId: string;
  readonly profile: string;
  readonly promptHash: string;
  readonly optionsHash: string;
  readonly workspaceRoot: string;
  readonly privilege: string;
  readonly rejectedRoutes: ReadonlyArray<MissionAdmissionRejectedRoute>;
}

export interface MissionAdmissionAccountFacts {
  readonly accountId: string;
  readonly providerInstanceId: string;
  readonly billingMode: string;
  readonly company: string;
  readonly verifiedAtMs: number;
}

/** Server-verified route: actual instance/model/profile/billing/capability. */
export interface MissionAdmissionRouteFacts {
  readonly accountId: string;
  readonly providerInstanceId: string;
  readonly billingMode: string;
  readonly modelId: string;
  readonly profile: string;
  /** Runtime value validated against known ranks; unknown fails closed. */
  readonly capability: MissionAdmissionCapability;
  /** Server-verified capability catalog for this route. No invented IDs. */
  readonly supportedModelIds: ReadonlyArray<string>;
}

export interface MissionAdmissionHostFacts {
  readonly capacity?: OrchestratorMcpHostCapacity | undefined;
  readonly hostId: string;
  readonly bootId: string;
  readonly ready: boolean;
  readonly buildObserved: boolean;
  readonly buildOk: boolean;
  readonly toolchainObserved: boolean;
  readonly toolchainOk: boolean;
  readonly pressureObserved: boolean;
  readonly pressureAcceptable: boolean;
  readonly observedAtMs: number;
}

export interface MissionAdmissionRepositoryFacts {
  readonly projectId: string;
  readonly workspaceRootRealpath: string;
  readonly observedAncestry: ReadonlyArray<string>;
  readonly observedAtMs: number;
}

export interface MissionAdmissionScopeFacts {
  /** Server realpath-owned writer scope for this attempt. */
  readonly writerScope: string;
  readonly sharedManifestScopes: ReadonlyArray<string>;
  readonly guiScopes: ReadonlyArray<string>;
  /** Realpath writer scopes already owned by other active attempts. */
  readonly activeWriterScopes: ReadonlyArray<string>;
}

export interface MissionAdmissionLeaseFacts {
  readonly state: "none" | "settled" | "uncertain";
  readonly attemptNumber: number | null;
  readonly cancelRequested: boolean;
  readonly leaseExpired: boolean;
}

/**
 * Scoped, expiring, ONE-assignment exception for unknown usage.
 * Server supplies identity, binding and remaining/unused state; the pure
 * decision only emits a consumption reference for root to reserve atomically.
 */
export interface MissionAdmissionUnknownUsageException {
  readonly exceptionId: string;
  readonly authorityRef: string;
  readonly accountId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly reason: string;
  readonly remainingAssignments?: number | undefined;
  readonly unused?: boolean | undefined;
}

export interface MissionAdmissionFacts {
  /** Derived from canonical task/result state, never the dispatch proposal. */
  readonly taskNecessary: boolean;
  readonly nowMs: number;
  readonly teamId: string;
  readonly environmentId: string;
  readonly deliveryThreadId: string;
  readonly deliveryEpoch: number;
  readonly account: MissionAdmissionAccountFacts;
  readonly route: MissionAdmissionRouteFacts;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly usageMaxObservationAgeMs: number;
  /**
   * Which reader supplied `usageLimits`. Passive-only Muse observations go
   * stale by the clock while idle, so a Muse source trusts the last
   * observation while its window has not reset instead of refusing unknown.
   * Absent means a regular provider source (strict clock rule).
   */
  readonly usageSource?: "provider" | "muse" | "unavailable" | undefined;
  /** Optional bounded fact age; unsafe values fall back to safe constant. */
  readonly maxFactAgeMs?: number | undefined;
  readonly unknownUsageException?: MissionAdmissionUnknownUsageException | undefined;
  readonly host: MissionAdmissionHostFacts;
  readonly repository: MissionAdmissionRepositoryFacts;
  readonly scopes: MissionAdmissionScopeFacts;
  readonly priorAttempt: MissionAdmissionLeaseFacts;
  /** Canonical accepted dependency receipts owned by the server. */
  readonly dependencyReceipts: ReadonlyArray<MissionAdmissionDependencyReceipt>;
  /** Current prior admission receipts owned by the server. */
  readonly priorReceipts: ReadonlyArray<MissionAdmissionReceipt>;
}

export interface MissionAdmissionReceipt {
  readonly dispatchKey: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly operation: MissionAdmissionOperation;
  readonly requestDigest: string;
  readonly admittedAtMs: number;
  readonly chosenRoute: MissionAdmissionRoute;
  readonly rejectedRoutes: ReadonlyArray<MissionAdmissionRejectedRoute>;
  readonly evidenceTimestamps: {
    readonly accountVerifiedAtMs: number;
    readonly hostObservedAtMs: number;
    readonly repositoryObservedAtMs: number;
  };
  readonly unknownUsageException: boolean;
  readonly unknownUsageExceptionId: string | null;
  /** Consumption reference root must atomically reserve; null otherwise. */
  readonly exceptionConsumptionRef: string | null;
  readonly accountBudget: { readonly accountId: string; readonly billingMode: string };
  readonly hostSlot: {
    readonly hostId: string;
    readonly bootId: string;
    readonly threadId: string;
    readonly epoch: number;
  };
}

export interface MissionAdmissionSuccess {
  readonly receipt: MissionAdmissionReceipt;
  readonly recovered: boolean;
  /** False for recovered retrieval: it is not a fresh dispatch authorization. */
  readonly dispatchAuthorized: boolean;
  readonly exceptionConsumptionRef: string | null;
}

export type MissionAdmissionResult = Result.Result<
  MissionAdmissionSuccess,
  MissionAdmissionRejection
>;

const ADMITTED_COMPANY = "No Fun";
const MAX_UNKNOWN_USAGE_EXCEPTION_MS = 60 * 60_000;
const MAX_FACT_AGE_MS = 5 * 60_000;

const CAPABILITY_RANK: Readonly<Record<string, number>> = {
  read_only: 0,
  executable: 1,
  writer: 2,
};
const REQUIRED_CAPABILITY: Readonly<Record<string, string>> = {
  read: "read_only",
  test: "executable",
  write: "writer",
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isBannedModel = (modelId: string): boolean => {
  const m = modelId.trim().toLowerCase();
  if (/^gpt-5\.6(?:[-_.].*)?$/.test(m)) return true;
  if (/^gpt-6-sol(?:[-_.].*)?$/.test(m)) return true;
  if (/(?:^|[-_.])terra(?:[-_.]|$)/.test(m)) return true;
  if (/^gpt-(?:3\.5|4)/.test(m)) return true;
  return false;
};
const underScope = (scope: string, prefix: string): boolean =>
  scope === prefix || scope.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
const overlaps = (a: string, b: string): boolean => underScope(a, b) || underScope(b, a);

const err = (
  code: MissionAdmissionRejectionCode,
  message: string,
  dispatchKey?: string,
): MissionAdmissionResult =>
  Result.fail(
    new MissionAdmissionRejection(
      dispatchKey === undefined ? { code, message } : { code, message, dispatchKey },
    ),
  );

export const dispatchKeyFor = (input: {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly operation: MissionAdmissionOperation;
}): string =>
  JSON.stringify([
    "mission-admission",
    input.teamId,
    input.environmentId,
    input.missionId,
    input.taskId,
    input.attemptNumber,
    input.operation,
  ]);

export const requestDigestFor = (input: {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly operation: MissionAdmissionOperation;
  readonly providerInstanceId: string;
  readonly accountId: string;
  readonly billingMode: string;
  readonly modelId: string;
  readonly profile: string;
  readonly promptHash: string;
  readonly optionsHash: string;
  readonly workspaceRoot: string;
  readonly privilege: string;
  readonly specHash: string;
  readonly dependencyHashes: ReadonlyArray<string>;
  readonly dependencyReceipts: ReadonlyArray<MissionAdmissionDependencyReceipt>;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        accountId: input.accountId,
        attemptNumber: input.attemptNumber,
        billingMode: input.billingMode,
        dependencyHashes: [...input.dependencyHashes],
        dependencyReceipts: input.dependencyReceipts
          .map((r) => ({ hash: r.hash, taskId: r.taskId }))
          .sort((a, b) => a.taskId.localeCompare(b.taskId)),
        environmentId: input.environmentId,
        missionId: input.missionId,
        modelId: input.modelId,
        operation: input.operation,
        optionsHash: input.optionsHash,
        privilege: input.privilege,
        profile: input.profile,
        promptHash: input.promptHash,
        providerInstanceId: input.providerInstanceId,
        specHash: input.specHash,
        taskId: input.taskId,
        teamId: input.teamId,
        workspaceRoot: input.workspaceRoot,
      }),
    )
    .digest("hex");

const freshTimestamp = (ts: number, nowMs: number, maxAge: number): boolean =>
  Number.isFinite(ts) && ts >= 0 && ts <= nowMs && nowMs - ts <= maxAge;

export const decideMissionAdmission = (
  request: MissionAdmissionRequest,
  facts: MissionAdmissionFacts,
): MissionAdmissionResult => {
  const mission = request.mission;
  if (!Number.isFinite(facts.nowMs) || facts.nowMs < 0) {
    return err("attempt_invalid", "Server clock fact is not finite.");
  }
  const maxFactAge =
    facts.maxFactAgeMs !== undefined &&
    Number.isFinite(facts.maxFactAgeMs) &&
    facts.maxFactAgeMs > 0 &&
    facts.maxFactAgeMs <= MAX_FACT_AGE_MS
      ? facts.maxFactAgeMs
      : MAX_FACT_AGE_MS;

  // --- Scope / authorization / identity (also gate recovery) ---
  if (mission.status !== "active") {
    return err(
      "mission_not_active",
      `Mission '${mission.id}' is ${mission.status}; only active missions dispatch.`,
    );
  }
  if (mission.teamId !== facts.teamId || mission.authorityEnvironmentId !== facts.environmentId) {
    return err("scope_mismatch", "Mission team or environment does not match server scope.");
  }
  if (
    !Array.isArray(mission.intent.authorityRefs) ||
    mission.intent.authorityRefs.length === 0 ||
    mission.intent.authorityRefs.some((r) => !nonEmpty(r.source) || !nonEmpty(r.ref))
  ) {
    return err("authority_denied", "Mission authority references must be explicit and non-empty.");
  }
  const delivery = mission.managers.delivery;
  if (
    !Number.isInteger(facts.deliveryEpoch) ||
    facts.deliveryEpoch < 0 ||
    delivery?.threadId !== facts.deliveryThreadId ||
    delivery.epoch === undefined ||
    delivery.epoch !== facts.deliveryEpoch
  ) {
    return err("thread_epoch_mismatch", "Mission delivery thread or epoch is not current.");
  }
  const task = mission.tasks.find((c) => c.id === request.taskId);
  if (task === undefined) {
    return err("task_unknown", `Task '${request.taskId}' is not part of mission '${mission.id}'.`);
  }
  if (
    !Number.isInteger(request.attempt.attemptNumber) ||
    request.attempt.attemptNumber < 1 ||
    !(request.attempt.operation in REQUIRED_CAPABILITY)
  ) {
    return err("attempt_invalid", "Attempt number must be an integer >= 1 with a known operation.");
  }
  if (
    request.specHash !== task.specHash ||
    request.dependencyHashes.length !== task.dependencyHashes.length ||
    request.dependencyHashes.some((h, i) => h !== task.dependencyHashes[i])
  ) {
    return err("hash_mismatch", `Task '${request.taskId}' hashes changed; re-plan first.`);
  }
  for (let i = 0; i < task.dependencies.length; i += 1) {
    const dep = task.dependencies[i]!;
    const expected = task.dependencyHashes[i]!;
    const receipt = facts.dependencyReceipts.find((c) => c.taskId === dep);
    if (receipt === undefined || receipt.hash !== expected) {
      return err(
        "task_not_ready",
        `Task '${request.taskId}' dependency '${dep}' has no canonical acceptance receipt.`,
      );
    }
  }
  const canonicalDepReceipts = task.dependencies.map((dep) =>
    facts.dependencyReceipts.find((c) => c.taskId === dep)!,
  );
  if (
    !nonEmpty(request.proposedAccountId) ||
    !nonEmpty(request.proposedProviderInstanceId) ||
    !nonEmpty(request.proposedBillingMode) ||
    !nonEmpty(request.profile) ||
    request.proposedAccountId !== facts.account.accountId ||
    request.proposedAccountId !== facts.route.accountId ||
    request.proposedProviderInstanceId !== facts.account.providerInstanceId ||
    request.proposedProviderInstanceId !== facts.route.providerInstanceId ||
    request.proposedBillingMode !== facts.account.billingMode ||
    request.proposedBillingMode !== facts.route.billingMode
  ) {
    return err("account_mismatch", "Proposed account, provider, or billing mode is not verified.");
  }
  if (facts.account.company !== ADMITTED_COMPANY) {
    return err("company_denied", "This host dispatches only the No Fun company path.");
  }
  if (
    !nonEmpty(request.modelId) ||
    isBannedModel(request.modelId) ||
    isBannedModel(facts.route.modelId)
  ) {
    return err("legacy_model_denied", `Model '${request.modelId}' is denied by owner policy.`);
  }
  // Server-verified route: actual model/profile must match proposal and catalog.
  if (
    request.modelId !== facts.route.modelId ||
    request.profile !== facts.route.profile ||
    !Array.isArray(facts.route.supportedModelIds) ||
    facts.route.supportedModelIds.length === 0 ||
    !facts.route.supportedModelIds.includes(facts.route.modelId) ||
    !facts.route.supportedModelIds.includes(request.modelId)
  ) {
    return err(
      "capability_denied",
      "Selected model/profile is not in the server-verified route capability.",
    );
  }
  const requiredName = REQUIRED_CAPABILITY[request.attempt.operation]!;
  const actualRank = CAPABILITY_RANK[facts.route.capability as string];
  const requiredRank = CAPABILITY_RANK[requiredName];
  if (
    actualRank === undefined ||
    requiredRank === undefined ||
    !Number.isFinite(actualRank) ||
    actualRank < requiredRank
  ) {
    return err(
      "capability_denied",
      `Operation '${request.attempt.operation}' needs ${requiredName}; selected route capability is unknown or insufficient.`,
    );
  }
  // Repository: task/project/root/all required ancestry from server facts.
  const binding = mission.bindings.find((c) => c.projectId === task.projectId);
  if (
    binding === undefined ||
    facts.repository.projectId !== task.projectId ||
    facts.repository.projectId !== binding.projectId ||
    request.workspaceRoot !== facts.repository.workspaceRootRealpath ||
    binding.workspaceRoot !== facts.repository.workspaceRootRealpath ||
    !facts.repository.observedAncestry.includes(binding.baseCommit) ||
    binding.ancestry.some((c) => !facts.repository.observedAncestry.includes(c))
  ) {
    return err(
      "ancestry_mismatch",
      "Verified project, workspace, or required ancestry does not match.",
    );
  }
  // Writer claims only for writes. Reads/tests never acquire a writer claim.
  if (request.attempt.operation === "write") {
    if (!nonEmpty(facts.scopes.writerScope)) {
      return err("scope_conflict", "Write attempt has no server-owned writer scope.");
    }
    const conflict = [
      ...facts.scopes.sharedManifestScopes,
      ...facts.scopes.guiScopes,
      ...facts.scopes.activeWriterScopes,
    ].some((s) => nonEmpty(s) && overlaps(facts.scopes.writerScope, s));
    if (conflict) {
      return err(
        "scope_conflict",
        "Writer scope collides with shared, GUI, or active writer scopes.",
      );
    }
  }

  const dispatchKey = dispatchKeyFor({
    attemptNumber: request.attempt.attemptNumber,
    environmentId: facts.environmentId,
    missionId: mission.id,
    operation: request.attempt.operation,
    taskId: request.taskId,
    teamId: facts.teamId,
  });
  const digest = requestDigestFor({
    accountId: facts.account.accountId,
    attemptNumber: request.attempt.attemptNumber,
    billingMode: facts.account.billingMode,
    dependencyHashes: request.dependencyHashes,
    dependencyReceipts: canonicalDepReceipts,
    environmentId: facts.environmentId,
    missionId: mission.id,
    modelId: facts.route.modelId,
    operation: request.attempt.operation,
    optionsHash: request.optionsHash,
    privilege: request.privilege,
    profile: facts.route.profile,
    promptHash: request.promptHash,
    providerInstanceId: facts.account.providerInstanceId,
    specHash: request.specHash,
    taskId: request.taskId,
    teamId: facts.teamId,
    workspaceRoot: request.workspaceRoot,
  });

  // Same-key recovery: retrieval only, after all scope/auth/hash checks above.
  // No new usage/host/lease capacity is required to read admitted state.
  const prior = facts.priorReceipts.find((r) => r.dispatchKey === dispatchKey);
  if (prior !== undefined) {
    return prior.requestDigest === digest
      ? Result.succeed({
          receipt: prior,
          recovered: true,
          dispatchAuthorized: false,
          exceptionConsumptionRef: null,
        })
      : err(
          "digest_conflict",
          "Same logical attempt was already admitted with a different digest.",
          dispatchKey,
        );
  }

  // --- Fresh dispatch only: freshness, usage, host, lease ---
  if (facts.taskNecessary !== true) {
    return err("task_not_ready", "Canonical task state does not require another assignment.");
  }
  if (!freshTimestamp(facts.account.verifiedAtMs, facts.nowMs, maxFactAge)) {
    return err("account_mismatch", "Account verification is non-finite, future, or stale.");
  }
  if (!freshTimestamp(facts.host.observedAtMs, facts.nowMs, maxFactAge)) {
    return err("host_not_observed", "Host observation is non-finite, future, or stale.");
  }
  if (!freshTimestamp(facts.repository.observedAtMs, facts.nowMs, maxFactAge)) {
    return err("ancestry_mismatch", "Repository observation is non-finite, future, or stale.");
  }
  // Validate quota numbers before trusting headroom classification.
  if (facts.usageLimits !== undefined) {
    const badWindow = facts.usageLimits.windows.some(
      (w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0,
    );
    if (badWindow) {
      return err("usage_unknown", "Usage window has non-finite or negative usedPercent.");
    }
  }
  const usage = usageHeadroom(facts.usageLimits, facts.nowMs, {
    model: request.modelId,
    maxObservationAgeMs: facts.usageMaxObservationAgeMs,
    trustUnresetWindow: facts.usageSource === "muse",
  });
  let exceptionConsumptionRef: string | null = null;
  let exceptionId: string | null = null;
  if (usage.headroom === "exhausted") {
    return err("usage_exhausted", `No headroom for '${request.modelId}': ${usage.summary}.`);
  }
  if (usage.headroom === "low") {
    return err("usage_low", `Low headroom preserved for '${request.modelId}': ${usage.summary}.`);
  }
  if (usage.headroom === "unknown") {
    const ex = facts.unknownUsageException;
    const hasCapacity =
      ex !== undefined &&
      ((ex.remainingAssignments !== undefined &&
        Number.isInteger(ex.remainingAssignments) &&
        ex.remainingAssignments === 1) ||
        (ex.remainingAssignments === undefined && ex.unused === true));
    const bounded =
      ex !== undefined &&
      nonEmpty(ex.exceptionId) &&
      nonEmpty(ex.authorityRef) &&
      ex.accountId === facts.account.accountId &&
      ex.taskId === request.taskId &&
      ex.attemptNumber === request.attempt.attemptNumber &&
      Number.isFinite(ex.issuedAtMs) &&
      Number.isFinite(ex.expiresAtMs) &&
      ex.issuedAtMs <= facts.nowMs &&
      facts.nowMs <= ex.expiresAtMs &&
      ex.expiresAtMs > ex.issuedAtMs &&
      ex.expiresAtMs - ex.issuedAtMs <= MAX_UNKNOWN_USAGE_EXCEPTION_MS &&
      hasCapacity;
    if (!bounded || ex === undefined) {
      return err(
        "usage_unknown",
        `Usage is unknown and no scoped live one-assignment exception applies: ${usage.summary}.`,
      );
    }
    exceptionId = ex.exceptionId;
    exceptionConsumptionRef = `${ex.exceptionId}:${dispatchKey}`;
  }
  const host = facts.host;
  if (!nonEmpty(host.hostId) || !nonEmpty(host.bootId)) {
    return err("host_not_observed", "Host and boot identity are not verified.");
  }
  if (!host.buildObserved || !host.toolchainObserved || !host.pressureObserved) {
    return err("host_not_observed", "Host readiness signals were not all observed.");
  }
  if (
    host.capacity !== undefined &&
    (!freshTimestamp(host.capacity.observedAtMs, facts.nowMs, maxFactAge) ||
      host.capacity.hostId !== host.hostId ||
      host.capacity.bootId !== host.bootId ||
      !host.capacity.ready)
  ) {
    return err(
      "host_not_ready",
      `Host capacity blocks dispatch: ${host.capacity.reasons.join(", ") || "stale or mismatched observation"}.`,
    );
  }
  if (!host.ready || !host.buildOk || !host.toolchainOk || !host.pressureAcceptable) {
    return err("host_not_ready", "Host is not ready to dispatch.");
  }
  // Any uncertain/expired/cancel-only prior blocks EVERY conflicting new attempt.
  const lease = facts.priorAttempt;
  if (lease.cancelRequested || lease.state === "uncertain" || lease.leaseExpired) {
    return err(
      "lease_uncertain",
      "Uncertain, expired, or cancel-only prior attempt blocks any new dispatch.",
    );
  }

  return Result.succeed({
    receipt: {
      accountBudget: { accountId: facts.account.accountId, billingMode: facts.account.billingMode },
      admittedAtMs: facts.nowMs,
      attemptNumber: request.attempt.attemptNumber,
      chosenRoute: {
        modelId: facts.route.modelId,
        providerInstanceId: facts.account.providerInstanceId,
        profile: facts.route.profile,
      },
      dispatchKey,
      environmentId: facts.environmentId,
      evidenceTimestamps: {
        accountVerifiedAtMs: facts.account.verifiedAtMs,
        hostObservedAtMs: facts.host.observedAtMs,
        repositoryObservedAtMs: facts.repository.observedAtMs,
      },
      exceptionConsumptionRef,
      hostSlot: {
        hostId: host.hostId,
        bootId: host.bootId,
        epoch: facts.deliveryEpoch,
        threadId: facts.deliveryThreadId,
      },
      missionId: mission.id,
      operation: request.attempt.operation,
      rejectedRoutes: request.rejectedRoutes,
      requestDigest: digest,
      taskId: request.taskId,
      teamId: facts.teamId,
      unknownUsageException: exceptionConsumptionRef !== null,
      unknownUsageExceptionId: exceptionId,
    },
    recovered: false,
    dispatchAuthorized: true,
    exceptionConsumptionRef,
  });
};
