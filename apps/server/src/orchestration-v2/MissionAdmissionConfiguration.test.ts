import { EnvironmentId, TeamId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import * as Config from "../config.ts";
import * as Configuration from "./MissionAdmissionConfiguration.ts";

const scope = {
  teamId: TeamId.make("team-admission"),
  environmentId: EnvironmentId.make("environment-admission"),
};
const layer = Configuration.layer.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "bk1-admission-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "reads only private, complete server admission observations for the exact team and environment",
  () =>
    Effect.gen(function* () {
      const service = yield* Configuration.MissionAdmissionConfiguration;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* Config.ServerConfig;
      const now = yield* Clock.currentTimeMillis;
      const filename = path.join(config.stateDir, "nofun", "mission-admission.json");
      expect((yield* service.read(scope).pipe(Effect.flip)).category).toBe("scope_denied");
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      const observation = {
        version: 1,
        ...scope,
        company: "No Fun",
        hostQualification: {
          hostId: "host",
          bootId: "boot",
          buildObserved: true,
          buildOk: true,
          toolchainObserved: true,
          toolchainOk: true,
          observedAtMs: now,
        },
        repositoryObservations: [
          {
            projectId: "project",
            workspaceRootRealpath: "/workspace/project",
            observedAncestry: ["base"],
            observedAtMs: now,
          },
        ],
        providers: [
          {
            instanceId: "provider",
            accountId: "account",
            company: "No Fun",
            billingMode: "subscription",
            verifiedAtMs: now,
            routes: [
              {
                modelId: "gpt-6.1-sol",
                profile: "default",
                capability: "read_only",
                supportedModelIds: ["gpt-6.1-sol"],
              },
            ],
          },
        ],
      };
      yield* fs.writeFileString(filename, json(observation), { mode: 0o600 });
      expect((yield* service.read(scope)).providers[0]?.accountId).toBe("account");
      expect(
        (yield* service.read({ ...scope, teamId: TeamId.make("other") }).pipe(Effect.flip))
          .category,
      ).toBe("scope_denied");
      yield* fs.chmod(filename, 0o666);
      expect((yield* service.read(scope).pipe(Effect.flip)).category).toBe("scope_denied");
      yield* fs.chmod(filename, 0o600);
      yield* fs.writeFileString(
        filename,
        json({ ...observation, providers: [{ instanceId: "provider" }] }),
      );
      expect((yield* service.read(scope).pipe(Effect.flip)).category).toBe("scope_denied");
    }).pipe(Effect.provide(layer)),
);
