import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  ArtifactCompileError,
  ArtifactSpecError,
  compileArtifact,
  searchComponents,
  sourceStamp,
  type ArtifactCompileInput,
  type CompiledArtifact,
} from "@t3tools/nofun-artifacts/compiler";
import {
  emitToolBundle,
  type ToolBundle,
  type ToolBundleOptions,
} from "@t3tools/nofun-artifacts/tool-bundle";
import { HTML_RENDER_MAX_HEIGHT } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { AiError, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as GuideHandlers from "./guideHandlers.ts";
import * as PageHandlers from "./pageHandlers.ts";
import type * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { playbookFor } from "../../../nofun/playbook.ts";
import { readMutationCaller } from "../../threadAccess.ts";
import {
  NofunArtifactPreviewTool,
  NofunArtifactPreviewToolkit,
  NofunArtifactRenderToolkit,
  NofunComponentsSearchToolkit,
  type NofunArtifactToolkit,
} from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** esbuild and Tailwind run in this process; the generated TSX is only parsed and bundled, never executed here. */
const compile = (input: ArtifactCompileInput) =>
  Effect.tryPromise({
    try: () => compileArtifact(input),
    catch: (error) =>
      error instanceof ArtifactSpecError || error instanceof ArtifactCompileError
        ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
        : new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `The No Fun artifact compiler failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
  }).pipe(Effect.withSpan("NofunArtifact.compile"));

/** Writes the Canvas bundle for a render that asked for one; a missing runtime is a failure, never an unpinned bundle. */
const writeBundle = (
  input: ArtifactCompileInput & {
    readonly title: string;
    readonly bundle: ToolBundleOptions;
  },
  outRoot: string,
) =>
  Effect.tryPromise({
    try: (): Promise<ToolBundle> =>
      emitToolBundle({
        spec: input.spec,
        tsx: input.tsx,
        theme: input.theme,
        title: input.title,
        outRoot,
        size: input.bundle.size,
        background: input.bundle.background,
        runtimeVersion: input.bundle.runtimeVersion,
      }),
    catch: (error) =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Could not write the Canvas bundle: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(Effect.withSpan("NofunArtifact.bundle"));

const stats = (compiled: CompiledArtifact) => ({
  theme: compiled.theme,
  lane: compiled.lane,
  bytes: compiled.bytes,
  compileMs: compiled.compileMs,
});

const handlers = {
  nofun_artifact_preview: (input) =>
    Effect.gen(function* () {
      // Same gate as html_preview: the headless browser runs on the host.
      yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "nofun_artifact_preview",
      );
      const compiled = yield* compile(input);
      const htmlRender = yield* HtmlRender.HtmlRender;
      const caller = yield* McpInvocationContext.McpInvocationContext;
      const { png, ...preview } = yield* htmlRender
        .preview({ html: compiled.html, width: input.width, appearance: input.appearance })
        .pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        artifact: stats(compiled),
        ...playbookFor(caller),
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  nofun_artifact_render: (input) =>
    Effect.gen(function* () {
      // Stored in the calling thread like html_render, so it needs that thread's live run.
      const { scope } = yield* readMutationCaller();
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "nofun_artifact_render",
      );
      const compiled = yield* compile(input);
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      // Before anything is stored in the thread: a bundle request that cannot be pinned fails whole.
      const bundleOptions = input.bundle ?? (input.output === "canvas-bundle" ? {} : undefined);
      const bundle = bundleOptions
        ? yield* writeBundle(
            { ...input, bundle: bundleOptions },
            path.join(config.stateDir, "artifact-bundles", thread.threadId),
          )
        : undefined;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const reference = yield* htmlRender
        .publish({
          threadId: thread.threadId,
          html: compiled.html,
          title: input.title,
          height: input.height ?? HTML_RENDER_MAX_HEIGHT,
        })
        .pipe(Effect.mapError(toFailure));
      // Unspecified: a dashboard-sized spec (3+ top-level children) or any tsx opens as a card.
      const specChildren = (input.spec as { root?: { children?: unknown } } | undefined)?.root
        ?.children;
      const large =
        input.tsx !== undefined || (Array.isArray(specChildren) && specChildren.length >= 3);
      const display = input.display ?? (large ? "card" : "inline");
      const autoOpen = input.open ?? (input.display === undefined && large);
      return {
        htmlRender: { ...reference, display, autoOpen },
        artifact: stats(compiled),
        ...(bundle
          ? {
              bundle: {
                directory: bundle.dir,
                manifestPath: bundle.manifestPath,
                stampPath: path.join(bundle.dir, "stamp.json"),
                sha256: bundle.manifest.sha256,
                createdAt: bundle.manifest.createdAt,
                runtime: bundle.runtime,
              },
              place_artifact: { bundle_path: bundle.dir },
            }
          : {}),
        message:
          "Shown to the reader above your reply. Don't mention or describe the artifact; reply with only what it doesn't already say.",
        ...playbookFor({ thread }),
      };
    }),
} satisfies Parameters<typeof NofunArtifactToolkit.toLayer>[0];

const layerSearchHandlers = NofunComponentsSearchToolkit.toLayer({
  // Reads the live nofun-components index (registry.json + ontology); never the whole index.
  nofun_components_search: (input) =>
    Effect.gen(function* () {
      const caller = yield* McpInvocationContext.McpInvocationContext;
      const found = yield* Effect.tryPromise({
        try: async () => ({
          source: await sourceStamp(),
          matches: await searchComponents(input),
        }),
        catch: (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `No Fun component search failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
      return { ...found, ...playbookFor(caller) };
    }).pipe(Effect.withSpan("NofunComponents.search")),
});

const layerPreviewHandlers = NofunArtifactPreviewToolkit.toLayer({
  nofun_artifact_preview: handlers.nofun_artifact_preview,
});

export const layerRenderHandlers = NofunArtifactRenderToolkit.toLayer({
  nofun_artifact_render: handlers.nofun_artifact_render,
});

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

/**
 * The No Fun artifact tools. The preview returns an image, so it registers through the same
 * image-tool path as html_preview, which McpHttpServer hands in.
 */
export const makeLayer = (registerImageTool: typeof McpHttpServer.registerImageTool) => {
  const registerPreview = Effect.fn("McpHttpServer.registerNofunArtifactPreview")(function* () {
    const htmlRender = yield* HtmlRender.HtmlRender;
    const built = yield* NofunArtifactPreviewToolkit;
    yield* registerImageTool(
      NofunArtifactPreviewTool,
      (payload) =>
        built
          .handle("nofun_artifact_preview", payload)
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
      (effect) => effect.pipe(Effect.provideService(HtmlRender.HtmlRender, htmlRender)),
      "preview",
      (error) =>
        isOrchestratorMcpFailure(error) || AiError.isAiError(error)
          ? error.message
          : "No Fun artifact preview failed.",
    );
  });
  return Layer.mergeAll(
    McpServer.toolkit(NofunArtifactRenderToolkit).pipe(Layer.provide(layerRenderHandlers)),
    McpServer.toolkit(NofunComponentsSearchToolkit).pipe(Layer.provide(layerSearchHandlers)),
    Layer.effectDiscard(registerPreview()).pipe(Layer.provide(layerPreviewHandlers)),
    PageHandlers.makeLayer(),
    GuideHandlers.makeLayer(),
  ).pipe(Layer.provide(HtmlRender.layer));
};
