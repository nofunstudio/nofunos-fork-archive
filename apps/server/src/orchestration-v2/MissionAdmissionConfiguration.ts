import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProviderAdmissionAttestation,
  TeamId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import { MissionAdmissionStoreError } from "./MissionAdmissionStore.ts";

const Millis = Schema.Number.check(Schema.makeFilter((n) => Number.isFinite(n) && n >= 0));
const Observation = Schema.Struct({
  version: Schema.Literal(1),
  teamId: TeamId,
  environmentId: EnvironmentId,
  company: Schema.Literal("No Fun"),
  hostQualification: Schema.Struct({
    hostId: TrimmedNonEmptyString,
    bootId: TrimmedNonEmptyString,
    buildObserved: Schema.Boolean,
    buildOk: Schema.Boolean,
    toolchainObserved: Schema.Boolean,
    toolchainOk: Schema.Boolean,
    observedAtMs: Millis,
  }),
  repositoryObservations: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      workspaceRootRealpath: TrimmedNonEmptyString,
      observedAncestry: Schema.Array(TrimmedNonEmptyString),
      observedAtMs: Millis,
    }),
  ),
  providers: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      ...ServerProviderAdmissionAttestation.fields,
    }),
  ),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Observation), {
  onExcessProperty: "error",
});
const MAX_BYTES = 64 * 1024;

export class MissionAdmissionConfiguration extends Context.Service<
  MissionAdmissionConfiguration,
  {
    readonly read: (scope: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<typeof Observation.Type, MissionAdmissionStoreError>;
  }
>()("t3/orchestration-v2/MissionAdmissionConfiguration") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const filename = path.join(config.stateDir, "nofun", "mission-admission.json");
  const denied = () =>
    new MissionAdmissionStoreError({ operation: "reserve", category: "scope_denied" });
  return MissionAdmissionConfiguration.of({
    read: (scope) =>
      Effect.gen(function* () {
        // This file is an explicit local attestation, never tool input. Read it
        // again for each preparation so removing it immediately revokes admission.
        const info = yield* fs.stat(filename);
        const uid = process.getuid?.();
        const size = ByteSize.toBigInt(info.size);
        if (
          info.type !== "File" ||
          (info.mode & 0o077) !== 0 ||
          size <= 0n ||
          size > BigInt(MAX_BYTES) ||
          (uid !== undefined && Option.isSome(info.uid) && info.uid.value !== uid)
        )
          return yield* denied();
        const bytes = yield* fs.stream(filename, { bytesToRead: MAX_BYTES + 1 }).pipe(
          Stream.runFoldEffect(
            () => new Uint8Array(),
            (previous, chunk) => {
              if (previous.byteLength + chunk.byteLength > MAX_BYTES) return Effect.fail(denied());
              const next = new Uint8Array(previous.byteLength + chunk.byteLength);
              next.set(previous);
              next.set(chunk, previous.byteLength);
              return Effect.succeed(next);
            },
          ),
        );
        if (BigInt(bytes.byteLength) !== size) return yield* denied();
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: denied,
        });
        const observation = yield* decode(text);
        if (
          observation.teamId !== scope.teamId ||
          observation.environmentId !== scope.environmentId
        )
          return yield* denied();
        return observation;
      }).pipe(Effect.mapError(denied)),
  });
});

export const layer = Layer.effect(MissionAdmissionConfiguration, make);
