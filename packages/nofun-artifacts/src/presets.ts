// Canvas presets: the theme, card background, default size per lane and frame CSS that make an artifact
// look finished on a dark Canvas board (RGB 23/24/26, 1 CSS px = 1 board point, zoom never reflows).
// `nofun-artifacts compile --preset <id>` fills --theme, --size and --background from the preset (an
// explicit flag still wins), pins the dark scheme, and adds `withPresetCss` to the page. See docs/PRESETS.md.

export type CanvasLane = "spec" | "tsx" | "page";

export interface CanvasPreset {
  readonly id: string;
  readonly theme: string;
  readonly background: "transparent" | "match";
  /** The board is dark: two-scheme brands render their dark tokens. */
  readonly scheme: "dark";
  readonly sizes: Readonly<Record<CanvasLane, { readonly width: number; readonly height: number }>>;
  /** Root font size. Every rem in the page follows it, so a narrow card gets slightly denser type. */
  readonly typeScale: string;
  readonly css: string;
}

const SIZES = {
  spec: { width: 960, height: 600 },
  tsx: { width: 640, height: 440 },
  page: { width: 1200, height: 800 },
} as const;

// 14px on a 560-wide card, 16px from 960 up.
const TYPE_SCALE = "clamp(14px, 11.2px + 0.5vw, 16px)";

// Defaults only: every rule but the root size has zero specificity, so a component's own focus ring,
// selection or font always wins. The font fallback covers linked artifacts on a runtime.css built
// without Geist, where `--font-geist-sans` is otherwise undefined and the stack falls back to the UA serif.
const frameCss = (selection: string, extra = "") =>
  [
    `html{font-size:${TYPE_SCALE};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}`,
    `html,body{overscroll-behavior:none}`,
    `:where(html){--font-geist-sans:"Geist",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;--font-geist-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}`,
    `:where(*){scrollbar-width:none}:where(*)::-webkit-scrollbar{display:none}`,
    `::selection{background:${selection};color:inherit}`,
    `:where(:focus-visible){outline:2px solid var(--ring,currentColor);outline-offset:2px}`,
    `:where(img,video,canvas,svg){max-width:100%}`,
    extra,
  ].join("");

// A1-4: Canvas boards ban blue. The `t3` theme points the No Fun tokens at the variables the reader's
// T3 app injects, and T3's own primary, ring and focus are blue (#346bf1), as is the Status "info"
// tone. A Canvas bundle must not inherit them: ink, gray rings and a gray info tone instead.
// The rules hang off `html.dark` (the marker compileLinked emits for dark t3 pages): the runtime's
// `theme()` clears the body's theme attributes on every load, so a `body[data-*]` selector never
// matches, while `<html>` is untouched. Specificity (0,1,2) beats the `:root` and `.dark`
// definitions in runtime.css and the host sheet.
export const NO_BLUE_T3_CSS =
  `html.dark body{--primary:var(--foreground);--primary-foreground:var(--background);` +
  `--ring:var(--muted-foreground);--nf-focus:var(--muted-foreground);--info:var(--muted-foreground)}`;

export const PRESETS = {
  /** No Fun's quiet stock system: ink on near-black, gray hairlines. The default for data. */
  "canvas-dark-kobra": {
    id: "canvas-dark-kobra",
    theme: "kobra",
    background: "transparent",
    scheme: "dark",
    sizes: SIZES,
    typeScale: TYPE_SCALE,
    css: frameCss("color-mix(in oklab, var(--foreground) 24%, transparent)"),
  },
  /** SF type, 22px continuous corners, system blue: for anything that should feel like the Mac app. */
  "canvas-dark-native-feel": {
    id: "canvas-dark-native-feel",
    theme: "native-feel",
    background: "transparent",
    scheme: "dark",
    sizes: SIZES,
    typeScale: TYPE_SCALE,
    css: frameCss("color-mix(in oklab, var(--nf-accent, var(--primary)) 40%, transparent)"),
  },
  /** No brand: the app's neutral tokens. The board colour sits under the page, and t3 gets the frame padding brands get. */
  "canvas-t3": {
    id: "canvas-t3",
    theme: "t3",
    background: "match",
    scheme: "dark",
    sizes: SIZES,
    typeScale: TYPE_SCALE,
    css: frameCss(
      "color-mix(in oklab, var(--foreground) 24%, transparent)",
      // Bare `body`: this preset CSS ships only on canvas-t3 pages, and a `body[data-*]`
      // selector would never match (the runtime's `theme()` clears those attributes on load).
      `body{padding:16px}${NO_BLUE_T3_CSS}`,
    ),
  },
} as const satisfies Record<string, CanvasPreset>;

export type CanvasPresetId = keyof typeof PRESETS;

export const DEFAULT_CANVAS_PRESET: CanvasPresetId = "canvas-dark-kobra";

export function canvasPresetIds(): CanvasPresetId[] {
  return Object.keys(PRESETS) as CanvasPresetId[];
}

/** The preset for an id; throws naming the known ids. */
export function canvasPreset(id: string): CanvasPreset {
  if (!Object.hasOwn(PRESETS, id)) {
    throw new Error(`Unknown preset "${id}". Use one of ${canvasPresetIds().join(", ")}.`);
  }
  return PRESETS[id as CanvasPresetId];
}

/** `WxH` for a lane, the form `--size` takes. */
export function presetSize(preset: CanvasPreset, lane: CanvasLane): string {
  const { width, height } = preset.sizes[lane];
  return `${width}x${height}`;
}

/** CLI flags with the preset's theme, lane size and background filled in where they were not passed. */
export function withPresetDefaults<
  T extends {
    preset?: string;
    tsx?: string;
    page?: string;
    theme?: string;
    size?: string;
    background?: string;
  },
>(flags: T): T {
  if (!flags.preset) return flags;
  const preset = canvasPreset(flags.preset);
  const lane: CanvasLane = flags.tsx ? "tsx" : flags.page ? "page" : "spec";
  return {
    ...flags,
    theme: flags.theme ?? preset.theme,
    size: flags.size ?? presetSize(preset, lane),
    background: flags.background ?? preset.background,
  };
}

/** Adds the preset's frame CSS after the compiled stylesheet, once. */
export function withPresetCss(html: string, preset: CanvasPreset): string {
  if (html.includes('id="nf-preset"')) return html;
  const tag = `<style id="nf-preset" data-preset="${preset.id}">${preset.css.replace(/<\/(style)/gi, "<\\/$1")}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
}
