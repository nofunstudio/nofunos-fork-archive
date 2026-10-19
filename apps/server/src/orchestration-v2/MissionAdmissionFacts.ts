import { Mission } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { MissionAdmissionRequest } from "./MissionAdmission.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import * as MissionService from "./MissionService.ts";

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

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* Effect.serviceOption(MissionService.MissionAuthority);
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
    if (!mission.tasks.some((task) => task.id === request.taskId)) {
      return yield* denied("task_unavailable");
    }

    // MissionTaskSpec does not persist these task authorities; ServerProvider
    // does not attest company, billing or route capability. Until their owning
    // contracts supply them, every attempt must be denied. In particular, do
    // not infer a writer scope from the repository root, parse free text, or
    // accept extra JSON fields that the canonical schema discards. Passive
    // usage/ExecutionCapacity observations cannot establish these authorities.
    return yield* denied("canonical_facts_unavailable", [
      "writerScope",
      "sharedManifestScopes",
      "guiScopes",
      "taskNecessary",
      "company",
      "billingMode",
      "capability",
    ]);
  });

  return MissionAdmissionStore.MissionAdmissionFactsPort.of({ readFacts });
});

export const layer = Layer.effect(MissionAdmissionStore.MissionAdmissionFactsPort, make);
