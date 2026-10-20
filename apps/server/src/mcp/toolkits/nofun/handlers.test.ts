import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerRenderHandlers } from "./handlers.ts";
import { NofunArtifactRenderTool, NofunArtifactRenderToolkit } from "./tools.ts";

const threadId = ThreadId.make("w2-render-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const SPEC = { root: { component: "Text", props: { text: "Bundle test" } } };
const published: string[] = [];
const decodeInput = Schema.decodeUnknownSync(NofunArtifactRenderTool.parametersSchema);
const decodeResult = Schema.decodeUnknownSync(NofunArtifactRenderTool.successSchema);

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-nofun-render-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("test"),
    requestNamespace: "test-session",
    thread: { threadId, providerSessionId: "test-session", providerInstanceId },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        providerInstanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
        activeRunId: "test-run",
        archivedAt: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell),
  }),
  // Keep attachment storage isolated: both artifact compilers and the bundle disk writer are real.
  Layer.mock(HtmlRender.HtmlRender)({
    publish: ({ html, title, height }) =>
      Effect.sync(() => {
        published.push(html);
        return { attachmentId: "test-attachment", title, height };
      }),
  }),
);

const runRender = (input: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* NofunArtifactRenderToolkit.pipe(Effect.provide(layerRenderHandlers));
    const decoded = decodeInput(input);
    const result = yield* toolkit
      .handle("nofun_artifact_render", decoded)
      .pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)!.result;
  });

it("accepts the explicit Canvas output mode and rejects unsupported modes", () => {
  expect(decodeInput({ title: "Output", spec: SPEC, output: "canvas-bundle" })).toHaveProperty(
    "output",
    "canvas-bundle",
  );
  expect(() => decodeInput({ title: "Output", spec: SPEC, output: "pdf" })).toThrow();
});

// Real-compiler integration, like the package's tool-bundle tests. Run with a pinned components
// checkout and built runtime; pure tool-schema coverage above always runs.
const canCompile =
  NodeFS.existsSync(NodePath.join(process.env.NOFUN_COMPONENTS_DIR ?? "", "registry.json")) &&
  NodeFS.existsSync(
    NodePath.join(process.env.NOFUN_UI_RUNTIME_ROOT ?? "", "580e64f46a50", "runtime.js"),
  );

describe.skipIf(!canCompile)("nofun_artifact_render Canvas output", () => {
  it.effect(
    "output canvas-bundle returns an entry-hashed pinned bundle ready for place_artifact",
    () =>
      Effect.gen(function* () {
        const input = decodeInput({
          title: "Canvas bundle",
          spec: SPEC,
          output: "canvas-bundle",
          bundle: { size: "800x500" },
        });
        expect(input).toHaveProperty("output", "canvas-bundle");
        const result = yield* runRender(input);
        expect(result).toMatchObject({
          htmlRender: { attachmentId: "test-attachment" },
          bundle: { runtime: { version: "580e64f46a50" } },
          place_artifact: { bundle_path: expect.any(String) },
        });
        const success = decodeResult(result);
        // Decode the advertised result schema as well: MCP must not discard the placement arguments.
        const dir = success.place_artifact!.bundle_path;
        const manifest = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, "manifest.json"), "utf8"),
        );
        const html = NodeFS.readFileSync(NodePath.join(dir, "index.html"), "utf8");
        expect(manifest).toMatchObject({
          format: "nofun-canvas-artifact-bundle",
          size: { width: 800, height: 500 },
          runtime: { version: "580e64f46a50" },
        });
        expect(manifest.sha256).toBe(NodeCrypto.createHash("sha256").update(html).digest("hex"));
        expect(html).toContain("nofun-ui://runtime/580e64f46a50/runtime.js");
        expect(
          JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "stamp.json"), "utf8")),
        ).toMatchObject({ linked: "580e64f46a50", at: manifest.createdAt });
        expect(success.bundle).toMatchObject({
          directory: dir,
          stampPath: NodePath.join(dir, "stamp.json"),
          sha256: manifest.sha256,
        });
        expect(published.at(-1)).toContain("Bundle test");
      }).pipe(Effect.provide(dependencies)),
  );

  it.effect(
    "output canvas-bundle works without the legacy bundle option, including decimal columns",
    () =>
      Effect.gen(function* () {
        const result = yield* runRender({
          title: "Decimal table",
          output: "canvas-bundle",
          spec: {
            root: {
              component: "DataTable",
              props: {
                columns: [{ key: "n", label: "N", format: "decimal" }],
                rows: [{ n: 1234.56 }],
              },
            },
          },
        });
        expect(result).toMatchObject({
          bundle: { runtime: { version: "580e64f46a50" } },
          place_artifact: { bundle_path: expect.any(String) },
        });
        const success = decodeResult(result);
        const html = NodeFS.readFileSync(
          NodePath.join(success.place_artifact!.bundle_path, "index.html"),
          "utf8",
        );
        const data = JSON.parse(
          /<script type="application\/json" id="nf-spec">([^<]*)<\/script>/.exec(html)![1]!,
        );
        expect(data.root.props.columns[0].format).toBe("number");
      }).pipe(Effect.provide(dependencies)),
  );

  it.effect("legacy bundle requests also return placement arguments", () =>
    Effect.gen(function* () {
      const result = yield* runRender({ title: "Legacy bundle", spec: SPEC, bundle: {} });
      expect(result).toMatchObject({ place_artifact: { bundle_path: expect.any(String) } });
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("omitted output and explicit html retain HTML-only behavior", () =>
    Effect.gen(function* () {
      for (const output of [undefined, "html"]) {
        const result = yield* runRender({
          title: "HTML only",
          spec: SPEC,
          ...(output ? { output } : {}),
        });
        expect(result).toHaveProperty("htmlRender.attachmentId", "test-attachment");
        expect(result).not.toHaveProperty("bundle");
        expect(result).not.toHaveProperty("place_artifact");
      }
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("missing pinned runtime fails before publishing the thread attachment", () =>
    Effect.gen(function* () {
      const before = published.length;
      const result = yield* runRender({
        title: "Missing runtime",
        spec: SPEC,
        output: "canvas-bundle",
        bundle: { runtimeVersion: "deadbeef" },
      });
      expect(result).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("no built runtime"),
      });
      expect(result).not.toHaveProperty("htmlRender");
      expect(published.length).toBe(before);
    }).pipe(Effect.provide(dependencies)),
  );
});
