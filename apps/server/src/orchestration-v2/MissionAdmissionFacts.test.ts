import { MissionTaskSpec } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

// B-02 prerequisite: production readFacts must obtain scope from the canonical
// task, never from the proposal. Keep this regression red until the owning
// contract/persistence lane supplies that authority; do not invent a scope.
it("canonical mission tasks retain admission scope through persistence", () => {
  const task = {
    id: "task-admission",
    projectId: "project-admission",
    title: "Write only the assigned scope",
    specHash: "spec-hash",
    dependencyHashes: [],
    dependencies: [],
    acceptanceIds: ["acceptance-admission"],
    updatedAt: "2026-10-19T07:30:00.000Z",
    writerScope: "/workspace/project/src/admission",
    sharedManifestScopes: ["/workspace/project/package.json"],
    guiScopes: [],
  };
  const persisted = Schema.encodeSync(Schema.fromJsonString(MissionTaskSpec))(
    Schema.decodeUnknownSync(MissionTaskSpec)(task),
  );
  const restored = Schema.decodeUnknownSync(Schema.fromJsonString(MissionTaskSpec))(persisted);

  expect(restored).toMatchObject({
    writerScope: task.writerScope,
    sharedManifestScopes: task.sharedManifestScopes,
    guiScopes: task.guiScopes,
  });
});
