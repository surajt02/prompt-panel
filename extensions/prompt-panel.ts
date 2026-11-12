// Prompt panel: a compact live tree of the current run, rendered above the editor.
//
// This module intentionally has no import-time side effects. Everything happens
// inside the default export or in event/command handlers.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Container,
  SettingsList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  SettingItem,
  SettingsListTheme,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "prompt-panel";
const CONFIG_FILE = "prompt-panel.json";
const HARD_MAX_ROWS = 48;
// Retention bound only. Completed turns are tiny one-line records; the visible
// depth is chosen by `display` at render time.
const MAX_RETAINED_TURNS = 500;
/** How many completed turns `display: "compact"` keeps above the live one. */
const COMPACT_PAST_TURNS = 2;

export type GlyphMode = "unicode" | "ascii";

export interface PanelConfig {
  enabled: boolean;
  maxRows: "auto" | number;
  /** How much of the run to show: see `DisplayMode`. */
  display: DisplayMode;
  showPrompt: boolean;
  showThinking: boolean;
  /** How the live thinking row reads: the clause in progress, or a bare marker. */
  thinkingMode: ThinkingMode;
  thinkingPreviewChars: number;
  animate: boolean;
  tickMs: number;
  /** How long the running glyph holds before it alternates. Independent of tickMs. */
  pulseMs: number;
  /** How often the thinking preview advances; keeps the row from crawling per token. */
  thinkingMs: number;
  /** full = keep the finished tree while idle; glyph = one summary row; hidden = nothing. */
  idleMode: IdleMode;
  glyphs: GlyphMode;
}

/**
 * How much of the run the panel shows.
 *
 * - `minimal`: the prompt and the live turn only.
 * - `compact`: the live turn plus the previous two, one line per tool.
 * - `expanded`: every retained turn, with tool arguments and result previews.
 */
export type DisplayMode = "minimal" | "compact" | "expanded";

export const DISPLAY_MODES: readonly DisplayMode[] = Object.freeze([
  "minimal",
  "compact",
  "expanded",
]);

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "minimal" || value === "compact" || value === "expanded";
}

/**
 * How many completed turns a mode keeps above the live one. `expanded` returns
 * Infinity, which every caller clamps to what the session still retains.
 */
export function pastTurnsFor(display: DisplayMode): number {
  if (display === "minimal") return 0;
  if (display === "compact") return COMPACT_PAST_TURNS;
  return Number.POSITIVE_INFINITY;
}

/** What the panel shows once a run has settled and nothing is executing. */
export type IdleMode = "full" | "glyph" | "hidden";

/**
 * How the live thinking row reads.
 *
 * - `text`: the clause currently being written, cut at a word boundary.
 * - `glyph`: just a pulsing `Thinking` marker, with no preview text.
 */
export type ThinkingMode = "text" | "glyph";

export const THINKING_MODES: readonly ThinkingMode[] = Object.freeze([
  "text",
  "glyph",
]);

export const DEFAULT_CONFIG: Readonly<PanelConfig> = Object.freeze({
  enabled: true,
  maxRows: "auto",
  display: "compact",
  showPrompt: true,
  showThinking: true,
  thinkingMode: "text",
  thinkingPreviewChars: 60,
  animate: true,
  tickMs: 200,
  pulseMs: 600,
  thinkingMs: 500,
  idleMode: "glyph",
  glyphs: "unicode",
});

export interface ParseConfigResult {
  config: PanelConfig;
  error?: string;
}

export interface DiffCount {
  added: number;
  removed: number;
}

/**
 * A tool row's state. `streaming` is the call being written by the model: the
 * row exists before Pi executes anything, because a fast tool would otherwise
 * live for one frame. `running` is `execute()` itself.
 */
export type ToolStatus =
  | "streaming"
  | "running"
  | "success"
  | "error"
  | "interrupted";

export interface ToolRecord {
  id: string;
  name: string;
  args?: unknown;
  summary: string;
  status: ToolStatus;
  /**
   * Content-block index of a streamed call. Providers can send the arguments
   * before the call id, so a streaming row is keyed by position until the id
   * arrives; `tool_execution_start` then adopts it.
   */
  streamKey?: string;
  startedAt?: number;
  durationMs?: number;
  diff?: DiffCount | null;
  parentToolCallId?: string;
  resultText?: string;
  errorText?: string;
  partialText?: string;
}

export interface ThinkingRecord {
  buffer: string;
  done?: boolean;
  /** Throttled snapshot of `buffer`; keeps the preview from crawling per token. */
  preview?: string;
  previewAt?: number;
}

export interface TurnRecord {
  number: number;
  startedAt: number;
  tools: ToolRecord[];
  thinking?: ThinkingRecord | null;
  completed?: boolean;
  aborted?: boolean;
  hadError?: boolean;
  elapsedMs?: number;
  toolCount?: number;
}

export interface PastTurn {
  number: number;
  toolCount: number;
  durationMs?: number;
  aborted?: boolean;
}

/** Accumulated totals for one agent run, summed across every turn it produced. */
export interface RunRecord {
  turns: number;
  tools: number;
  durationMs: number;
  aborted?: boolean;
}

export interface PanelState {
  phase?: "hidden" | "primed" | "running" | "idle" | "interrupted";
  prompt?: string;
  /** True while the prompt block is expanded in place (clicked open). */
  promptExpanded?: boolean;
  /** Rows scrolled up from the bottom of the panel; 0 = pinned to the newest. */
  scroll?: number;
  /**
   * True while the idle totals row has been clicked open, revealing the
   * finished tree. The row stays at the bottom of the tree and folds it again.
   */
  summaryOpen?: boolean;
  pastTurns?: PastTurn[];
  currentTurn?: TurnRecord | null;
  /** Totals of the run in progress or just finished; authoritative when present. */
  run?: RunRecord | null;
  queued?: string[];
  notices?: string[];
  tick?: number;
  now?: number;
  turnCounter?: number;
}

/** Where the parts of the panel landed in the last rendered window. */
export interface PanelLayout {
  /** Window-relative row indices of the visible prompt block. */
  promptStart: number;
  promptEnd: number;
  /** Window-relative row index of the clickable totals row, when shown. */
  summaryStart: number;
  summaryEnd: number;
  scrollOffset: number;
  maxScrollOffset: number;
  totalRows: number;
}

export interface PanelRenderOptions {
  config?: Partial<PanelConfig>;
  terminalRows?: number;
  /**
   * Pi's own tool-output expansion (`ctrl+o`, or whatever `app.tools.expand` is
   * bound to). While it is on the panel renders as `display: "expanded"` — a
   * transient overlay, so nothing is persisted and the configured mode returns
   * when it goes off. Read at render time, because Pi emits no event for the
   * toggle.
   */
  toolsExpanded?: boolean;
  /**
   * Reports the rendered window, so a host can map a click's local y onto the
   * prompt block or the totals row, and clamp its own scroll offset.
   */
  onLayout?: (layout: PanelLayout) => void;
}

interface ThemeLike {
  fg(token: string, text: string): string;
  /** Optional so a minimal theme (or a test double) still renders plain text. */
  italic?(text: string): string;
}

interface Glyphs {
  prompt: string;
  check: string;
  cross: string;
  running: string;
  runningAlt: string;
  /**
   * The thinking mark, one per animation stage. Three stages against the
   * running glyph's two keep the two animations from flipping in lockstep.
   */
  thinking: readonly [string, string, string];
  branch: string;
  last: string;
  dot: string;
  ellipsis: string;
  compact: string;
  vertical: string;
  minus: string;
  /** Horizontal rule used by the settings pane's dividers. */
  rule: string;
}

function glyphsFor(mode: GlyphMode): Glyphs {
  if (mode === "ascii") {
    return {
      prompt: ">",
      check: "v",
      cross: "x",
      running: "*",
      runningAlt: "o",
      thinking: ["*", "o", "+"],
      branch: "|",
      last: "+",
      dot: ".",
      ellipsis: "...",
      compact: "...",
      vertical: "|",
      minus: "-",
      rule: "-",
    };
  }
  return {
    prompt: "❯",
    check: "✓",
    cross: "✗",
    running: "●",
    runningAlt: "○",
    thinking: ["✻", "✶", "✳"],
    branch: "├",
    last: "└",
    dot: "·",
    ellipsis: "…",
    compact: "⋯",
    vertical: "│",
    minus: "−",
    rule: "─",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Validate a parsed JSON value (or a JSON string) into a complete config. */
export function parseConfig(input: unknown): ParseConfigResult {
  if (input === undefined || input === null) {
    return { config: { ...DEFAULT_CONFIG } };
  }

  let value: unknown = input;
  if (typeof input === "string") {
    if (input.trim() === "") {
      return { config: { ...DEFAULT_CONFIG }, error: "config is empty" };
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      return {
        config: { ...DEFAULT_CONFIG },
        error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!isRecord(value)) {
    return { config: { ...DEFAULT_CONFIG }, error: "config must be a JSON object" };
  }

  const errors: string[] = [];
  const config: PanelConfig = { ...DEFAULT_CONFIG };

  if (hasOwn(value, "enabled")) {
    if (typeof value.enabled === "boolean") config.enabled = value.enabled;
    else errors.push("enabled must be a boolean");
  }
  if (hasOwn(value, "maxRows")) {
    if (value.maxRows === "auto") config.maxRows = "auto";
    else if (isIntegerInRange(value.maxRows, 1, HARD_MAX_ROWS)) {
      config.maxRows = value.maxRows;
    } else errors.push("maxRows must be \"auto\" or an integer from 1 to 48");
  }
  if (hasOwn(value, "display")) {
    if (isDisplayMode(value.display)) config.display = value.display;
    else errors.push('display must be "minimal", "compact", or "expanded"');
  } else if (hasOwn(value, "expand") || hasOwn(value, "pastTurns")) {
    // Compatibility with the old `expand`/`pastTurns` pair, so an existing
    // file keeps its effective view instead of silently becoming `compact`.
    if (value.expand === "always") config.display = "expanded";
    else if (value.pastTurns === 0) config.display = "minimal";
    else config.display = "compact";
  }
  if (hasOwn(value, "showPrompt")) {
    if (typeof value.showPrompt === "boolean") config.showPrompt = value.showPrompt;
    else errors.push("showPrompt must be a boolean");
  }
  if (hasOwn(value, "showThinking")) {
    if (typeof value.showThinking === "boolean") {
      config.showThinking = value.showThinking;
    } else errors.push("showThinking must be a boolean");
  }
  if (hasOwn(value, "thinkingMode")) {
    if (value.thinkingMode === "text" || value.thinkingMode === "glyph") {
      config.thinkingMode = value.thinkingMode;
    } else errors.push('thinkingMode must be "text" or "glyph"');
  }
  if (hasOwn(value, "thinkingPreviewChars")) {
    if (isIntegerInRange(value.thinkingPreviewChars, 1, 1000)) {
      config.thinkingPreviewChars = value.thinkingPreviewChars;
    } else errors.push("thinkingPreviewChars must be a positive integer");
  }
  if (hasOwn(value, "animate")) {
    if (typeof value.animate === "boolean") config.animate = value.animate;
    else errors.push("animate must be a boolean");
  }
  if (hasOwn(value, "tickMs")) {
    if (isIntegerInRange(value.tickMs, 1, 60000)) config.tickMs = value.tickMs;
    else errors.push("tickMs must be a positive integer no greater than 60000");
  }
  if (hasOwn(value, "pulseMs")) {
    if (isIntegerInRange(value.pulseMs, 50, 10000)) config.pulseMs = value.pulseMs;
    else errors.push("pulseMs must be an integer from 50 to 10000");
  }
  if (hasOwn(value, "thinkingMs")) {
    if (isIntegerInRange(value.thinkingMs, 50, 10000)) {
      config.thinkingMs = value.thinkingMs;
    } else errors.push("thinkingMs must be an integer from 50 to 10000");
  }
  if (hasOwn(value, "idleMode")) {
    if (
      value.idleMode === "full" ||
      value.idleMode === "glyph" ||
      value.idleMode === "hidden"
    ) {
      config.idleMode = value.idleMode;
    } else errors.push('idleMode must be "full", "glyph", or "hidden"');
  }
  if (hasOwn(value, "glyphs")) {
    if (value.glyphs === "unicode" || value.glyphs === "ascii") {
      config.glyphs = value.glyphs;
    } else errors.push("glyphs must be \"unicode\" or \"ascii\"");
  }

  if (errors.length > 0) {
    return { config: { ...DEFAULT_CONFIG }, error: errors.join("; ") };
  }
  return { config };
}

/** Total panel line budget, including the prompt row. */
export function effectiveRowBudget(config: PanelConfig, terminalRows: number): number {
  const rows =
    typeof terminalRows === "number" && Number.isFinite(terminalRows) && terminalRows > 0
      ? terminalRows
      : 24;
  if (config.maxRows === "auto") {
    return Math.max(6, Math.min(18, Math.floor(rows * 0.3)));
  }
  if (typeof config.maxRows === "number" && Number.isFinite(config.maxRows)) {
    return Math.max(1, Math.min(HARD_MAX_ROWS, Math.floor(config.maxRows)));
  }
  return Math.max(6, Math.min(18, Math.floor(rows * 0.3)));
}

// ---------------------------------------------------------------------------
// Settings pane model: one SettingsList row per config key
// ---------------------------------------------------------------------------

const ON_OFF = ["on", "off"];

/** The `/panel` pane's rows, in display order, reflecting the live config. */
export function settingsItems(config: PanelConfig): SettingItem[] {
  const onOff = (value: boolean) => (value ? "on" : "off");
  return [
    {
      id: "enabled",
      label: "enabled",
      description: "Show the panel above the editor. Off removes it and stops its timer.",
      currentValue: onOff(config.enabled),
      values: ON_OFF,
    },
    {
      id: "display",
      label: "display",
      description:
        "minimal is the live turn only, compact adds the previous two, expanded shows every retained turn with tool arguments and results.",
      currentValue: config.display,
      values: [...DISPLAY_MODES],
    },
    {
      id: "idleMode",
      label: "idleMode",
      description:
        "What stays on screen once a run settles: the totals row, the finished tree, or nothing.",
      currentValue: config.idleMode,
      values: ["glyph", "full", "hidden"],
    },
    {
      id: "maxRows",
      label: "maxRows",
      description:
        "Row budget. auto is 30% of the terminal height, clamped to 6-18; a number is clamped to 1-48.",
      currentValue:
        config.maxRows === "auto" ? "auto" : String(config.maxRows),
      values: ["auto", "6", "8", "12", "18", "24", "36", "48"],
    },
    {
      id: "showPrompt",
      label: "showPrompt",
      description: "Pin the current prompt above the tree.",
      currentValue: onOff(config.showPrompt),
      values: ON_OFF,
    },
    {
      id: "showThinking",
      label: "showThinking",
      description: "Show the thinking row while a turn is live.",
      currentValue: onOff(config.showThinking),
      values: ON_OFF,
    },
    {
      id: "thinkingMode",
      label: "thinkingMode",
      description:
        "How the live thinking row reads: the clause in progress cut at a word boundary, or just a pulsing marker with no text.",
      currentValue: config.thinkingMode,
      values: [...THINKING_MODES],
    },
    {
      id: "thinkingPreviewChars",
      label: "thinkingPreviewChars",
      description: "Width budget of the thinking preview.",
      currentValue: String(config.thinkingPreviewChars),
      values: ["30", "40", "60", "80", "120"],
    },
    {
      id: "glyphs",
      label: "glyphs",
      description: "Use ascii on terminals without Unicode glyph support.",
      currentValue: config.glyphs,
      values: ["unicode", "ascii"],
    },
    {
      id: "animate",
      label: "animate",
      description: "Pulse the running glyph. Off freezes it and stops the timer between updates.",
      currentValue: onOff(config.animate),
      values: ON_OFF,
    },
    {
      id: "tickMs",
      label: "tickMs",
      description: "Refresh cadence while a run is active.",
      currentValue: String(config.tickMs),
      values: ["100", "200", "500", "1000"],
    },
    {
      id: "pulseMs",
      label: "pulseMs",
      description: "How long an animated glyph holds before its next stage.",
      currentValue: String(config.pulseMs),
      values: ["300", "600", "1000"],
    },
    {
      id: "thinkingMs",
      label: "thinkingMs",
      description: "How often the thinking preview advances.",
      currentValue: String(config.thinkingMs),
      values: ["250", "500", "1000", "2000"],
    },
  ];
}

/**
 * Apply one SettingsList value to a config, validating through `parseConfig` so
 * the pane and the file can never produce a config the renderer rejects.
 * Unknown ids or invalid values leave the config untouched.
 */
export function applySettingValue(
  id: string,
  value: string,
  base: PanelConfig,
): PanelConfig {
  const next: Record<string, unknown> = { ...base };
  switch (id) {
    case "enabled":
    case "showPrompt":
    case "showThinking":
    case "animate":
      next[id] = value === "on";
      break;
    case "maxRows":
      next.maxRows = value === "auto" ? "auto" : Number(value);
      break;
    case "thinkingPreviewChars":
    case "tickMs":
    case "pulseMs":
    case "thinkingMs":
      next[id] = Number(value);
      break;
    case "display":
    case "idleMode":
    case "glyphs":
    case "thinkingMode":
      next[id] = value;
      break;
    default:
      return base;
  }
  const parsed = parseConfig(next);
  return parsed.error ? base : parsed.config;
}

/** Pi's settings-list styling, so the pane matches `/settings` and `/tools`. */
function settingsListTheme(theme: ThemeLike): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) =>
      selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

/**
 * Fit one line of prose by cutting at a word boundary. The clip only backs up
 * when it lands inside a word, so a cut that already falls between words keeps
 * the last complete one. A single token wider than the line still gets a hard
 * cut — there is no boundary to find — and the result always fits `width`.
 */
function truncateAtWord(
  text: string,
  width: number,
  ellipsis: string,
): string {
  if (visibleWidth(text) <= width) return text;
  const room = Math.max(0, width - visibleWidth(ellipsis));
  // `truncateToWidth` leaves a reset sequence on the clip, so measure the
  // original by the plain prefix instead of by string length.
  const head = truncateToWidth(text, room, "", false).replace(
    /\x1b\[[0-9;]*m/g,
    "",
  );
  const rest = text.startsWith(head) ? text.slice(head.length) : "";
  if (rest !== "" && !/^\s/.test(rest)) {
    // Mid-word: fall back to the last space in the visible prefix.
    const boundary = head.search(/\s\S*$/);
    if (boundary > 0) {
      const cut = head.slice(0, boundary).replace(/\s+$/, "");
      if (cut !== "") return cut + ellipsis;
    }
  }
  return head.replace(/\s+$/, "") + ellipsis;
}

/** Ellipsize the middle of a path while keeping its basename visible. */
export function middleEllipsize(
  text: string,
  maxWidth: number,
  glyphMode: GlyphMode = "unicode",
): string {
  const width = Math.max(0, Math.floor(maxWidth));
  const raw = String(text ?? "");
  if (width === 0) return "";
  if (visibleWidth(raw) <= width) return raw;

  const glyphs = glyphsFor(glyphMode);
  const ellipsis = glyphs.ellipsis;
  const normalized = raw.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const prefix = slash >= 0 ? normalized.slice(0, slash) : "";

  const ellipsisWidth = visibleWidth(ellipsis);
  const basenameWidth = visibleWidth(basename);
  if (
    width < 12 ||
    basename === "" ||
    ellipsisWidth + basenameWidth + 2 > width
  ) {
    return truncateToWidth(basename || normalized, width, ellipsis, false);
  }

  const segments = prefix.split("/").filter(Boolean);
  const leadingSlash = prefix.startsWith("/");
  const head = `${leadingSlash ? "/" : ""}${segments[0] ?? ""}`;
  const availableHead = width - ellipsisWidth - basenameWidth - 2;
  if (availableHead < 1) {
    return truncateToWidth(basename, width, ellipsis, false);
  }
  const keptHead = truncateToWidth(head, availableHead, "", false);
  if (!keptHead || keptHead === "/") {
    return truncateToWidth(basename, width, ellipsis, false);
  }
  const separator = keptHead.endsWith("/") ? "" : "/";
  const result = `${keptHead}${separator}${ellipsis}/${basename}`;
  if (visibleWidth(result) > width) {
    return truncateToWidth(basename, width, ellipsis, false);
  }
  return result;
}

/** Format milliseconds as 0.1s, 8.4s, 14s, or 1m04s. */
export function formatDuration(ms: number): string {
  const safe = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 10000) return `${(safe / 1000).toFixed(1)}s`;
  if (safe < 60000) return `${Math.round(safe / 1000)}s`;
  if (safe < 3600000) {
    const minutes = Math.floor(safe / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  // The duration column is a fixed six visible columns, so very long runs use
  // an hours form instead of overflowing the row budget.
  const hours = Math.min(999, Math.floor(safe / 3600000));
  const minutes = Math.floor((safe % 3600000) / 60000);
  return `${hours}h${String(minutes).padStart(2, "0")}`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** A one-line, tool-specific summary of the call arguments. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  const record = isRecord(args) ? args : undefined;
  let summary: string | undefined;

  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      summary = firstString(
        record?.path,
        record?.file_path,
        record?.filePath,
        record?.filename,
      );
      break;
    case "bash": {
      const command =
        firstString(record?.command, record?.cmd) ??
        (typeof args === "string" ? args : undefined);
      summary = command === undefined ? undefined : stripLeadingCd(command);
      break;
    }
    case "grep":
    case "find":
    case "ls":
      summary = firstString(record?.pattern, record?.query);
      break;
    case "web_search":
      summary = firstString(record?.query, record?.q);
      break;
    case "codemode": {
      const script =
        typeof args === "string"
          ? args
          : firstString(record?.script, record?.code, record?.source, record?.input);
      if (script) summary = script.split(/\r?\n/, 1)[0].trim();
      break;
    }
    default:
      break;
  }

  if (summary !== undefined) return summary;
  // A streamed call's arguments exist only as far as the model has written
  // them: an empty object, or one whose values are all still empty, means the
  // interesting field has not arrived yet. Rendering `{}` there would put
  // punctuation on the row where the path is about to appear.
  if (Array.isArray(args)) {
    if (args.length === 0) return "";
  } else if (isRecord(args)) {
    const values = Object.values(args);
    if (
      values.length === 0 ||
      values.every((value) => value === "" || value === null || value === undefined)
    ) {
      return "";
    }
  }
  if (typeof args === "string") return args.slice(0, 40);
  try {
    const json = JSON.stringify(args);
    return typeof json === "string" ? json.slice(0, 40) : "";
  } catch {
    return String(args ?? "").slice(0, 40);
  }
}

function diffTextFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === "string").join("\n");
  }
  if (isRecord(value)) {
    return firstString(value.diff, value.patch, value.text, value.unified);
  }
  return undefined;
}

/** Count added/removed lines in an edit result's details.diff or details.patch. */
export function countEditDiff(result: unknown): DiffCount {
  const source = isRecord(result) ? result : undefined;
  const details = source && isRecord(source.details) ? source.details : undefined;
  const patch =
    diffTextFrom(details?.diff) ??
    diffTextFrom(details?.patch) ??
    diffTextFrom(source?.diff) ??
    diffTextFrom(source?.patch) ??
    "";

  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function collapseWhitespace(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Drop a leading `cd <dir> &&` or `cd <dir>;` so the row shows the actual work. */
function stripLeadingCd(command: string): string {
  const match = /^\s*cd\s+[^&;|]+\s*(?:&&|;)\s*/.exec(command);
  if (!match) return command;
  const rest = command.slice(match[0].length);
  return rest.length > 0 ? rest : command;
}

function paint(theme: ThemeLike, token: string, text: string): string {
  try {
    return theme.fg(token, text);
  } catch {
    return text;
  }
}

/** Italic when the theme offers it; the prompt still reads without it. */
function italic(theme: ThemeLike, text: string): string {
  try {
    return theme.italic ? theme.italic(text) : text;
  } catch {
    return text;
  }
}

function pluralTools(count: number): string {
  if (!(count > 0)) return "";
  return `${count} tool${count === 1 ? "" : "s"}`;
}

function formatPastTurn(past: PastTurn, config: PanelConfig, theme: ThemeLike): string {
  const glyphs = glyphsFor(config.glyphs);
  const mark = past.aborted ? glyphs.cross : glyphs.check;
  const token = past.aborted ? "error" : "success";
  const details = [`turn ${past.number}`];
  const tools = pluralTools(past.toolCount);
  if (tools !== "") details.push(tools);
  if (typeof past.durationMs === "number") {
    details.push(formatDuration(past.durationMs));
  }
  return `  ${paint(theme, token, mark)} ${paint(
    theme,
    "dim",
    details.join(` ${glyphs.dot} `),
  )}`;
}

/** One line of run totals for the collapsed row: `✓ 5 turns · 13 tools · 54s`. */
function formatRunRow(
  run: RunRecord,
  config: PanelConfig,
  theme: ThemeLike,
): string {
  const glyphs = glyphsFor(config.glyphs);
  const mark = run.aborted ? glyphs.cross : glyphs.check;
  const token = run.aborted ? "error" : "success";
  const details = [`${run.turns} turn${run.turns === 1 ? "" : "s"}`];
  const tools = pluralTools(run.tools);
  if (tools !== "") details.push(tools);
  if (run.durationMs > 0) details.push(formatDuration(run.durationMs));
  return `  ${paint(theme, token, mark)} ${paint(
    theme,
    "dim",
    details.join(` ${glyphs.dot} `),
  )}`;
}

/**
 * Run totals for the collapsed row. The runtime keeps an authoritative `run`
 * record because `pastTurns` is capped; states built without one (tests,
 * replays) fall back to the turns still retained.
 */
function runTotals(state: PanelState): RunRecord {
  const run = state.run;
  if (run && typeof run.turns === "number") return run;

  const totals: RunRecord = { turns: 0, tools: 0, durationMs: 0 };
  for (const past of Array.isArray(state.pastTurns) ? state.pastTurns : []) {
    totals.turns += 1;
    totals.tools += past.toolCount;
    if (typeof past.durationMs === "number") {
      totals.durationMs += past.durationMs;
    }
    if (past.aborted) totals.aborted = true;
  }
  const turn = state.currentTurn;
  if (turn) {
    totals.turns += 1;
    totals.tools += turn.toolCount ?? executedToolCount(turn);
    if (typeof turn.elapsedMs === "number") {
      totals.durationMs += turn.elapsedMs;
    }
    if (turn.aborted) totals.aborted = true;
  }
  return totals;
}

/**
 * True when a run has settled and nothing is executing, so the panel is allowed
 * to collapse. `interrupted` is deliberately not idle: an Esc freeze keeps the
 * interrupted tree visible.
 */
function isIdlePanel(state: PanelState): boolean {
  if (state.phase !== "idle") return false;
  if ((state.queued ?? []).length > 0) return false;
  const turn = state.currentTurn;
  return !turn || turn.completed === true || turn.aborted === true;
}

/**
 * How many retained past turns the panel shows: the collapsed depth plus what
 * the wheel has unfolded, capped at what the session still retains — or all of
 * them when the panel is expanded. Both the renderer and the wheel handler read
 * this, so a reveal can never disagree with what was drawn.
 */
function shownPastTurns(
  state: PanelState,
  config: PanelConfig,
  expanded: boolean,
): number {
  const retained = Array.isArray(state.pastTurns) ? state.pastTurns.length : 0;
  if (expanded) return retained;
  return Math.min(retained, pastTurnsFor(config.display));
}

function formatTurnHeader(
  turn: TurnRecord,
  config: PanelConfig,
  state: PanelState,
  width: number,
  theme: ThemeLike,
): string {
  const glyphs = glyphsFor(config.glyphs);
  const running = turn.completed !== true && turn.aborted !== true;
  const mark = turn.aborted
    ? glyphs.cross
    : running
      ? pulseOn(state, config)
        ? glyphs.runningAlt
        : glyphs.running
      : glyphs.check;
  const token = turn.aborted ? "error" : running ? "accent" : "success";

  let detailsText: string;
  if (width < 40) {
    const parts = [`turn ${turn.number}`];
    const count = executedToolCount(turn);
    if (count > 0) parts.push(pluralTools(count));
    detailsText = parts.join(` ${glyphs.dot} `);
  } else {
    const details = [`turn ${turn.number}`];
    if (turn.completed === true) {
      const count = turn.toolCount ?? executedToolCount(turn);
      if (count > 0) details.push(pluralTools(count));
      if (typeof turn.elapsedMs === "number") {
        details.push(formatDuration(turn.elapsedMs));
      }
    }
    detailsText = details.join(` ${glyphs.dot} `);
  }

  const detailToken = width < 40 ? "text" : running ? "text" : "muted";
  const plainHeader = `  ${mark} ${detailsText}`;
  const header = `  ${paint(theme, token, mark)} ${paint(
    theme,
    detailToken,
    detailsText,
  )}`;
  if (!config.showThinking) return header;
  // A finished turn's thought is stale: the header keeps the tools, not the
  // thought that produced them.
  if (turn.completed === true || turn.aborted === true) return header;

  const suffix = thinkingSuffix(
    turn.thinking,
    config,
    state,
    width - visibleWidth(plainHeader),
    glyphs,
  );
  if (suffix === "") return header;
  return header + paint(theme, "thinkingText", suffix);
}

/**
 * Running-glyph phase. It alternates once per `pulseMs` instead of once per
 * tick, so the dot blinks at a readable rate regardless of the tick speed.
 */
function pulseOn(state: PanelState, config: PanelConfig): boolean {
  if (!config.animate) return false;
  const tick = typeof state.tick === "number" ? state.tick : 0;
  const tickMs = Math.max(1, Math.floor(config.tickMs));
  const pulseMs = Math.max(tickMs, Math.floor(config.pulseMs));
  return Math.floor((tick * tickMs) / pulseMs) % 2 === 1;
}

/** Stages in the thinking cycle; one more than the running glyph's two. */
const THINKING_STAGES = 3;

/**
 * Thinking-mark stage, 0..2. It advances once per `pulseMs` like the running
 * glyph, but over three stages and half a stage out of step, so the mark and
 * the tool dot never flip on the same frame — a shared rhythm made the row
 * read as one blinking widget instead of a thought next to running work.
 */
function thinkingPhase(state: PanelState, config: PanelConfig): number {
  if (!config.animate) return 0;
  const tick = typeof state.tick === "number" ? state.tick : 0;
  const tickMs = Math.max(1, Math.floor(config.tickMs));
  const pulseMs = Math.max(tickMs, Math.floor(config.pulseMs));
  const elapsed = tick * tickMs + Math.floor(pulseMs / 2);
  return Math.floor(elapsed / pulseMs) % THINKING_STAGES;
}

/** Text after the last sentence terminator: the thought currently in progress. */
function lastSentence(text: string): string {
  let index = -1;
  for (const mark of [". ", "! ", "? ", "; ", ": "]) {
    const found = text.lastIndexOf(mark);
    if (found > index) index = found;
  }
  return index >= 0 ? text.slice(index + 2).trim() : "";
}

/**
 * The thinking suffix that rides on the live turn's header instead of taking a
 * row of its own: `turn 5 · ✻ Thinking · where the retry loop should go, then…`.
 * Folding it into the header buys a row for tool activity, which is where the
 * interesting motion is.
 *
 * It still reads like a thought, not like a log tail: the clause currently being
 * written is cut at a word boundary with a trailing ellipsis, the same way the
 * pinned prompt is cut, so the head holds still while a long clause streams and
 * only a new clause swaps it. `available` is the space the turn details left on
 * the row; without room for the label the suffix is dropped, so a narrow panel
 * keeps its turn row intact instead of crowding it.
 *
 * `thinkingMode: "text"` shows the clause; `"glyph"` shows only the pulsing
 * marker, for readers who find a truncated sentence more distracting than no
 * sentence at all. Both pulse the mark, so the row reads as active either way,
 * and both go quiet on an empty buffer: `message_start` creates a thinking
 * record for every assistant message, and a model that is not reasoning would
 * otherwise carry a permanent `Thinking` label.
 */
function thinkingSuffix(
  thinking: ThinkingRecord | null | undefined,
  config: PanelConfig,
  state: PanelState,
  available: number,
  glyphs: Glyphs,
): string {
  if (!thinking) return "";
  const clean = collapseWhitespace(thinking.preview ?? thinking.buffer);
  if (clean === "") return "";

  const mark = glyphs.thinking[thinkingPhase(state, config)] ?? glyphs.thinking[0];
  const separator = ` ${glyphs.dot} `;
  const label = `${mark} Thinking`;
  const used = visibleWidth(separator) + visibleWidth(label);
  if (available < used) return "";

  const budget = Math.min(
    Math.max(1, Math.floor(config.thinkingPreviewChars)),
    available - used - visibleWidth(separator),
  );
  // A two-word preview is noise; the marker alone still says it is thinking.
  if (config.thinkingMode === "glyph" || budget < 4) {
    return `${separator}${label}`;
  }
  // Prefer the clause in progress. Ending on a terminator leaves that clause
  // empty, and the last complete one reads better than a blank preview.
  const clause = lastSentence(clean) || clean;
  return `${separator}${label}${separator}${truncateAtWord(
    clause,
    budget,
    glyphs.ellipsis,
  )}`;
}

function formatArgsForPreview(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2) ?? "";
  } catch {
    return String(args);
  }
}

/**
 * A capped preview must advertise the cut, otherwise ".slice(0, 3)" reads as a
 * truncated-but-complete JSON object.
 */
function markTruncation(
  wrapped: string[],
  totalLines: number,
  available: number,
  glyphs: Glyphs,
): void {
  if (wrapped.length === 0 || totalLines <= wrapped.length) return;
  const last = wrapped[wrapped.length - 1];
  wrapped[wrapped.length - 1] =
    truncateToWidth(last, Math.max(1, available - 1), "", false) + glyphs.ellipsis;
}

function renderExpandedToolDetails(
  tool: ToolRecord,
  config: PanelConfig,
  width: number,
  theme: ThemeLike,
): string[] {
  const glyphs = glyphsFor(config.glyphs);
  const prefix = `    ${tool.parentToolCallId ? "  " : ""}  ${glyphs.vertical} `;
  const available = Math.max(1, width - visibleWidth(prefix));
  const lines: string[] = [];

  const argsText = formatArgsForPreview(tool.args).slice(0, 4000);
  if (argsText.trim() !== "") {
    const wrappedAll = wrapTextWithAnsi(argsText, available);
    const wrapped = wrappedAll.slice(0, 3);
    markTruncation(wrapped, wrappedAll.length, available, glyphs);
    for (const line of wrapped) {
      lines.push(prefix + paint(theme, "dim", line));
    }
  }

  const resultText =
    tool.status === "error"
      ? tool.errorText ?? tool.resultText ?? tool.partialText ?? ""
      : tool.resultText ?? tool.partialText ?? tool.errorText ?? "";
  if (resultText.trim() !== "") {
    const token = tool.status === "error" ? "error" : "toolOutput";
    const wrappedAll = wrapTextWithAnsi(resultText.slice(0, 8000), available);
    const wrapped = wrappedAll.slice(0, 5);
    markTruncation(wrapped, wrappedAll.length, available, glyphs);
    for (const line of wrapped) {
      lines.push(prefix + paint(theme, token, line));
    }
  }

  return lines;
}

function renderToolRow(
  tool: ToolRecord,
  isLast: boolean,
  config: PanelConfig,
  state: PanelState,
  width: number,
  theme: ThemeLike,
): string {
  const glyphs = glyphsFor(config.glyphs);
  const running = tool.status === "running";
  // A streamed row is the call being written, not the call executing: same live
  // glyph, but no duration and no `running` label, since nothing runs yet.
  const streaming = tool.status === "streaming";
  const statusGlyph =
    tool.status === "success"
      ? glyphs.check
      : tool.status === "error" || tool.status === "interrupted"
        ? glyphs.cross
        : pulseOn(state, config)
          ? glyphs.runningAlt
          : glyphs.running;
  const statusToken =
    tool.status === "success"
      ? "success"
      : tool.status === "error" || tool.status === "interrupted"
        ? "error"
        : "accent";

  const indent = tool.parentToolCallId ? "      " : "    ";
  const connector = isLast ? glyphs.last : glyphs.branch;
  const name = tool.name || "tool";

  let right = "";
  if (running) {
    right = paint(theme, "warning", "running");
  } else if (!streaming && width >= 60 && typeof tool.durationMs === "number") {
    right = paint(theme, "dim", formatDuration(tool.durationMs).padStart(6));
  }
  const rightWidth = right === "" ? 0 : visibleWidth(right);

  const hasDiff =
    width >= 48 &&
    !!tool.diff &&
    (tool.diff.added > 0 || tool.diff.removed > 0);
  const diffWidth = hasDiff
    ? 2 + visibleWidth(`+${tool.diff?.added ?? 0} ${glyphs.minus}${tool.diff?.removed ?? 0}`)
    : 0;

  const fixedWidth = visibleWidth(
    `${indent}${connector} ${statusGlyph} ${name}  `,
  );
  const summaryBudget =
    width - fixedWidth - diffWidth - (rightWidth > 0 ? rightWidth + 2 : 0);
  // Path-like tools keep their basename via a middle ellipsis; every other tool
  // gets an end ellipsis, so a clipped summary is never a silent mid-word chop.
  const isPathTool =
    tool.name === "read" || tool.name === "write" || tool.name === "edit";
  let summary = "";
  if (tool.summary && summaryBudget >= 2) {
    summary = isPathTool
      ? middleEllipsize(tool.summary, summaryBudget, config.glyphs)
      : truncateToWidth(
          collapseWhitespace(tool.summary),
          summaryBudget,
          glyphs.ellipsis,
          false,
        );
  }

  let left = `${indent}${paint(theme, "dim", connector)} ${paint(
    theme,
    statusToken,
    statusGlyph,
  )} ${paint(theme, "toolTitle", name)}`;
  if (summary) {
    left += `  ${paint(theme, "toolOutput", summary)}`;
  }

  if (hasDiff && tool.diff) {
    const added = paint(theme, "success", `+${tool.diff.added}`);
    const removed = paint(theme, "error", `${glyphs.minus}${tool.diff.removed}`);
    left += `  ${added} ${removed}`;
  }

  if (right === "") {
    return truncateToWidth(left, width, glyphs.ellipsis, false);
  }

  const maxLeft = Math.max(0, width - rightWidth - 2);
  const clippedLeft = truncateToWidth(left, maxLeft, glyphs.ellipsis, false);
  const padding = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${" ".repeat(padding)}${right}`;
}

/**
 * Display order for the live turn's tool rows: finished calls above running
 * ones. Pi runs a tool batch in parallel, so a later call can finish first;
 * start order alone would leave finished work below a call still in flight,
 * when it belongs above the row that is happening now.
 *
 * A running call ranks with its whole subtree, so a nested call never floats
 * above the parent it is indented under. Event order is kept inside each
 * group. Records whose parent is missing (or in a parent cycle) stay
 * top-level, so nothing is dropped from the tree.
 */
function orderToolRows(tools: readonly ToolRecord[]): ToolRecord[] {
  const byId = new Map<string, ToolRecord>();
  for (const tool of tools) {
    if (tool.id && !byId.has(tool.id)) byId.set(tool.id, tool);
  }

  const childrenByParent = new Map<ToolRecord, ToolRecord[]>();
  const nested = new Set<ToolRecord>();
  for (const tool of tools) {
    const parent =
      tool.parentToolCallId !== undefined && tool.parentToolCallId !== tool.id
        ? byId.get(tool.parentToolCallId)
        : undefined;
    if (!parent) continue;
    const group = childrenByParent.get(parent);
    if (group) group.push(tool);
    else childrenByParent.set(parent, [tool]);
    nested.add(tool);
  }

  // A group is active while it or any descendant is still streaming or running.
  const active = (
    tool: ToolRecord,
    seen: Set<ToolRecord> = new Set(),
  ): boolean => {
    if (seen.has(tool)) return false;
    seen.add(tool);
    if (tool.status === "running" || tool.status === "streaming") return true;
    return (childrenByParent.get(tool) ?? []).some((child) =>
      active(child, seen),
    );
  };

  // Stable partition: finished rows first, running rows last.
  const partition = (group: readonly ToolRecord[]): readonly ToolRecord[] => [
    ...group.filter((tool) => !active(tool)),
    ...group.filter((tool) => active(tool)),
  ];

  const ordered: ToolRecord[] = [];
  const placed = new Set<ToolRecord>();
  const place = (group: readonly ToolRecord[]): void => {
    for (const tool of partition(group)) {
      if (placed.has(tool)) continue;
      placed.add(tool);
      ordered.push(tool);
      place(childrenByParent.get(tool) ?? []);
    }
  };

  place(tools.filter((tool) => !nested.has(tool)));
  // Anything unreachable from a root — a parent cycle — still renders.
  place(tools);
  return ordered;
}

function renderTurn(
  turn: TurnRecord,
  config: PanelConfig,
  state: PanelState,
  width: number,
  theme: ThemeLike,
  expanded: boolean,
): string[] {
  const header = formatTurnHeader(turn, config, state, width, theme);
  const lines: string[] = [header];

  if (width < 40) return lines;

  const tools = orderToolRows(Array.isArray(turn.tools) ? turn.tools : []);
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    let isLast = true;
    for (let later = index + 1; later < tools.length; later++) {
      if (tools[later].parentToolCallId === tool.parentToolCallId) {
        isLast = false;
        break;
      }
    }
    lines.push(renderToolRow(tool, isLast, config, state, width, theme));
    // Streamed arguments are still arriving, and a write's ones grow without
    // bound; the row's summary is the readable part until the call executes.
    if (expanded && tool.status !== "streaming") {
      lines.push(...renderExpandedToolDetails(tool, config, width, theme));
    }
  }

  return lines;
}

function renderQueuedRow(
  text: string,
  config: PanelConfig,
  width: number,
  theme: ThemeLike,
): string {
  const glyphs = glyphsFor(config.glyphs);
  const prefix = `  ${glyphs.prompt} `;
  // The suffix width is measured, never assumed: ascii mode's "..." ellipsis is
  // three columns wide, and the previous fixed budget overflowed the row by it.
  const suffix = ` ${glyphs.dot} queued`;
  const available = Math.max(
    0,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  );
  if (available < 2) {
    return paint(
      theme,
      "dim",
      truncateToWidth(`${prefix}queued`, width, glyphs.ellipsis, false),
    );
  }
  const body = truncateToWidth(
    collapseWhitespace(text),
    available,
    glyphs.ellipsis,
    false,
  );
  return paint(theme, "dim", `${prefix}${body}${suffix}`);
}

/**
 * The prompt block. Collapsed it is one ellipsized row; expanded it wraps the
 * full text in place, with continuation lines aligned under the text column.
 */
function renderPromptRows(
  prompt: string,
  config: PanelConfig,
  width: number,
  theme: ThemeLike,
  expanded: boolean,
): string[] {
  const glyphs = glyphsFor(config.glyphs);
  const prefix = `${glyphs.prompt} `;
  const prefixWidth = visibleWidth(prefix);
  const indent = " ".repeat(prefixWidth);
  const available = Math.max(1, width - prefixWidth);
  const raw = String(prompt ?? "").replace(/\r\n?/g, "\n");

  if (!expanded) {
    const text = truncateAtWord(
      collapseWhitespace(raw),
      available,
      glyphs.ellipsis,
    );
    return [
      paint(theme, "accent", prefix) + paint(theme, "text", italic(theme, text)),
    ];
  }

  // Keep paragraph breaks: a prompt is often a short ask followed by detail.
  const wrapped: string[] = [];
  for (const paragraph of raw.split("\n")) {
    const line = collapseWhitespace(paragraph);
    if (line === "") {
      if (wrapped.length > 0 && wrapped[wrapped.length - 1] !== "") {
        wrapped.push("");
      }
      continue;
    }
    wrapped.push(...wrapTextWithAnsi(line, available));
  }
  while (wrapped.length > 0 && wrapped[wrapped.length - 1] === "") wrapped.pop();

  return wrapped.map((text, index) => {
    if (text === "") return "";
    const lead = index === 0 ? paint(theme, "accent", prefix) : indent;
    return lead + paint(theme, "text", italic(theme, text));
  });
}

/**
 * Pure panel renderer. It reads plain state only and needs no TUI instance.
 * Every returned line is guaranteed to fit the supplied width.
 */
export function renderPanel(
  state: PanelState,
  options: PanelRenderOptions,
  width: number,
  theme: ThemeLike,
): string[] {
  // Layout reports are sparse: every field defaults to "nothing here".
  const report = (patch: Partial<PanelLayout> = {}): void => {
    options?.onLayout?.({
      promptStart: 0,
      promptEnd: 0,
      summaryStart: 0,
      summaryEnd: 0,
      scrollOffset: 0,
      maxScrollOffset: 0,
      totalRows: 0,
      ...patch,
    });
  };

  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) {
    report();
    return [];
  }

  const config: PanelConfig = { ...DEFAULT_CONFIG, ...(options?.config ?? {}) };
  const glyphs = glyphsFor(config.glyphs);

  const terminalRows =
    options?.terminalRows ?? process.stdout.rows ?? 24;
  const budget = Math.min(
    HARD_MAX_ROWS,
    effectiveRowBudget(config, terminalRows),
  );
  // Expanded content may grow past the collapsed budget, but it must never eat
  // most of the screen: cap it at 60% of the terminal, and at the hard ceiling.
  // Pi's own tool-output expansion (`ctrl+o`) asks for the same view. It is an
  // overlay on top of the mode, not a second persistent setting: the config is
  // untouched, so the configured mode returns as soon as the toggle goes off.
  const expanded =
    config.display === "expanded" || options?.toolsExpanded === true;

  // Idle collapse: one totals row instead of the finished tree, or nothing at
  // all. Any active phase (primed/running/interrupted) renders the full panel,
  // so a new run expands on its own without a keypress. The totals row is also
  // the way back in: clicking it opens the tree, and it then sits at the bottom
  // of that tree to fold it again.
  const idleSummary =
    config.idleMode !== "full" && !expanded && isIdlePanel(state);
  const summaryOpen =
    idleSummary && config.idleMode !== "hidden" && state.summaryOpen === true;
  if (idleSummary && !summaryOpen) {
    if (config.idleMode === "hidden") {
      report();
      return [];
    }
    const run = runTotals(state);
    // Nothing to summarize is the same as nothing to show.
    if (run.turns <= 0) {
      report();
      return [];
    }
    report({ summaryEnd: 1, totalRows: 1 });
    return [truncateToWidth(formatRunRow(run, config, theme), safeWidth, "", false)];
  }

  const expandRoom = Math.max(budget, Math.floor(terminalRows * 0.6));
  const cap = expanded ? Math.min(HARD_MAX_ROWS, expandRoom) : budget;

  const promptRows =
    config.showPrompt && state.prompt
      ? renderPromptRows(
          state.prompt,
          config,
          safeWidth,
          theme,
          state.promptExpanded === true,
        )
      : [];
  const content: string[] = [...promptRows];
  const pastTurns = Array.isArray(state.pastTurns) ? state.pastTurns : [];
  // The mode sets the depth: `expanded` shows every retained turn, the other
  // modes keep their fold. Scrolling never changes that.
  const shownPast = shownPastTurns(state, config, expanded);
  const visiblePast = shownPast <= 0 ? [] : pastTurns.slice(-shownPast);
  for (const past of visiblePast) {
    content.push(formatPastTurn(past, config, theme));
  }

  for (const notice of state.notices ?? []) {
    if (notice === "compacted") {
      content.push(paint(theme, "dim", `  ${glyphs.compact} compacted`));
    }
  }

  if (state.currentTurn) {
    content.push(
      ...renderTurn(
        state.currentTurn,
        config,
        state,
        safeWidth,
        theme,
        expanded,
      ),
    );
  }

  for (const queued of state.queued ?? []) {
    content.push(renderQueuedRow(queued, config, safeWidth, theme));
  }

  // Open from the totals row: keep it as the footer, so one more click folds
  // the tree back to that single row.
  let summaryRowTotal = -1;
  if (summaryOpen) {
    summaryRowTotal = content.length;
    content.push(formatRunRow(runTotals(state), config, theme));
  }

  // Window the content instead of folding it away: scrolling up reveals the
  // rows that the budget hides, and the markers say how many are off-screen.
  const totalRows = content.length;
  const maxScrollOffset = Math.max(0, totalRows - cap);
  const requested = state.scroll ?? 0;
  const scrollOffset = Math.max(
    0,
    Math.min(maxScrollOffset, Math.floor(Number.isFinite(requested) ? requested : maxScrollOffset)),
  );
  const end = totalRows - scrollOffset;
  const start = Math.max(0, end - cap);
  const windowRows = content.slice(start, end);
  const below = totalRows - end;
  if (start > 0 && windowRows.length > 0) {
    windowRows[0] = paint(
      theme,
      "dim",
      `  ${glyphs.ellipsis} ${start} earlier`,
    );
  }
  if (below > 0 && windowRows.length > 0) {
    windowRows[windowRows.length - 1] = paint(
      theme,
      "dim",
      `  ${glyphs.ellipsis} ${below} more`,
    );
  }

  // Prompt rows within the window, excluding the scroll markers.
  const promptVisibleEnd = Math.min(
    promptRows.length - start,
    windowRows.length,
  );
  let promptStart = 0;
  let promptEnd = Math.max(0, promptVisibleEnd);
  if (start > 0 && promptEnd > 0) promptStart = 1;
  if (below > 0 && promptEnd > promptStart) {
    promptEnd = Math.min(promptEnd, windowRows.length - 1);
  }
  if (promptEnd <= promptStart) {
    promptStart = 0;
    promptEnd = 0;
  }
  // Same mapping for the totals footer: it is only clickable while it is
  // actually in the window, which is when the tree is pinned to its end.
  let summaryStart = 0;
  let summaryEnd = 0;
  if (summaryRowTotal >= 0) {
    const summaryIndex = summaryRowTotal - start;
    if (summaryIndex >= 0 && summaryIndex < windowRows.length) {
      summaryStart = summaryIndex;
      summaryEnd = summaryIndex + 1;
    }
  }
  report({
    promptStart,
    promptEnd,
    summaryStart,
    summaryEnd,
    scrollOffset,
    maxScrollOffset,
    totalRows,
  });

  return windowRows.map((line) => truncateToWidth(line, safeWidth, "", false));
}

// ---------------------------------------------------------------------------
// Runtime: config I/O and extension registration
// ---------------------------------------------------------------------------

function agentDirectory(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(agentDirectory(), CONFIG_FILE);
}

function readConfigFile(): {
  config: PanelConfig;
  error?: string;
  missing: boolean;
} {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG }, missing: true };
    }
    return {
      config: { ...DEFAULT_CONFIG },
      error: `could not read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      missing: false,
    };
  }
  const parsed = parseConfig(text);
  return { ...parsed, missing: false };
}

function writeConfigFile(config: PanelConfig): { ok: boolean; error?: string } {
  const path = configPath();
  const tempPath = join(
    dirname(path),
    `.${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
    return { ok: true };
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup only.
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractThinkingFromMessage(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  let result = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "thinking") {
      if (typeof block.thinking === "string") result += block.thinking;
    }
  }
  return result;
}

/** A tool call as it exists inside a streaming assistant message. */
export interface StreamedToolCall {
  /** Position in the message's content array; stable while the call streams. */
  index: number;
  id: string;
  name: string;
  /** Partially parsed arguments: fields arrive as their JSON is streamed. */
  args: unknown;
}

/**
 * Tool calls visible in a (partial) assistant message. Pi streams the call
 * before it executes anything, and `arguments` is the JSON parsed so far, so a
 * row can show the path while the model is still writing the file content.
 */
export function extractToolCallsFromMessage(
  message: unknown,
): StreamedToolCall[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const calls: StreamedToolCall[] = [];
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const name = typeof block.name === "string" ? block.name : "";
    // A row without a name cannot say what is being called yet; the next delta
    // carries it, and `toolcall_start` always includes the name.
    if (name === "") continue;
    calls.push({
      index,
      id: typeof block.id === "string" ? block.id : "",
      name,
      args: block.arguments,
    });
  }
  return calls;
}

/**
 * Create or refresh the row for a streamed call. A provider can send a block's
 * arguments before its id, so rows are matched by id first and by content index
 * otherwise; once a call has executed its row is never turned back into a
 * streaming one, because late snapshots repeat the whole block.
 */
export function upsertStreamedTool(
  turn: TurnRecord,
  call: StreamedToolCall,
): void {
  const streamKey = String(call.index);
  let tool =
    (call.id !== ""
      ? turn.tools.find((entry) => entry.id === call.id)
      : undefined) ??
    turn.tools.find((entry) => entry.streamKey === streamKey);

  if (!tool) {
    turn.tools.push({
      id: call.id,
      name: call.name,
      args: call.args,
      summary: summarizeToolArgs(call.name, call.args),
      status: "streaming",
      streamKey,
    });
    return;
  }

  if (tool.status !== "streaming") return;
  if (call.id !== "") tool.id = call.id;
  tool.name = call.name;
  tool.args = call.args;
  tool.summary = summarizeToolArgs(call.name, call.args);
  tool.streamKey = streamKey;
}

/**
 * Tools whose execution began. A call can be streamed and then abandoned (a
 * truncated message, an abort): it has a row but never ran, so it must not
 * inflate the turn's tool count or the run totals.
 */
function executedToolCount(turn: TurnRecord | null | undefined): number {
  const tools = Array.isArray(turn?.tools) ? turn.tools : [];
  return tools.filter((tool) => typeof tool.startedAt === "number").length;
}

function extractResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (isRecord(result)) {
    if (Array.isArray(result.content)) {
      const parts: string[] = [];
      for (const block of result.content) {
        if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
        else if (typeof block === "string") parts.push(block);
      }
      if (parts.length > 0) return parts.join("\n");
      // A content envelope with no text blocks is not output. Falling through to
      // JSON.stringify here rendered {"content":[]} as if it were a result.
      return "";
    }
    if (typeof result.text === "string") return result.text;
    if (typeof result.output === "string") return result.output;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export default function promptPanelExtension(pi: ExtensionAPI): void {
  const state: PanelState = {
    phase: "hidden",
    prompt: "",
    promptExpanded: false,
    summaryOpen: false,
    scroll: 0,
    pastTurns: [],
    currentTurn: null,
    run: { turns: 0, tools: 0, durationMs: 0 },
    queued: [],
    notices: [],
    tick: 0,
    now: 0,
    turnCounter: 0,
  };

  // Turn numbers already folded into `state.run`, so a turn counted at turn_end
  // is not counted again when it is archived or when the run settles.
  const countedTurns = new Set<number>();

  let config: PanelConfig = { ...DEFAULT_CONFIG };
  let configWarned = false;
  let configUnpersisted = false;
  let promptSeen = false;
  let mounted = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let componentToken: object | undefined;
  let renderScheduled = false;

  function scheduleRender(): void {
    if (renderScheduled || !requestRender) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      requestRender?.();
    });
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  /**
   * Advance the thinking preview at most once per `thinkingMs`. Rendering reads
   * this snapshot, so the row holds still between refreshes instead of shifting
   * on every streamed token.
   */
  function refreshThinkingPreview(turn: TurnRecord | null | undefined): void {
    if (!turn?.thinking) return;
    const now = Date.now();
    const interval = Math.max(1, Math.floor(config.thinkingMs));
    if (now - (turn.thinking.previewAt ?? 0) < interval) return;
    turn.thinking.preview = turn.thinking.buffer;
    turn.thinking.previewAt = now;
  }

  function startTimer(): void {
    if (timer !== undefined) return;
    // `animate: false` freezes the running glyph, so there is nothing for the
    // interval to do; events still refresh everything the panel shows.
    if (!config.animate) return;
    timer = setInterval(() => {
      state.now = Date.now();
      state.tick = ((state.tick ?? 0) + 1) % 1_000_000;
      refreshThinkingPreview(state.currentTurn);
      scheduleRender();
    }, config.tickMs);
    // Do not keep a test process or a quitting Pi alive just for the pulse.
    (timer as { unref?: () => void }).unref?.();
  }

  /** Timer state after a config or lifecycle change: on only for a live run. */
  function reconcileTimer(): void {
    stopTimer();
    if (config.enabled && config.animate && state.phase === "running") {
      startTimer();
    }
  }

  function resetState(): void {
    state.phase = "hidden";
    state.prompt = "";
    state.promptExpanded = false;
    state.summaryOpen = false;
    state.scroll = 0;
    state.pastTurns = [];
    state.currentTurn = null;
    state.run = { turns: 0, tools: 0, durationMs: 0 };
    countedTurns.clear();
    state.queued = [];
    state.notices = [];
    state.tick = 0;
    state.now = 0;
    state.turnCounter = 0;
    promptSeen = false;
  }

  /** Start a fresh run summary; called when a new run begins, not on retries. */
  function resetRun(): void {
    countedTurns.clear();
    state.run = { turns: 0, tools: 0, durationMs: 0 };
  }

  /**
   * Fold a finished turn into the run totals exactly once. A turn that never saw
   * `turn_end` (abort, retry, mid-run prompt) still contributes its elapsed time
   * and tool count.
   */
  function countTurn(turn: TurnRecord | null | undefined): void {
    if (!turn || countedTurns.has(turn.number)) return;
    countedTurns.add(turn.number);
    const run =
      state.run ?? (state.run = { turns: 0, tools: 0, durationMs: 0 });
    run.turns += 1;
    run.tools += turn.toolCount ?? executedToolCount(turn);
    run.durationMs +=
      typeof turn.elapsedMs === "number" ? turn.elapsedMs : 0;
    if (turn.aborted) run.aborted = true;
  }

  /** Fill in a missing elapsed time / tool count, then count the turn. */
  function finalizeTurn(turn: TurnRecord | null | undefined): void {
    if (!turn) return;
    if (typeof turn.elapsedMs !== "number") {
      turn.elapsedMs = Math.max(
        0,
        (state.now || Date.now()) - turn.startedAt,
      );
    }
    if (typeof turn.toolCount !== "number") {
      turn.toolCount = executedToolCount(turn);
    }
    countTurn(turn);
  }

  function trimPastTurns(): void {
    const past = state.pastTurns ?? [];
    state.pastTurns =
      past.length > MAX_RETAINED_TURNS
        ? past.slice(-MAX_RETAINED_TURNS)
        : past;
  }

  function archiveCurrentTurn(): void {
    const turn = state.currentTurn;
    if (!turn) return;
    const duration =
      typeof turn.elapsedMs === "number"
        ? turn.elapsedMs
        : Math.max(0, (state.now ?? Date.now()) - turn.startedAt);
    state.pastTurns = [
      ...(state.pastTurns ?? []),
      {
        number: turn.number,
        toolCount: turn.toolCount ?? executedToolCount(turn),
        durationMs: duration,
        aborted: turn.aborted === true,
      },
    ];
    trimPastTurns();
  }

  function ensureTurn(): TurnRecord {
    if (state.currentTurn) return state.currentTurn;
    state.turnCounter = (state.turnCounter ?? 0) + 1;
    const turn: TurnRecord = {
      number: state.turnCounter,
      startedAt: state.now || Date.now(),
      tools: [],
      thinking: null,
      completed: false,
    };
    state.currentTurn = turn;
    return turn;
  }

  function loadConfig(ctx: ExtensionContext): void {
    const loaded = readConfigFile();
    config = loaded.config;
    if (loaded.error && !configWarned) {
      configWarned = true;
      ctx.ui.notify(`prompt-panel: ${loaded.error}; using defaults`, "error");
    }
  }

  function unmount(ctx: ExtensionContext): void {
    mounted = false;
    requestRender = undefined;
    componentToken = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function mount(ctx: ExtensionContext): void {
    if (!config.enabled) {
      unmount(ctx);
      return;
    }
    if (mounted) {
      scheduleRender();
      return;
    }
    mounted = true;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const token = {};
        componentToken = token;
        requestRender = () => tui.requestRender();
        // Where the prompt block and the scroll window landed last render.
        let layout: PanelLayout = {
          promptStart: 0,
          promptEnd: 0,
          summaryStart: 0,
          summaryEnd: 0,
          scrollOffset: 0,
          maxScrollOffset: 0,
          totalRows: 0,
        };
        return {
          render(width: number): string[] {
            return renderPanel(
              state,
              {
                config,
                // Read per frame: Pi toggles this without emitting an event, so
                // the widget's own render is the only place that observes it.
                toolsExpanded: ctx.ui.getToolsExpanded?.() === true,
                terminalRows: tui.terminal?.rows ?? process.stdout.rows ?? 24,
                onLayout: (next) => {
                  layout = next;
                  // Keep the stored offset clamped to what actually fits.
                  state.scroll = next.scrollOffset;
                },
              },
              width,
              theme,
            );
          },
          handleMouse(
            event: TuiMouseEvent,
          ): TuiMouseEventResult | undefined {
            // The wheel never leaves the panel while the pointer is over it. It
            // scrolls the window when the content overflows and does nothing at
            // the bounds, so the transcript underneath never moves.
            if (event.type === "wheel") {
              const step = Math.max(
                1,
                Math.min(5, Math.abs(event.wheelDelta ?? 1)),
              );
              const up = (event.wheelDelta ?? 0) < 0;
              const next = up
                ? Math.min(layout.maxScrollOffset, layout.scrollOffset + step)
                : Math.max(0, layout.scrollOffset - step);
              if (next === layout.scrollOffset) {
                return { handled: true, render: false };
              }
              state.scroll = next;
              return { handled: true };
            }
            if (event.button !== "left") return undefined;
            const onPrompt =
              event.y >= layout.promptStart && event.y < layout.promptEnd;
            const onSummary =
              event.y >= layout.summaryStart && event.y < layout.summaryEnd;
            if (!onPrompt && !onSummary) return undefined;
            // Handle the press so the renderer addresses the click to this
            // component instead of starting a transcript selection.
            if (event.type === "press") return { handled: true, render: false };
            if (event.type !== "click") return undefined;
            if (onSummary) {
              state.summaryOpen = state.summaryOpen !== true;
              state.scroll = 0;
              return { handled: true };
            }
            const expanding = state.promptExpanded !== true;
            state.promptExpanded = expanding;
            // Open at the prompt's first line, not wherever the view was.
            if (expanding) state.scroll = Number.POSITIVE_INFINITY;
            return { handled: true };
          },
          invalidate(): void {
            // Rendering derives everything from live state.
          },
          dispose(): void {
            if (componentToken === token) {
              componentToken = undefined;
              requestRender = undefined;
              mounted = false;
              stopTimer();
            }
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  function persist(ctx: ExtensionContext): void {
    const result = writeConfigFile(config);
    if (!result.ok) {
      // Notify once per failure streak: a read-only home must not emit one error
      // per command.
      const alreadyNotified = configUnpersisted;
      configUnpersisted = true;
      if (!alreadyNotified) {
        ctx.ui.notify(
          `prompt-panel: config not persisted (${result.error ?? "write failed"})`,
          "error",
        );
      }
    } else {
      configUnpersisted = false;
    }
  }

  function usage(ctx: ExtensionContext): void {
    ctx.ui.notify(
      "Usage: /panel [on|off|status|display minimal|compact|expanded|rows <n|auto>|thinking on|off|idle full|glyph|hidden|ascii on|off|reset]",
      "warning",
    );
  }

  /** Apply `enabled` and reconcile the widget and timer with it. */
  function setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    config.enabled = enabled;
    if (!enabled) {
      if (mounted) unmount(ctx);
    } else if (promptSeen) {
      mount(ctx);
    }
    reconcileTimer();
    scheduleRender();
  }

  function reportStatus(ctx: ExtensionContext): void {
    const dot = glyphsFor(config.glyphs).dot;
    ctx.ui.notify(
      `prompt-panel: enabled=${config.enabled ? "on" : "off"} ${dot} rows=${describeBudget()} ${dot} display=${config.display} ${dot} idle=${config.idleMode} ${dot} ${configPath()}`,
      "info",
    );
  }

  /**
   * `/panel` with no arguments opens the settings pane. It is Pi's own
   * `SettingsList`, so the controls are the same as `/settings` and `/tools`:
   * arrows move, Enter or Space cycles a value in place, PageUp/PageDown page the
   * list, Esc closes. Every change is written immediately, so there is no save
   * step and the panel updates behind the pane as you go.
   */
  async function openSettings(ctx: ExtensionContext): Promise<void> {
    if (typeof ctx.ui.custom !== "function") {
      reportStatus(ctx);
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const items = settingsItems(config);
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        settingsListTheme(theme),
        (id, value) => {
          const wasEnabled = config.enabled;
          config = applySettingValue(id, value, config);
          persist(ctx);
          if (config.enabled !== wasEnabled) {
            setEnabled(config.enabled, ctx);
          } else {
            // animate and tickMs both shape the interval, so restart it.
            reconcileTimer();
          }
          scheduleRender();
        },
        () => done(undefined),
      );
      // Same full-width rule Pi draws above and below `/settings`.
      const divider = {
        render(width: number): string[] {
          const rule = glyphsFor(config.glyphs).rule;
          return [theme.fg("border", rule.repeat(Math.max(1, width)))];
        },
        invalidate(): void {},
      };
      const heading = {
        render(width: number): string[] {
          return [
            truncateToWidth(theme.fg("accent", "  prompt-panel"), width, "", false),
            truncateToWidth(theme.fg("dim", `  ${configPath()}`), width, "", false),
            "",
          ];
        },
        invalidate(): void {},
      };
      // Everything above the list: the rule, then the heading.
      const rowsBeforeList = 4;
      const container = new Container();
      container.addChild(divider);
      container.addChild(heading);
      container.addChild(list);
      container.addChild(divider);
      return {
        // PageUp/PageDown page the list instead of scrolling the transcript.
        capturesViewportInput: list.capturesViewportInput,
        render(width: number): string[] {
          return container.render(width);
        },
        invalidate(): void {
          container.invalidate();
        },
        handleInput(data: string): void {
          list.handleInput?.(data);
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
          const result = list.handleMouse?.({
            ...event,
            y: event.y - rowsBeforeList,
          });
          if (result) tui.requestRender();
          return result;
        },
      };
    });
  }

  function describeBudget(): string {
    const rows = process.stdout.rows ?? 24;
    if (config.maxRows === "auto") {
      return `auto (${effectiveRowBudget(config, rows)})`;
    }
    return String(config.maxRows);
  }

  // ---- lifecycle events ---------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopTimer();
    if (mounted) unmount(ctx);
    resetState();
    configWarned = false;
    configUnpersisted = false;
    loadConfig(ctx);
    state.phase = "hidden";
  });

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.source === "extension") return;

    if (
      event.streamingBehavior === "steer" ||
      event.streamingBehavior === "followUp"
    ) {
      state.queued = [...(state.queued ?? []), String(event.text ?? "")];
      scheduleRender();
      return;
    }

    promptSeen = true;
    state.prompt = String(event.text ?? "");
    // A new ask starts collapsed and pinned to its own content.
    state.promptExpanded = false;
    state.summaryOpen = false;
    state.scroll = 0;
    state.now = Date.now();
    finalizeTurn(state.currentTurn);
    archiveCurrentTurn();
    state.currentTurn = null;
    // Turn numbering stays monotonic for the session: past-turn rows survive a
    // new prompt, so restarting at 1 would render "turn 3, turn 4, turn 1".
    state.notices = [];
    state.queued = [];
    state.phase = "primed";
    mount(ctx);
    scheduleRender();
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.messageType === "custom") return;
    if (!state.prompt && typeof event.prompt === "string") {
      state.prompt = event.prompt;
    }
    scheduleRender();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // A retry or queued continuation re-enters the same run; only a run starting
    // from idle/primed begins a new set of totals.
    if (state.phase !== "running") resetRun();
    state.phase = "running";
    state.now = Date.now();
    reconcileTimer();
    scheduleRender();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.now = Date.now();
    finalizeTurn(state.currentTurn);
    archiveCurrentTurn();
    state.currentTurn = null;
    state.turnCounter = (state.turnCounter ?? 0) + 1;
    state.currentTurn = {
      number: state.turnCounter,
      startedAt: Date.now(),
      tools: [],
      thinking: null,
      completed: false,
    };
    state.now = Date.now();
    scheduleRender();
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const turn = state.currentTurn;
    if (!turn) return;
    state.now = Date.now();
    turn.completed = true;
    turn.elapsedMs = Math.max(0, state.now - turn.startedAt);
    turn.toolCount = executedToolCount(turn);
    countTurn(turn);
    scheduleRender();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Pi may retry, compact-and-retry, or continue with queued work.
    state.now = Date.now();
    scheduleRender();
  });

  pi.on("agent_settled", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopTimer();
    state.now = Date.now();
    const turn = state.currentTurn;
    if (event.aborted) {
      state.phase = "interrupted";
      if (turn) {
        turn.aborted = true;
        if (typeof turn.elapsedMs !== "number") {
          turn.elapsedMs = Math.max(0, state.now - turn.startedAt);
        }
        for (const tool of turn.tools) {
          if (tool.status === "running" || tool.status === "streaming") {
            const startedAt = tool.startedAt;
            tool.status = "interrupted";
            // A call that was still being written never ran, so it has no
            // duration of its own to report.
            if (typeof tool.durationMs !== "number" && typeof startedAt === "number") {
              tool.durationMs = Math.max(0, state.now - startedAt);
            }
          }
        }
        if (turn.thinking) turn.thinking.done = true;
      }
    } else {
      state.phase = "idle";
    }
    // Covers the last turn of the run, including an aborted one that never saw
    // `turn_end`.
    finalizeTurn(turn);
    // A tree opened from the totals row is a look at this run, not a mode:
    // collapse again once the next run settles.
    state.summaryOpen = false;
    scheduleRender();
  });

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const role = event.message?.role;
    if (role === "user") {
      if ((state.queued ?? []).length > 0) {
        state.queued = (state.queued ?? []).slice(1);
        scheduleRender();
      }
      return;
    }
    if (role === "assistant") {
      const turn = ensureTurn();
      if (!turn.thinking) turn.thinking = { buffer: "", done: false };
      scheduleRender();
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const update = event.assistantMessageEvent;
    if (!isRecord(update)) return;
    const type = update.type;

    // A tool call becomes visible while the model is still writing its
    // arguments, seconds before Pi executes it. Building the row from that
    // stream is what makes `write`/`edit` (which execute in milliseconds)
    // readable at all; `tool_execution_start` then takes the same row over.
    if (
      type === "toolcall_start" ||
      type === "toolcall_delta" ||
      type === "toolcall_end"
    ) {
      const calls = extractToolCallsFromMessage(
        update.partial ?? event.message,
      );
      if (calls.length > 0) {
        const turn = ensureTurn();
        for (const call of calls) upsertStreamedTool(turn, call);
        scheduleRender();
      }
      return;
    }

    if (
      type !== "thinking_start" &&
      type !== "thinking_delta" &&
      type !== "thinking_end"
    ) {
      return;
    }

    const turn = ensureTurn();
    if (!turn.thinking) turn.thinking = { buffer: "", done: false };

    if (type === "thinking_start") {
      turn.thinking.buffer = "";
      turn.thinking.done = false;
      turn.thinking.preview = "";
      turn.thinking.previewAt = 0;
    } else if (type === "thinking_delta") {
      const fromPartial = extractThinkingFromMessage(update.partial);
      if (fromPartial !== "") turn.thinking.buffer = fromPartial;
      else if (typeof update.delta === "string") {
        turn.thinking.buffer += update.delta;
      }
    } else {
      const finalText =
        typeof update.content === "string"
          ? update.content
          : extractThinkingFromMessage(update.partial);
      if (finalText !== "") turn.thinking.buffer = finalText;
      turn.thinking.done = true;
    }
    if (type === "thinking_end") {
      turn.thinking.preview = turn.thinking.buffer;
      turn.thinking.previewAt = Date.now();
    } else {
      refreshThinkingPreview(turn);
    }
    scheduleRender();
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const message = event.message;
    if (message?.role !== "assistant") return;
    const turn = state.currentTurn;
    if (turn) {
      const thinking = extractThinkingFromMessage(message);
      if (thinking !== "") {
        turn.thinking = { buffer: thinking, done: true, preview: thinking };
      } else if (turn.thinking) {
        turn.thinking.done = true;
      }
      if (message.stopReason === "aborted") turn.aborted = true;
      if (message.stopReason === "error") turn.hadError = true;
    }
    scheduleRender();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const turn = ensureTurn();
    const id = String(event.toolCallId ?? "");
    const name = String(event.toolName ?? "tool");
    const tool: ToolRecord = {
      id,
      name,
      args: event.args,
      summary: summarizeToolArgs(name, event.args),
      status: "running",
      startedAt: Date.now(),
      parentToolCallId: event.parentToolCallId,
    };
    let existing =
      id === "" ? -1 : turn.tools.findIndex((entry) => entry.id === id);
    if (existing < 0) {
      // The streamed row never learned its id (some providers stream arguments
      // before the call id): adopt it instead of drawing the call twice.
      existing = turn.tools.findIndex(
        (entry) =>
          entry.status === "streaming" &&
          entry.id === "" &&
          (entry.name === name || entry.name === ""),
      );
    }
    if (existing >= 0) turn.tools[existing] = tool;
    else turn.tools.push(tool);
    scheduleRender();
  });

  pi.on("tool_execution_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const turn = state.currentTurn;
    if (!turn) return;
    const tool = turn.tools.find((entry) => entry.id === event.toolCallId);
    if (!tool) return;
    tool.partialText = extractResultText(event.partialResult);
    scheduleRender();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const turn = ensureTurn();
    let tool = turn.tools.find((entry) => entry.id === event.toolCallId);
    if (!tool) {
      tool = {
        id: String(event.toolCallId ?? ""),
        name: String(event.toolName ?? "tool"),
        args: event.args,
        summary: summarizeToolArgs(String(event.toolName ?? "tool"), event.args),
        status: "running",
        startedAt: Date.now(),
        parentToolCallId: event.parentToolCallId,
      };
      turn.tools.push(tool);
    }
    state.now = Date.now();
    const isError = event.isError === true;
    tool.status = isError ? "error" : "success";
    tool.durationMs =
      typeof event.durationMs === "number"
        ? event.durationMs
        : Math.max(0, state.now - (tool.startedAt ?? state.now));
    const text = extractResultText(event.result);
    if (isError) tool.errorText = text;
    else tool.resultText = text;
    tool.partialText = "";
    if (tool.name === "edit") {
      const diff = countEditDiff(event.result);
      tool.diff = diff.added > 0 || diff.removed > 0 ? diff : null;
    }
    scheduleRender();
  });

  pi.on("session_compact", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // One dim row per compaction state, not one per event.
    const notices = state.notices ?? [];
    if (notices[notices.length - 1] !== "compacted") {
      state.notices = [...notices, "compacted"];
    }
    scheduleRender();
  });

  pi.on("session_compact_failed", (_event, _ctx) => {
    // Failed compactions do not add a row.
  });

  pi.on("session_tree", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopTimer();
    if (mounted) unmount(ctx);
    resetState();
    state.phase = "hidden";
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopTimer();
    if (mounted) unmount(ctx);
    resetState();
  });

  // ---- command ------------------------------------------------------------

  pi.registerCommand("panel", {
    description: "Open the prompt-panel settings, or configure it directly",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      // After a failed write, the in-memory value is the user's latest choice.
      if (!configUnpersisted) loadConfig(ctx);

      const words = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (words.length === 0) {
        await openSettings(ctx);
        return;
      }

      const command = words[0];
      if (command === "status") {
        reportStatus(ctx);
        return;
      }
      if (command === "on" || command === "off") {
        if (words.length !== 1) {
          usage(ctx);
          return;
        }
        setEnabled(command === "on", ctx);
        persist(ctx);
        return;
      }

      if (command === "rows") {
        if (words.length !== 2) {
          usage(ctx);
          return;
        }
        const value = words[1];
        if (value === "auto") {
          config.maxRows = "auto";
        } else {
          const number = Number(value);
          if (!isIntegerInRange(number, 1, HARD_MAX_ROWS)) {
            usage(ctx);
            return;
          }
          config.maxRows = number;
        }
        persist(ctx);
        scheduleRender();
        return;
      }

      if (command === "thinking") {
        if (words.length !== 2 || (words[1] !== "on" && words[1] !== "off")) {
          usage(ctx);
          return;
        }
        config.showThinking = words[1] === "on";
        persist(ctx);
        scheduleRender();
        return;
      }

      if (command === "ascii") {
        if (words.length !== 2 || (words[1] !== "on" && words[1] !== "off")) {
          usage(ctx);
          return;
        }
        config.glyphs = words[1] === "on" ? "ascii" : "unicode";
        persist(ctx);
        scheduleRender();
        return;
      }

      if (command === "idle") {
        if (
          words.length !== 2 ||
          (words[1] !== "full" && words[1] !== "glyph" && words[1] !== "hidden")
        ) {
          usage(ctx);
          return;
        }
        config.idleMode = words[1];
        persist(ctx);
        scheduleRender();
        return;
      }

      if (command === "display") {
        if (words.length !== 2 || !isDisplayMode(words[1])) {
          usage(ctx);
          return;
        }
        config.display = words[1];
        persist(ctx);
        scheduleRender();
        return;
      }

      if (command === "reset") {
        if (words.length !== 1) {
          usage(ctx);
          return;
        }
        config = { ...DEFAULT_CONFIG };
        persist(ctx);
        if (config.enabled) {
          if (promptSeen) mount(ctx);
        } else if (mounted) {
          unmount(ctx);
        }
        reconcileTimer();
        scheduleRender();
        return;
      }

      usage(ctx);
    },
  });
}
