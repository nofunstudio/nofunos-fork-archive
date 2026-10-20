import { Mission, dependencyReceiptHashesFromAcceptedResults } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderCapacityReader } from "./ProviderCapacity.ts";
import { readExecutionCapacity, withExecutionCapacity } from "./ExecutionCapacity.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { MissionAdmissionRequest } from "./MissionAdmission.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Configuration from "./MissionAdmissionConfiguration.ts";

/** Bounded diagnostics carried by the store error; no proposal values enter the reason. */
export class MissionAdmissionFactsUnavailable extends Schema.TaggedError<MissionAdmissionFactsUnavailable>()(
  "MissionAdmissionFactsUnavailable",
  {
    reason: Schema.Literals([
      "authority_unavailable",
      "mission_unavailable",
      "task_unavailable",
      "delivery_mismatch",
      "canonical_facts_unavailable",
    ]),
    missing: Schema.Array(
      Schema.Literals([
        "writerScope",
        "sharedManifestScopes",
        "guiScopes",
        "taskNecessary",
        "company",
        "billingMode",
        "capability",
      ]),
    ),
  },
) {}

// Existing admission fixtures allow 30 minutes for passive quota observations;
// account, repository and host authority keep the decision's stricter 5 minute bound.
export const USAGE_MAX_OBSERVATION_AGE_MS = 30 * 60_000;
export const MAX_FACT_AGE_MS = 5 * 60_000;

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* Effect.serviceOption(MissionService.MissionAuthority);
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const readCapacity = yield* makeProviderCapacityReader;
  const configuration = yield* Effect.serviceOption(Configuration.MissionAdmissionConfiguration);
  const denied = (
    reason: MissionAdmissionFactsUnavailable["reason"],
    missing: MissionAdmissionFactsUnavailable["missing"] = [],
  ) =>
    new MissionAdmissionStore.MissionAdmissionStoreError({
      operation: "reserve",
      category: "scope_denied",
      cause: new MissionAdmissionFactsUnavailable({ reason, missing }),
    });
  const persistenceError = (cause: unknown) =>
    new MissionAdmissionStore.MissionAdmissionStoreError({
      operation: "reserve",
      category: "persistence",
      cause,
    });

  const readFacts = Effect.fn("MissionAdmissionFacts.readFacts")(function* (
    request: MissionAdmissionRequest,
  ): Effect.fn.Return<
    MissionAdmissionStore.MissionAdmissionTrustedFacts,
    MissionAdmissionStore.MissionAdmissionStoreError
  > {
    if (Option.isNone(authority)) return yield* denied("authority_unavailable");
    const scope = authority.value;
    if (
      request.mission.teamId !== scope.teamId ||
      request.mission.authorityEnvironmentId !== scope.environmentId
    ) {
      return yield* denied("mission_unavailable");
    }
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${request.mission.id}
        AND team_id = ${scope.teamId}
        AND authority_environment_id = ${scope.environmentId}
    `.pipe(Effect.mapError(persistenceError));
    const row = rows[0];
    if (row === undefined) return yield* denied("mission_unavailable");
    const mission = yield* decodeMission(row.snapshot_json).pipe(Effect.mapError(persistenceError));
    if (mission.revision !== row.revision) return yield* persistenceError(undefined);
    if (
      mission.id !== request.mission.id ||
      mission.teamId !== scope.teamId ||
      mission.authorityEnvironmentId !== scope.environmentId
    ) {
      return yield* denied("mission_unavailable");
    }
    const delivery = mission.managers.delivery;
    if (delivery?.threadId !== scope.controllerThreadId || delivery.epoch === undefined) {
      return yield* denied("delivery_mismatch");
    }
    const task = mission.tasks.find((task) => task.id === request.taskId);
    if (task === undefined) return yield* denied("task_unavailable");
    const observations = Option.isSome(configuration)
      ? yield* configuration.value.read(scope)
      : undefined;
    const qualified = {
      ...scope,
      ...(observations === undefined
        ? {}
        : {
            company: observations.company,
            hostQualification: observations.hostQualification,
            repositoryObservations: observations.repositoryObservations,
          }),
    };
    const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
    const matches = providers.filter(
      (provider) => provider.instanceId === request.proposedProviderInstanceId,
    );
    const provider = matches.length === 1 ? matches[0] : undefined;
    const configured = observations?.providers.filter(
      (entry) => entry.instanceId === request.proposedProviderInstanceId,
    );
    if (configured !== undefined && configured.length !== 1)
      return yield* denied("canonical_facts_unavailable");
    // Prefer a provider-owned attestation when one exists. A local observation
    // cannot overwrite a live account or route change on that same instance.
    const attestation = provider?.admissionAttestation ?? configured?.[0];
    const missing: Array<MissionAdmissionFactsUnavailable["missing"][number]> = [];
    if (task.writerScope === undefined) missing.push("writerScope");
    if (task.sharedManifestScopes === undefined) missing.push("sharedManifestScopes");
    if (task.guiScopes === undefined) missing.push("guiScopes");
    if (task.taskNecessary === undefined) missing.push("taskNecessary");
    if (qualified.company === undefined || attestation === undefined) missing.push("company");
    if (attestation === undefined) missing.push("billingMode", "capability");
    if (missing.length > 0) return yield* denied("canonical_facts_unavailable", missing);
    if (
      provider === undefined ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status !== "authenticated" ||
      provider.availability === "unavailable" ||
      attestation === undefined ||
      qualified.company !== attestation.company ||
      task.writerScope === undefined ||
      task.sharedManifestScopes === undefined ||
      task.guiScopes === undefined ||
      task.taskNecessary === undefined
    )
      return yield* denied("canonical_facts_unavailable");
    const routes = attestation.routes.filter(
      (route) => route.modelId === request.modelId && route.profile === request.profile,
    );
    const route = routes.length === 1 ? routes[0] : undefined;
    // An empty catalog, an unknown model, or another account never grants a route.
    if (route === undefined || !provider.models.some((model) => model.slug === request.modelId)) {
      return yield* denied("canonical_facts_unavailable", ["capability"]);
    }
    const repository = qualified.repositoryObservations?.filter(
      (observation) => observation.projectId === task.projectId,
    );
    const qualification = qualified.hostQualification;
    if (repository?.length !== 1 || qualification === undefined)
      return yield* denied("canonical_facts_unavailable");
    const nowMs = yield* Clock.currentTimeMillis;
    const capacity = yield* Effect.promise(() =>
      readExecutionCapacity(repository[0]!.workspaceRootRealpath, nowMs),
    );
    const usage = yield* readCapacity(providers);
    return {
      taskNecessary: task.taskNecessary,
      nowMs,
      teamId: scope.teamId,
      environmentId: scope.environmentId,
      deliveryThreadId: delivery.threadId,
      deliveryEpoch: delivery.epoch,
      account: {
        accountId: attestation.accountId,
        providerInstanceId: provider.instanceId,
        billingMode: attestation.billingMode,
        company: attestation.company,
        verifiedAtMs: attestation.verifiedAtMs,
      },
      route: {
        accountId: attestation.accountId,
        providerInstanceId: provider.instanceId,
        billingMode: attestation.billingMode,
        modelId: route.modelId,
        profile: route.profile,
        capability: route.capability,
        supportedModelIds: [...route.supportedModelIds],
      },
      usageLimits: usage.get(provider.instanceId)?.limits,
      usageMaxObservationAgeMs: USAGE_MAX_OBSERVATION_AGE_MS,
      maxFactAgeMs: MAX_FACT_AGE_MS,
      host: withExecutionCapacity(
        {
          ...qualification,
          ready: qualification.buildOk && qualification.toolchainOk,
          pressureObserved: false,
          pressureAcceptable: false,
        },
        capacity,
      ),
      repository: { ...repository[0]! },
      writerScope: task.writerScope,
      sharedManifestScopes: [...task.sharedManifestScopes],
      guiScopes: [...task.guiScopes],
      dependencyReceipts: dependencyReceiptHashesFromAcceptedResults(
        mission.execution?.results ?? [],
      ),
    };
  });

  return MissionAdmissionStore.MissionAdmissionFactsPort.of({ readFacts });
});

export const layer = Layer.effect(MissionAdmissionStore.MissionAdmissionFactsPort, make);
