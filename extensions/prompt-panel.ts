// Prompt panel: a compact live tree of the current run, rendered above the editor.
//
// This module intentionally has no import-time side effects. Everything happens
// inside the default export or in event/command handlers.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "prompt-panel";
const CONFIG_FILE = "prompt-panel.json";
const HARD_MAX_ROWS = 48;

export type GlyphMode = "unicode" | "ascii";

export interface PanelConfig {
  enabled: boolean;
  maxRows: "auto" | number;
  pastTurns: number;
  showPrompt: boolean;
  showThinking: boolean;
  thinkingPreviewChars: number;
  animate: boolean;
  tickMs: number;
  /** How long the running glyph holds before it alternates. Independent of tickMs. */
  pulseMs: number;
  /** How often the thinking preview advances; keeps the row from crawling per token. */
  thinkingMs: number;
  /** always = args and results visible; follow = ctrl+o decides; never = one line per tool. */
  expand: ExpandMode;
  glyphs: GlyphMode;
}

export type ExpandMode = "always" | "follow" | "never";

export const DEFAULT_CONFIG: Readonly<PanelConfig> = Object.freeze({
  enabled: true,
  maxRows: "auto",
  pastTurns: 2,
  showPrompt: true,
  showThinking: true,
  thinkingPreviewChars: 60,
  animate: true,
  tickMs: 200,
  pulseMs: 600,
  thinkingMs: 500,
  expand: "follow",
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

export interface ToolRecord {
  id: string;
  name: string;
  args?: unknown;
  summary: string;
  status: "running" | "success" | "error" | "interrupted";
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

export interface PanelState {
  phase?: "hidden" | "primed" | "running" | "idle" | "interrupted";
  prompt?: string;
  pastTurns?: PastTurn[];
  currentTurn?: TurnRecord | null;
  queued?: string[];
  notices?: string[];
  tick?: number;
  now?: number;
  turnCounter?: number;
}

export interface PanelRenderOptions {
  config?: Partial<PanelConfig>;
  expanded?: boolean;
  terminalRows?: number;
}

interface ThemeLike {
  fg(token: string, text: string): string;
}

interface Glyphs {
  prompt: string;
  check: string;
  cross: string;
  running: string;
  runningAlt: string;
  thinking: string;
  branch: string;
  last: string;
  dot: string;
  ellipsis: string;
  compact: string;
  vertical: string;
  minus: string;
}

function glyphsFor(mode: GlyphMode): Glyphs {
  if (mode === "ascii") {
    return {
      prompt: ">",
      check: "v",
      cross: "x",
      running: "*",
      runningAlt: "o",
      thinking: "*",
      branch: "|",
      last: "+",
      dot: ".",
      ellipsis: "...",
      compact: "...",
      vertical: "|",
      minus: "-",
    };
  }
  return {
    prompt: "❯",
    check: "✓",
    cross: "✗",
    running: "●",
    runningAlt: "○",
    thinking: "✻",
    branch: "├",
    last: "└",
    dot: "·",
    ellipsis: "…",
    compact: "⋯",
    vertical: "│",
    minus: "−",
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
  if (hasOwn(value, "pastTurns")) {
    if (
      typeof value.pastTurns === "number" &&
      Number.isInteger(value.pastTurns) &&
      value.pastTurns >= 0
    ) {
      config.pastTurns = value.pastTurns;
    } else errors.push("pastTurns must be a non-negative integer");
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
  if (hasOwn(value, "expand")) {
    if (
      value.expand === "always" ||
      value.expand === "follow" ||
      value.expand === "never"
    ) {
      config.expand = value.expand;
    } else errors.push('expand must be "always", "follow", or "never"');
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

  if (width < 40) {
    const parts = [`turn ${turn.number}`];
    if (turn.tools.length > 0) parts.push(pluralTools(turn.tools.length));
    return `  ${paint(theme, token, mark)} ${paint(
      theme,
      "text",
      parts.join(` ${glyphs.dot} `),
    )}`;
  }

  const details = [`turn ${turn.number}`];
  if (turn.completed === true) {
    const count = turn.toolCount ?? turn.tools.length;
    if (count > 0) details.push(pluralTools(count));
    if (typeof turn.elapsedMs === "number") {
      details.push(formatDuration(turn.elapsedMs));
    }
  }
  return `  ${paint(theme, token, mark)} ${paint(
    theme,
    running ? "text" : "muted",
    details.join(` ${glyphs.dot} `),
  )}`;
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

/** Text after the last sentence terminator: the thought currently in progress. */
function lastSentence(text: string): string {
  let index = -1;
  for (const mark of [". ", "! ", "? ", "; ", ": "]) {
    const found = text.lastIndexOf(mark);
    if (found > index) index = found;
  }
  return index >= 0 ? text.slice(index + 2).trim() : "";
}

/** Drop a leading partial word so the row never starts mid-word. */
function snapToWordStart(text: string): string {
  if (text === "") return text;
  if (/^\s/.test(text)) return text.replace(/^\s+/, "");
  const space = text.indexOf(" ");
  // Only snap in the first column or two of content; a long partial word stays.
  return space > 0 && space <= 12 ? text.slice(space + 1) : text;
}

function thinkingTail(
  thinking: ThinkingRecord,
  config: PanelConfig,
  width: number,
  glyphs: Glyphs,
): string | undefined {
  const clean = collapseWhitespace(thinking.preview ?? thinking.buffer);
  if (clean === "") return undefined;

  const prefix = `    ${glyphs.thinking} Thinking ${glyphs.dot} `;
  const limit = Math.max(1, Math.floor(config.thinkingPreviewChars));
  const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(glyphs.ellipsis));
  const total = visibleWidth(clean);
  const take = Math.max(1, Math.min(limit, available));

  // Prefer the sentence in progress: it reads like a thought and holds still
  // until the sentence ends, instead of sliding one character at a time.
  const sentence = lastSentence(clean);
  if (sentence !== "" && visibleWidth(sentence) <= take) {
    return `${prefix}${sentence}`;
  }

  if (total <= take) {
    return `${prefix}${clean}`;
  }
  const start = Math.max(0, total - take);
  const tail = sliceByColumn(clean, start, take);
  return `${prefix}${glyphs.ellipsis}${snapToWordStart(tail)}`;
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
  } else if (width >= 60 && typeof tool.durationMs === "number") {
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

  // The thinking row exists to show what the agent is doing *now*. Once the turn
  // finishes it is stale, so a settled panel keeps the tools but drops the thought.
  const turnFinished = turn.completed === true || turn.aborted === true;
  if (config.showThinking && turn.thinking && !turnFinished) {
    const glyphs = glyphsFor(config.glyphs);
    const row = thinkingTail(turn.thinking, config, width, glyphs);
    if (row) lines.push(paint(theme, "thinkingText", row));
  }

  const tools = Array.isArray(turn.tools) ? turn.tools : [];
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
    if (expanded) {
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

function renderPromptRow(
  prompt: string,
  config: PanelConfig,
  width: number,
  theme: ThemeLike,
): string {
  const glyphs = glyphsFor(config.glyphs);
  const prefix = `${glyphs.prompt} `;
  const available = Math.max(0, width - visibleWidth(prefix));
  const text = truncateToWidth(
    collapseWhitespace(prompt),
    available,
    glyphs.ellipsis,
    false,
  );
  return paint(theme, "accent", prefix) + paint(theme, "text", text);
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
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return [];

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
  const expanded =
    config.expand === "always"
      ? true
      : config.expand === "never"
        ? false
        : options?.expanded === true;
  const expandRoom = Math.max(budget, Math.floor(terminalRows * 0.6));
  const cap = expanded ? Math.min(HARD_MAX_ROWS, expandRoom) : budget;

  const lines: string[] = [];
  if (config.showPrompt && state.prompt) {
    lines.push(renderPromptRow(state.prompt, config, safeWidth, theme));
  }

  const body: string[] = [];
  const pastTurns = Array.isArray(state.pastTurns) ? state.pastTurns : [];
  const visiblePast =
    config.pastTurns <= 0 ? [] : pastTurns.slice(-config.pastTurns);
  for (const past of visiblePast) {
    body.push(formatPastTurn(past, config, theme));
  }

  for (const notice of state.notices ?? []) {
    if (notice === "compacted") {
      body.push(paint(theme, "dim", `  ${glyphs.compact} compacted`));
    }
  }

  if (state.currentTurn) {
    body.push(
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
    body.push(renderQueuedRow(queued, config, safeWidth, theme));
  }

  const promptRows = lines.length;
  const bodyCap = Math.max(0, Math.min(HARD_MAX_ROWS - promptRows, cap - promptRows));
  if (body.length > bodyCap) {
    const keep = Math.max(0, bodyCap - 1);
    const dropped = body.length - keep;
    body.splice(0, dropped);
    if (bodyCap >= 1) {
      body.unshift(
        paint(theme, "dim", `  ${glyphs.ellipsis} ${dropped} earlier`),
      );
    } else {
      body.length = 0;
    }
  }

  lines.push(...body);
  return lines.map((line) => truncateToWidth(line, safeWidth, "", false));
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
    pastTurns: [],
    currentTurn: null,
    queued: [],
    notices: [],
    tick: 0,
    now: 0,
    turnCounter: 0,
  };

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
    timer = setInterval(() => {
      state.now = Date.now();
      state.tick = ((state.tick ?? 0) + 1) % 1_000_000;
      refreshThinkingPreview(state.currentTurn);
      scheduleRender();
    }, config.tickMs);
    // Do not keep a test process or a quitting Pi alive just for the pulse.
    (timer as { unref?: () => void }).unref?.();
  }

  function resetState(): void {
    state.phase = "hidden";
    state.prompt = "";
    state.pastTurns = [];
    state.currentTurn = null;
    state.queued = [];
    state.notices = [];
    state.tick = 0;
    state.now = 0;
    state.turnCounter = 0;
    promptSeen = false;
  }

  function trimPastTurns(): void {
    const limit = Math.max(0, Math.floor(config.pastTurns));
    state.pastTurns = limit === 0 ? [] : (state.pastTurns ?? []).slice(-limit);
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
        toolCount: turn.toolCount ?? turn.tools.length,
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
        return {
          render(width: number): string[] {
            return renderPanel(
              state,
              {
                config,
                expanded: ctx.ui.getToolsExpanded(),
                terminalRows: tui.terminal?.rows ?? process.stdout.rows ?? 24,
              },
              width,
              theme,
            );
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
      "Usage: /panel [on|off|rows <n|auto>|thinking on|off|ascii on|off|expand always|follow|never|reset]",
      "warning",
    );
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
    archiveCurrentTurn();
    state.currentTurn = null;
    // Turn numbering stays monotonic for the session: past-turn rows survive a
    // new prompt, so restarting at 1 would render "turn 3, turn 4, turn 1".
    state.notices = [];
    state.queued = [];
    state.phase = "primed";
    state.now = Date.now();
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
    state.phase = "running";
    state.now = Date.now();
    if (config.enabled) startTimer();
    scheduleRender();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
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
    turn.toolCount = turn.tools.length;
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
          if (tool.status === "running") {
            tool.status = "interrupted";
            if (typeof tool.durationMs !== "number") {
              tool.durationMs = Math.max(
                0,
                state.now - (tool.startedAt ?? turn.startedAt),
              );
            }
          }
        }
        if (turn.thinking) turn.thinking.done = true;
      }
    } else {
      state.phase = "idle";
    }
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
    const tool: ToolRecord = {
      id: String(event.toolCallId ?? ""),
      name: String(event.toolName ?? "tool"),
      args: event.args,
      summary: summarizeToolArgs(String(event.toolName ?? "tool"), event.args),
      status: "running",
      startedAt: Date.now(),
      parentToolCallId: event.parentToolCallId,
    };
    const existing = turn.tools.findIndex((entry) => entry.id === tool.id);
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
    description: "Show or configure the prompt panel",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      // After a failed write, the in-memory value is the user's latest choice.
      if (!configUnpersisted) loadConfig(ctx);

      const words = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (words.length === 0) {
        ctx.ui.notify(
          `prompt-panel: enabled=${config.enabled ? "on" : "off"} ${glyphsFor(config.glyphs).dot} rows=${describeBudget()} ${glyphsFor(config.glyphs).dot} expand=${config.expand} ${glyphsFor(config.glyphs).dot} ${configPath()}`,
          "info",
        );
        return;
      }

      const command = words[0];
      if (command === "on" || command === "off") {
        if (words.length !== 1) {
          usage(ctx);
          return;
        }
        config.enabled = command === "on";
        persist(ctx);
        if (!config.enabled) {
          stopTimer();
          if (mounted) unmount(ctx);
        } else if (promptSeen) {
          mount(ctx);
          if (state.phase === "running") startTimer();
        }
        scheduleRender();
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

      if (command === "expand") {
        if (
          words.length !== 2 ||
          (words[1] !== "always" &&
            words[1] !== "follow" &&
            words[1] !== "never")
        ) {
          usage(ctx);
          return;
        }
        config.expand = words[1];
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
          if (state.phase === "running") startTimer();
        } else if (mounted) {
          unmount(ctx);
          stopTimer();
        }
        scheduleRender();
        return;
      }

      usage(ctx);
    },
  });
}
