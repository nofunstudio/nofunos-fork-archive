import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  ARTIFACT_ALLOWED_PACKAGES,
  artifactCatalogGuide,
  artifactThemeGuide,
} from "@t3tools/nofun-artifacts/compiler";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
} from "@t3tools/shared/htmlRender";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const NOFUN_ARTIFACT_RENDER_TOOL_NAME = "nofun_artifact_render";
export const NOFUN_ARTIFACT_PREVIEW_TOOL_NAME = "nofun_artifact_preview";
export const NOFUN_COMPONENTS_SEARCH_TOOL_NAME = "nofun_components_search";

const SPEC_EXAMPLE = JSON.stringify({
  root: {
    component: "Stack",
    children: [
      { component: "Text", props: { variant: "title", text: "Week 40" } },
      {
        component: "Grid",
        props: { columns: 3 },
        children: [
          {
            component: "Metric",
            props: {
              label: "Revenue",
              value: 48210,
              format: "currency",
              change: 12.4,
              trend: [31, 38, 44, 48],
            },
          },
        ],
      },
      {
        component: "Chart",
        props: {
          type: "bar",
          title: "Orders",
          xKey: "week",
          series: [{ key: "orders", label: "Orders" }],
          data: [
            { week: "W39", orders: 1210 },
            { week: "W40", orders: 1284 },
          ],
        },
      },
    ],
  },
});

const TSX_EXAMPLE = `import { useState } from "react"; import { Stack, Button, DataTable } from "@nofun/artifacts"; import { ChartArea, ChartAreaPlot } from "@nofun/ui/chart-area"; const ROWS = [...]; export default function App() { const [only, setOnly] = useState(false); return <Stack><ChartArea><ChartAreaPlot data={ROWS} xKey="week" series={[{ key: "orders", label: "Orders" }]} /></ChartArea><Button size="sm" onClick={() => setOnly(!only)}>Open only</Button><DataTable columns={[...]} rows={only ? ROWS.filter((r) => r.open) : ROWS} /></Stack>; }`;

export const NOFUN_ARTIFACT_GUIDE = [
  "Builds a No Fun artifact from the real No Fun component library (Kobra primitives and No Fun blocks) and a No Fun theme, as one self-contained page. Text stays primary: use it only when a dashboard, chart, table, comparison, timeline or gallery says more than prose, and only with real data you read from tools or the user. Never invent metrics, progress or verification badges.",
  `Two lanes, pass exactly one. spec: a JSON object {"root": node}, node = {"component", "props", "children"?}. Components (* = required prop):\n${artifactCatalogGuide()}\nExample spec: ${SPEC_EXAMPLE}`,
  `tsx: custom React compiled against the live No Fun library (~280 real blocks: heroes, charts, data, effects, AI, forms, navigation, landing sections...). It must \`export default\` a component. Imports: "react"; any block as "@nofun/ui/<registry-name>" (find names, exports and props with ${NOFUN_COMPONENTS_SEARCH_TOOL_NAME}; "@nofun/ui/<name>/demo" is a working example of each); Kobra primitives as "@nofun/kobra/<name>" (button, card, badge, table, tabs, dialog...); "@nofun/artifacts" (the ten components above plus Card, Badge, Button, Input, Table and Kpi parts, TrendChip, NumberValue, Sparkline, cn, formatNumberValue); and ${ARTIFACT_ALLOWED_PACKAGES.filter((p) => !p.startsWith("react")).join(", ")}. Style with Tailwind on the theme tokens (bg-card, text-muted-foreground, border-border, bg-canvas, text-ink, micro, display-m). No network calls. Example: ${TSX_EXAMPLE}`,
  `theme: ${artifactThemeGuide()} Default kobra. The theme only styles the page; it never changes the account or thread. The page follows the reader's light/dark mode.`,
  "Unknown components, props or imports fail with a message naming each problem and its path; fix and call again.",
].join("\n\n");

const ArtifactInput = {
  spec: Schema.optional(
    Schema.Unknown.annotate({
      description:
        'A catalog spec object: {"root": {"component": "Stack", "props": {...}, "children": [...]}}.',
    }),
  ),
  tsx: Schema.optional(
    Schema.String.check(Schema.isMaxLength(100_000)).annotate({
      description:
        'Custom React TSX that `export default`s a component and imports only "react" and "@nofun/artifacts".',
    }),
  ),
  theme: Schema.optional(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "No Fun brand id (design system) or t3. Defaults to kobra.",
    }),
  ),
};

const ArtifactStats = Schema.Struct({
  theme: Schema.String,
  lane: Schema.Literals(["spec", "tsx", "page"]),
  bytes: Schema.Int,
  compileMs: Schema.Int,
});

export const NofunArtifactPreviewTool = Tool.make(NOFUN_ARTIFACT_PREVIEW_TOOL_NAME, {
  description: `Compile a No Fun artifact and screenshot it in T3's headless browser: returns a PNG, contentHeight and the page's console output, like html_preview. Check every artifact here before nofun_artifact_render; fix clipping, empty states, unreadable labels and console errors first.\n\n${NOFUN_ARTIFACT_GUIDE}`,
  parameters: Schema.Struct({
    ...ArtifactInput,
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH))),
    width: Schema.optional(
      Schema.Int.annotate({
        description: `Viewport width in CSS pixels, 240-1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}; use about 390 to check phones.`,
      }),
    ),
    appearance: Schema.optional(
      Schema.Literals(["dark", "light"]).annotate({
        description: "Reader light/dark mode to preview. Defaults to dark.",
      }),
    ),
  }),
  success: Schema.Struct({
    width: Schema.Int,
    contentHeight: Schema.Int,
    capturedHeight: Schema.Int,
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    missingImages: Schema.optional(Schema.Array(Schema.String)),
    artifact: ArtifactStats,
    playbook: Schema.optional(Schema.String),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, HtmlRender.HtmlRender],
})
  .annotate(Tool.Title, "Preview No Fun artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

// Publishes through HtmlRender.publish, the same store html_render uses, and returns the same
// `htmlRender` reference, so every client shows it inline like any HTML render.
export const NofunArtifactRenderTool = Tool.make(NOFUN_ARTIFACT_RENDER_TOOL_NAME, {
  description: `Compile a No Fun artifact and show it in this thread, above your final text reply (call it before writing that reply; don't announce or restate the page). Preview with nofun_artifact_preview first. Same inputs as the preview, plus display and open: a small chart or single metric shows inline; a dashboard, multi-section page or interactive tool should pass display \"card\" with open true.\n\n${NOFUN_ARTIFACT_GUIDE}`,
  parameters: Schema.Struct({
    ...ArtifactInput,
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ).annotate({ description: "Short name for the artifact." }),
    height: Schema.optional(
      Schema.Int.annotate({
        description: `Frame height cap in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Omit to fit the page; pass less than the preview's contentHeight to make it scroll.`,
      }),
    ),
    bundle: Schema.optional(
      Schema.Struct({
        size: Schema.optional(
          Schema.String.annotate({
            description: "Canvas card size WxH, 16-4096 each. Defaults to 640x480.",
          }),
        ),
        background: Schema.optional(
          Schema.String.annotate({
            description: "transparent (default), match, or #rrggbb.",
          }),
        ),
        runtimeVersion: Schema.optional(
          Schema.String.check(Schema.isMaxLength(64)).annotate({
            description:
              "No Fun UI runtime version (folder name) to pin. Defaults to the host's pinned runtime.",
          }),
        ),
      }).annotate({
        description:
          "Also write a Canvas bundle (nofun-canvas-artifact-bundle v1) that loads the pinned No Fun UI runtime, and return its directory, manifest sha256 and runtime pin. Omit to only show the page in the thread.",
      }),
    ),
    display: Schema.optional(
      Schema.Literals(["inline", "card"]).annotate({
        description:
          'How the thread shows it. "inline": the page itself above your reply (small chart, single metric). "card": a compact titled card the reader opens (dashboard, multi-section page, interactive tool). Omit to let the app choose: card for specs with 3+ top-level children or any tsx, else inline. The reader\'s own setting can override this.',
      }),
    ),
    open: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Open the page in the side panel when it first appears. Use true for a dashboard or interactive tool the reader will work in. Omit to follow the default for the display mode.",
      }),
    ),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
      display: Schema.optional(Schema.Literals(["inline", "card"])),
      autoOpen: Schema.optional(Schema.Boolean),
    }),
    artifact: ArtifactStats,
    bundle: Schema.optional(
      Schema.Struct({
        directory: Schema.String,
        manifestPath: Schema.String,
        sha256: Schema.String,
        createdAt: Schema.String,
        runtime: Schema.Struct({ version: Schema.String, sha256: Schema.String }),
      }),
    ),
    message: Schema.String,
    playbook: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
    ServerConfig.ServerConfig,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Render No Fun artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const NofunComponentsSearchTool = Tool.make(NOFUN_COMPONENTS_SEARCH_TOOL_NAME, {
  description:
    'Search the live No Fun component library (nofun-components: blocks, Kobra-based components and brands, commerce excluded) for an artifact. Returns the best matches with the import to use in nofun_artifact_* tsx ("@nofun/ui/<name>"), a working demo import, prop hints and style tags. Query by what you need ("kpi cards", "area chart", "hero with big type", "kanban", "shader background"); search again rather than guessing names.',
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(200)),
    category: Schema.optional(
      Schema.String.check(Schema.isMaxLength(40)).annotate({
        description:
          "Optional group: ai, charts, controls, data, effects, feedback, forms, gallery, heroes, interactions, landing, marketing, navigation, onboarding, overlays, sections, showcase, ui; or kind: block, component, brand.",
      }),
    ),
    limit: Schema.optional(Schema.Int.annotate({ description: "1-20, default 8." })),
  }),
  success: Schema.Struct({
    source: Schema.String,
    matches: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        kind: Schema.String,
        category: Schema.String,
        title: Schema.String,
        description: Schema.String,
        import: Schema.optional(Schema.String),
        snippet: Schema.optional(Schema.String),
        demo: Schema.optional(Schema.String),
        style: Schema.Array(Schema.String),
        props: Schema.Array(Schema.String),
        brand: Schema.optional(Schema.String),
      }),
    ),
    playbook: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Search No Fun components")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const NofunComponentsSearchToolkit = Toolkit.make(NofunComponentsSearchTool);

export const NofunArtifactPreviewToolkit = Toolkit.make(NofunArtifactPreviewTool);

export const NofunArtifactRenderToolkit = Toolkit.make(NofunArtifactRenderTool);

export const NofunArtifactToolkit = Toolkit.make(NofunArtifactPreviewTool, NofunArtifactRenderTool);
