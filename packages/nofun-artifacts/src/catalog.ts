// The No Fun artifact catalog: the ten components a spec may use, their serializable props, and the
// validator the compiler runs before anything renders. Pure data and functions (no React, no Node),
// so the server, the tool description and the docs read the same source.

export type ArtifactNode = {
  component: string;
  key?: string;
  props?: Record<string, unknown>;
  children?: ArtifactNode[];
};

export type ArtifactSpec = {
  theme?: string;
  title?: string;
  root: ArtifactNode;
};

type PropType =
  | { kind: "string"; max?: number }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "array"; items: PropType; min?: number; max?: number }
  | { kind: "object"; fields: Record<string, PropSpec> }
  | { kind: "record"; values: PropType }
  | { kind: "cell" }
  | { kind: "nullable"; inner: PropType };

type PropSpec = { type: PropType; required?: boolean; doc: string };

export type ComponentSpec = {
  description: string;
  /** Source in nofun-components this component wraps or ports. */
  source: string;
  children: boolean;
  props: Record<string, PropSpec>;
};

const str = (doc: string, max = 400, required = false): PropSpec => ({
  type: { kind: "string", max },
  doc,
  required,
});
const num = (doc: string, min?: number, max?: number, required = false): PropSpec => ({
  type: {
    kind: "number",
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  },
  doc,
  required,
});
const bool = (doc: string): PropSpec => ({ type: { kind: "boolean" }, doc });
const oneOf = (values: readonly string[], doc: string, required = false): PropSpec => ({
  type: { kind: "enum", values },
  doc,
  required,
});

const GAPS = ["none", "sm", "md", "lg", "xl"] as const;
const STATUS_TONES = ["neutral", "info", "success", "warning", "danger", "primary"] as const;
const TIMELINE_TONES = ["default", "primary", "success", "warning", "error", "info"] as const;
const CHART_TONES = [
  "foreground",
  "muted",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "success",
  "warning",
  "error",
  "info",
] as const;
const CELL_FORMATS = [
  "text",
  "decimal",
  "number",
  "currency",
  "percent",
  "compact",
  "status",
] as const;

/** A WebP `data:` thumbnail is 8–32 KB. 4096 characters rejected those. */
const GALLERY_SRC_MAX = 65_536;

const cellRow: PropType = { kind: "record", values: { kind: "cell" } };

export const ARTIFACT_CATALOG: Record<string, ComponentSpec> = {
  Stack: {
    description: "Vertical or horizontal flow of children with token gaps. The usual root.",
    source: "new layout wrapper (No Fun lays out with raw Tailwind flex)",
    children: true,
    props: {
      direction: oneOf(["vertical", "horizontal"], "Default vertical."),
      gap: oneOf(GAPS, "Default md (16px)."),
      align: oneOf(["start", "center", "end", "stretch", "baseline"], "Cross-axis alignment."),
      justify: oneOf(["start", "center", "end", "between"], "Main-axis distribution."),
      wrap: bool("Wrap horizontal children."),
    },
  },
  Grid: {
    description:
      "Responsive grid: `columns` at full width, fewer as the frame narrows. Put Metric cards in one.",
    source: "new layout wrapper",
    children: true,
    props: {
      columns: num("1-6, default 2.", 1, 6),
      minColumnWidth: num(
        "Smallest column in px before the grid drops a column. Default 200.",
        120,
        600,
      ),
      gap: oneOf(GAPS, "Default md."),
    },
  },
  Text: {
    description: "Display headline, title, heading, body, muted note or micro (mono) label.",
    source: "registry/nofun-ui/themes/base.css display-m and micro utilities",
    children: false,
    props: {
      text: str("The words.", 2000, true),
      variant: oneOf(["display", "title", "heading", "body", "muted", "micro"], "Default body."),
      align: oneOf(["start", "center", "end"], "Default start."),
    },
  },
  Metric: {
    description: "KPI card: label, big number, trend chip, optional sparkline and footer.",
    source: "registry/nofun-ui/blocks/charts/kpi + trend-chip + sparkline + number-value",
    children: false,
    props: {
      label: str("What is measured.", 80, true),
      value: {
        type: { kind: "nullable", inner: { kind: "number" } },
        required: true,
        doc: "The reading; null shows a dash. Percent format takes a ratio (0.25 = 25%).",
      },
      format: oneOf(["decimal", "currency", "percent", "compact"], "Default decimal."),
      currency: str("ISO code for currency format. Default USD.", 3),
      unit: str("Short suffix, e.g. ms.", 16),
      maximumFractionDigits: num("Decimal places.", 0, 6),
      change: {
        type: { kind: "nullable", inner: { kind: "number" } },
        doc: "Change in percentage points (12.4 = +12.4%).",
      },
      invert: bool("A fall is good news (latency, churn)."),
      trend: {
        type: { kind: "array", items: { kind: "number" }, max: 120 },
        doc: "Recent values, oldest first.",
      },
      footer: str("Footer line: comparison period or source.", 120),
      loading: bool("Show a static skeleton instead of the reading."),
      status: {
        type: {
          kind: "object",
          fields: { label: str("Status text.", 40, true), tone: oneOf(STATUS_TONES, "Tone.") },
        },
        doc: "Small status badge in the header.",
      },
    },
  },
  Status: {
    description: "Status badge with a dot: label, tone and optional muted detail.",
    source: "components/ui/badge.tsx (Kobra Badge) with the timeline block's tone mapping",
    children: false,
    props: {
      label: str("Status text.", 60, true),
      tone: oneOf(STATUS_TONES, "Default neutral."),
      detail: str("Muted text after the badge.", 120),
      size: oneOf(["sm", "default"], "Default default."),
    },
  },
  DataTable: {
    description: "Kobra table with click-to-sort headers, optional filter box and row limit.",
    source: "components/ui/table.tsx + blocks/data/data-grid sort header",
    children: false,
    props: {
      columns: {
        type: {
          kind: "array",
          min: 1,
          max: 12,
          items: {
            kind: "object",
            fields: {
              key: str("Row field.", 60, true),
              label: str("Header.", 60, true),
              align: oneOf(["start", "center", "end"], "Default end for numeric formats."),
              format: oneOf(
                CELL_FORMATS,
                "Cell format. decimal is an alias for number; status renders a Status badge.",
              ),
              currency: str("ISO code for currency.", 3),
              tones: {
                type: { kind: "record", values: { kind: "enum", values: STATUS_TONES } },
                doc: "status format: value to tone.",
              },
            },
          },
        },
        required: true,
        doc: "Columns in order.",
      },
      rows: {
        type: { kind: "array", items: cellRow, max: 500 },
        required: true,
        doc: "Objects keyed by column key; values are strings, numbers, booleans or null.",
      },
      caption: str("Caption above the table.", 200),
      sortable: bool("Default true."),
      filterable: bool("Show a filter box. Default false."),
      maxRows: num("Rows before a Show all button.", 1, 500),
      emptyText: str("Shown when there are no rows.", 120),
      loading: bool("Show a static skeleton instead of the rows."),
    },
  },
  Chart: {
    description:
      "Bar, line or area chart in a Kobra chart card with title, headline value, legend and hover tooltip.",
    source: "registry/nofun-ui/blocks/charts/chart-bar + chart-area/chart-shell (SVG renderer)",
    children: false,
    props: {
      type: oneOf(["bar", "line", "area"], "Default bar."),
      title: str("Card title.", 80),
      description: str("Muted line under the title.", 160),
      value: str("Headline number, already formatted.", 32),
      data: {
        type: { kind: "array", items: cellRow, max: 400 },
        required: true,
        doc: "One object per x value. An empty list renders the empty state.",
      },
      xKey: str("Field holding the x label.", 60, true),
      series: {
        type: {
          kind: "array",
          min: 1,
          max: 6,
          items: {
            kind: "object",
            fields: {
              key: str("Numeric field.", 60, true),
              label: str("Legend label.", 60, true),
              color: oneOf(
                CHART_TONES,
                "Tone. Omitted series run ink, muted, then chart-2 to chart-5. chart-1 and status hues are drawn as that slot instead.",
              ),
              dashed: bool("Dashed line (comparison series)."),
            },
          },
        },
        required: true,
        doc: "Plotted fields.",
      },
      stacked: bool("Stack series."),
      height: num("Plot height in px. Default 240.", 120, 600),
      valueFormat: oneOf(
        ["decimal", "compact", "currency", "percent"],
        "Axis and tooltip format. Default compact.",
      ),
      currency: str("ISO code.", 3),
      legend: bool("Default on with more than one series."),
      variant: oneOf(["card", "plain"], "plain drops the card."),
      emptyText: str("Shown when data is empty.", 120),
      loading: bool("Show a static skeleton instead of the plot."),
    },
  },
  Gallery: {
    description: "Image tiles on the brand radius with optional accent caption tiles.",
    source: "registry/nofun-ui/blocks/gallery/caption-mosaic",
    children: false,
    props: {
      items: {
        type: {
          kind: "array",
          max: 24,
          items: {
            kind: "object",
            fields: {
              src: str("https URL, data: URI or absolute local image path.", GALLERY_SRC_MAX, true),
              alt: str("Alt text.", 200, true),
              caption: str("Caption tile text.", 80),
              href: str("Link target (https).", 2048),
            },
          },
        },
        required: true,
        doc: "Images.",
      },
      columns: num("1-4, default 3.", 1, 4),
      aspect: oneOf(["square", "portrait", "landscape"], "Default portrait."),
      emptyText: str("Shown when there are no images.", 120),
      loading: bool("Show static skeleton tiles."),
    },
  },
  Comparison: {
    description:
      "Side-by-side options: table on wide frames, stacked cards on phones, Differences only toggle.",
    source: "registry/nofun-ui/blocks/product/compare-table (generalized from products)",
    children: false,
    props: {
      columns: {
        type: {
          kind: "array",
          min: 2,
          max: 5,
          items: {
            kind: "object",
            fields: {
              title: str("Option name.", 60, true),
              subtitle: str("Muted line.", 120),
              badge: str("Small badge, e.g. Recommended.", 30),
              highlight: bool("Tint this column."),
            },
          },
        },
        required: true,
        doc: "Options compared.",
      },
      rows: {
        type: {
          kind: "array",
          max: 60,
          items: {
            kind: "object",
            fields: {
              label: str("Attribute.", 80, true),
              values: {
                type: { kind: "array", items: { kind: "cell" } },
                required: true,
                doc: "One per column; true/false render a check or dash.",
              },
            },
          },
        },
        required: true,
        doc: "Attributes.",
      },
      caption: str("Label above.", 160),
      diffToggle: bool("Offer Differences only. Default on above three rows."),
      emptyText: str("Shown when there are no rows.", 120),
      loading: bool("Show a static skeleton instead of the options."),
    },
  },
  Timeline: {
    description: "Vertical or horizontal sequence of events with tones, badges and a current step.",
    source: "registry/nofun-ui/blocks/data/timeline",
    children: false,
    props: {
      items: {
        type: {
          kind: "array",
          max: 60,
          items: {
            kind: "object",
            fields: {
              title: str("Event.", 120, true),
              time: str("When.", 40),
              body: str("Detail.", 500),
              tone: oneOf(TIMELINE_TONES, "Indicator tone."),
              badge: str("Small badge.", 30),
              current: bool("The current step."),
              pending: bool("Not happened yet (dashed)."),
            },
          },
        },
        required: true,
        doc: "Events in order.",
      },
      orientation: oneOf(["vertical", "horizontal"], "Default vertical."),
      opposite: bool("Times on the other side of the line."),
      size: oneOf(["sm", "default", "lg"], "Default default."),
      emptyText: str("Shown when there are no events.", 120),
      loading: bool("Show a static skeleton instead of the events."),
    },
  },
};

export const ARTIFACT_COMPONENT_NAMES = Object.keys(ARTIFACT_CATALOG);

export class ArtifactSpecError extends Error {
  readonly issues: ReadonlyArray<string>;
  constructor(issues: ReadonlyArray<string>) {
    super(`The artifact spec is invalid:\n- ${issues.slice(0, 20).join("\n- ")}`);
    this.issues = issues;
  }
}

function describe(type: PropType): string {
  switch (type.kind) {
    case "enum":
      return type.values.map((value) => JSON.stringify(value)).join(" | ");
    case "array":
      return `array of ${describe(type.items)}`;
    case "object":
      return `object {${Object.keys(type.fields).join(", ")}}`;
    case "record":
      return `object of ${describe(type.values)}`;
    case "cell":
      return "string | number | boolean | null";
    case "nullable":
      return `${describe(type.inner)} | null`;
    default:
      return type.kind;
  }
}

function checkValue(value: unknown, type: PropType, path: string, issues: string[]) {
  const fail = (message: string) => issues.push(`${path}: ${message}`);
  switch (type.kind) {
    case "string":
      if (typeof value !== "string")
        return fail(`expected a string, got ${JSON.stringify(value)?.slice(0, 40)}`);
      if (type.max !== undefined && value.length > type.max)
        fail(`at most ${type.max} characters (got ${value.length})`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return fail(`expected a finite number, got ${JSON.stringify(value)?.slice(0, 40)}`);
      if (type.min !== undefined && value < type.min) fail(`must be >= ${type.min}`);
      if (type.max !== undefined && value > type.max) fail(`must be <= ${type.max}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("expected true or false");
      return;
    case "enum":
      if (typeof value !== "string" || !type.values.includes(value))
        fail(`expected one of ${describe(type)}, got ${JSON.stringify(value)?.slice(0, 40)}`);
      return;
    case "cell":
      if (
        !(
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        )
      ) {
        fail("expected a string, finite number, boolean or null");
      }
      return;
    case "nullable":
      if (value !== null) checkValue(value, type.inner, path, issues);
      return;
    case "array":
      if (!Array.isArray(value)) return fail(`expected ${describe(type)}`);
      if (type.min !== undefined && value.length < type.min)
        fail(`needs at least ${type.min} item(s)`);
      if (type.max !== undefined && value.length > type.max)
        fail(`at most ${type.max} items (got ${value.length})`);
      value
        .slice(0, 600)
        .forEach((item, index) => checkValue(item, type.items, `${path}[${index}]`, issues));
      return;
    case "record":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return fail(`expected ${describe(type)}`);
      for (const [key, item] of Object.entries(value))
        checkValue(item, type.values, `${path}.${key}`, issues);
      return;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return fail(`expected ${describe(type)}`);
      checkFields(value as Record<string, unknown>, type.fields, path, issues);
      return;
  }
}

function checkFields(
  value: Record<string, unknown>,
  fields: Record<string, PropSpec>,
  path: string,
  issues: string[],
) {
  for (const key of Object.keys(value)) {
    if (!(key in fields))
      issues.push(`${path}: unknown field "${key}". Allowed: ${Object.keys(fields).join(", ")}.`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (value[key] === undefined) {
      if (spec.required) issues.push(`${path}.${key}: required (${spec.doc})`);
      continue;
    }
    checkValue(value[key], spec.type, `${path}.${key}`, issues);
  }
}

const MAX_NODES = 400;
const MAX_DEPTH = 12;

function checkNode(
  node: unknown,
  path: string,
  issues: string[],
  state: { nodes: number },
  depth: number,
) {
  if (++state.nodes > MAX_NODES) {
    if (state.nodes === MAX_NODES + 1)
      issues.push(`${path}: a spec may have at most ${MAX_NODES} components.`);
    return;
  }
  if (depth > MAX_DEPTH)
    return void issues.push(`${path}: nested deeper than ${MAX_DEPTH} levels.`);
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return void issues.push(`${path}: expected {component, props, children}.`);
  }
  const { component, props, children, key, ...rest } = node as Record<string, unknown>;
  for (const extra of Object.keys(rest)) {
    issues.push(
      `${path}: unknown key "${extra}". A node has only component, props, children and key.`,
    );
  }
  if (key !== undefined && typeof key !== "string") issues.push(`${path}.key: expected a string.`);
  const spec = typeof component === "string" ? ARTIFACT_CATALOG[component] : undefined;
  if (!spec) {
    return void issues.push(
      `${path}.component: unknown component ${JSON.stringify(component)}. Use one of ${ARTIFACT_COMPONENT_NAMES.join(", ")}, or write custom TSX for anything else.`,
    );
  }
  if (
    props !== undefined &&
    (typeof props !== "object" || props === null || Array.isArray(props))
  ) {
    issues.push(`${path}.props: expected an object.`);
  } else {
    const values = (props ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(values)) {
      if (!(name in spec.props)) {
        issues.push(
          `${path}.props: ${component} has no prop "${name}". Its props: ${Object.keys(spec.props).join(", ")}.`,
        );
      }
    }
    for (const [name, propSpec] of Object.entries(spec.props)) {
      const value = values[name];
      if (value === undefined) {
        if (propSpec.required)
          issues.push(`${path}.props.${name}: required on ${component} (${propSpec.doc})`);
        continue;
      }
      checkValue(value, propSpec.type, `${path}.props.${name}`, issues);
    }
  }
  if (children !== undefined) {
    if (!spec.children) {
      issues.push(`${path}.children: ${component} takes no children; put content in its props.`);
    } else if (!Array.isArray(children)) {
      issues.push(`${path}.children: expected an array of nodes.`);
    } else {
      children.forEach((child, index) =>
        checkNode(child, `${path}.children[${index}]`, issues, state, depth + 1),
      );
    }
  }
}

// Normalize at the compiler boundary: already shipped linked runtimes know the table's `number`
// format, while Metric and Chart use `decimal`. Never send a new format to an old pinned runtime.
function normalizeNumberFormats(node: ArtifactNode): ArtifactNode {
  const props =
    node.component === "DataTable" && Array.isArray(node.props?.columns)
      ? {
          ...node.props,
          columns: (node.props.columns as Record<string, unknown>[]).map((column) =>
            column.format === "decimal" ? { ...column, format: "number" } : column,
          ),
        }
      : node.props;
  return {
    ...node,
    ...(props === undefined ? {} : { props }),
    ...(node.children === undefined ? {} : { children: node.children.map(normalizeNumberFormats) }),
  };
}

/** Validates and normalizes a spec; throws ArtifactSpecError listing every problem with its path. */
export function validateArtifactSpec(spec: unknown): ArtifactSpec {
  const issues: string[] = [];
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new ArtifactSpecError([
      'spec: expected {"root": {"component": ..., "props": ..., "children": [...]}}.',
    ]);
  }
  const { root, theme, title, ...rest } = spec as Record<string, unknown>;
  for (const extra of Object.keys(rest))
    issues.push(`spec: unknown key "${extra}". A spec has root, and optionally theme and title.`);
  if (theme !== undefined && typeof theme !== "string")
    issues.push("spec.theme: expected a string.");
  if (title !== undefined && typeof title !== "string")
    issues.push("spec.title: expected a string.");
  if (root === undefined) issues.push("spec.root: required.");
  else checkNode(root, "root", issues, { nodes: 0 }, 0);
  if (issues.length > 0) throw new ArtifactSpecError(issues);
  const valid = spec as ArtifactSpec;
  return { ...valid, root: normalizeNumberFormats(valid.root) };
}

/** Compact catalog listing for agent-facing descriptions. */
export function artifactCatalogGuide(): string {
  return ARTIFACT_COMPONENT_NAMES.map((name) => {
    const spec = ARTIFACT_CATALOG[name]!;
    const props = Object.entries(spec.props)
      .map(
        ([prop, propSpec]) => `${prop}${propSpec.required ? "*" : ""}: ${describe(propSpec.type)}`,
      )
      .join("; ");
    return `${name}${spec.children ? " (children)" : ""}: ${spec.description} Props: ${props}.`;
  }).join("\n");
}
