// Harness for the prompt-panel extension.
// Run with: node tests/prompt-panel/run.mjs
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));

// A fresh `.mts` copy is unambiguously ESM regardless of the enclosing package
// type, and it keeps the harness working whether it runs from this repo or from a
// `~/.pi/agent` checkout. Keep the temporary directory under the test folder so
// Node resolves `node_modules`; always remove it.
const extensionSourcePath = join(
  here,
  "..",
  "..",
  "extensions",
  "prompt-panel.ts",
);
const tempDir = mkdtempSync(join(here, ".tmp-prompt-panel-"));
let mod;
try {
  const copyPath = join(tempDir, "prompt-panel.mts");
  writeFileSync(copyPath, readFileSync(extensionSourcePath));
  mod = await import(pathToFileURL(copyPath).href);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const {
  DEFAULT_CONFIG,
  DISPLAY_MODES,
  applySettingValue,
  isDisplayMode,
  parseConfig,
  pastTurnsFor,
  effectiveRowBudget,
  middleEllipsize,
  formatDuration,
  summarizeToolArgs,
  countEditDiff,
  renderPanel,
  settingsItems,
} = mod;

// Compact baseline: the shipped default mode, pinned explicitly so row-budget
// cases do not silently follow a default change.
const COMPACT_MODE = { ...DEFAULT_CONFIG, display: "compact" };

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ""}`);
    failures++;
  }
}

const RESET = "\x1b[0m";
const TOKEN_CODES = {
  accent: 31,
  text: 32,
  muted: 33,
  dim: 34,
  success: 35,
  error: 36,
  warning: 37,
  toolTitle: 38,
  toolOutput: 39,
  thinkingText: 40,
  border: 41,
};
const ansi = (token) => `\x1b[${TOKEN_CODES[token] ?? 0}m`;
const theme = {
  fg(token, text) {
    return `${ansi(token)}${text}${RESET}`;
  },
};

const NOW = 1_700_000_000_000;

function makeState(overrides = {}) {
  return {
    phase: "running",
    prompt: "refactor the auth middleware to use the new token store",
    pastTurns: [{ number: 1, toolCount: 3, durationMs: 8400 }],
    currentTurn: {
      number: 2,
      startedAt: NOW - 1200,
      completed: false,
      thinking: {
        buffer:
          "I need to check where the retry loop should go and then update the auth middleware",
        done: false,
      },
      tools: [
        {
          id: "t1",
          name: "read",
          args: { path: "src/very/long/directory/middleware.ts" },
          summary: "src/very/long/directory/middleware.ts",
          status: "success",
          durationMs: 120,
          startedAt: NOW - 1200,
        },
        {
          id: "t2",
          name: "edit",
          args: {
            path: "src/http/fetch.ts",
            oldText: "old",
            newText: "new",
          },
          summary: "src/http/fetch.ts",
          status: "running",
          diff: { added: 9, removed: 2 },
          startedAt: NOW - 100,
        },
        {
          id: "t3",
          name: "bash",
          args: { command: "pnpm test" },
          summary: "pnpm test",
          status: "error",
          durationMs: 2500,
          startedAt: NOW - 900,
          errorText: "Error: the test suite failed\nsecond error line",
        },
      ],
    },
    queued: ["also update docs"],
    notices: ["compacted"],
    tick: 1,
    now: NOW,
    ...overrides,
  };
}

function allLinesFit(lines, width) {
  return lines.every((line) => visibleWidth(line) <= width);
}

function describeOverflow(lines, width) {
  return lines
    .filter((line) => visibleWidth(line) > width)
    .slice(0, 3)
    .map((line) => `${visibleWidth(line)}>${width}: ${JSON.stringify(line)}`)
    .join(" | ");
}

// ---- exports and import safety --------------------------------------------
{
  const expected = [
    "DEFAULT_CONFIG",
    "DISPLAY_MODES",
    "applySettingValue",
    "countEditDiff",
    "effectiveRowBudget",
    "formatDuration",
    "isDisplayMode",
    "middleEllipsize",
    "parseConfig",
    "pastTurnsFor",
    "renderPanel",
    "settingsItems",
    "summarizeToolArgs",
  ].sort();
  const actual = Object.keys(mod)
    .filter((key) => key !== "default")
    .sort();
  check(
    "exports: exactly the documented runtime helpers plus a default function",
    typeof mod.default === "function" &&
      actual.length === expected.length &&
      expected.every((name, index) => actual[index] === name),
    `actual=${actual.join(",")} default=${typeof mod.default}`,
  );
}

// ---- parseConfig -----------------------------------------------------------
{
  const result = parseConfig(undefined);
  check(
    "parseConfig(undefined): defaults",
    !result.error &&
      result.config.enabled === DEFAULT_CONFIG.enabled &&
      result.config.maxRows === "auto" &&
      result.config.tickMs === 200,
    JSON.stringify(result),
  );
}
{
  const result = parseConfig(
    JSON.stringify({
      enabled: false,
      maxRows: 12,
      display: "minimal",
      showPrompt: false,
      showThinking: false,
      thinkingPreviewChars: 20,
      animate: false,
      tickMs: 250,
      idleMode: "glyph",
      glyphs: "ascii",
    }),
  );
  check(
    "parseConfig(valid JSON string): merges every field",
    !result.error &&
      result.config.enabled === false &&
      result.config.maxRows === 12 &&
      result.config.display === "minimal" &&
      result.config.showPrompt === false &&
      result.config.showThinking === false &&
      result.config.thinkingPreviewChars === 20 &&
      result.config.animate === false &&
      result.config.tickMs === 250 &&
      result.config.idleMode === "glyph" &&
      result.config.glyphs === "ascii",
    JSON.stringify(result),
  );
}
{
  const result = parseConfig({});
  check(
    "parseConfig({}): idleMode defaults to glyph",
    !result.error && result.config.idleMode === "glyph",
    JSON.stringify(result),
  );
}
for (const [label, value] of [
  ["broken JSON", "{"],
  ["maxRows 0", { maxRows: 0 }],
  ["maxRows 49", { maxRows: 49 }],
  ["display sometimes", { display: "sometimes" }],
  ["tickMs 0", { tickMs: 0 }],
  ["glyphs nope", { glyphs: "nope" }],
  ["idleMode sometimes", { idleMode: "sometimes" }],
  ["enabled string", { enabled: "yes" }],
]) {
  const result = parseConfig(value);
  check(
    `parseConfig(${label}): error and full defaults`,
    !!result.error &&
      result.config.enabled === DEFAULT_CONFIG.enabled &&
      result.config.maxRows === "auto" &&
      result.config.glyphs === "unicode",
    JSON.stringify(result),
  );
}

{
  check(
    "parseConfig: display defaults to compact",
    parseConfig({}).config.display === "compact",
    JSON.stringify(parseConfig({})),
  );
  const legacy = [
    [{ expand: "always" }, "expanded"],
    [{ expand: "follow" }, "compact"],
    [{ expand: "never" }, "compact"],
    [{ pastTurns: 0 }, "minimal"],
    [{ pastTurns: 8 }, "compact"],
    [{ display: "minimal", expand: "always" }, "minimal"],
  ];
  check(
    "parseConfig: the old expand/pastTurns pair still maps to a mode",
    legacy.every(
      ([input, expected]) => parseConfig(input).config.display === expected,
    ),
    JSON.stringify(legacy.map(([input]) => parseConfig(input).config.display)),
  );
  check(
    "pastTurnsFor: minimal none, compact two, expanded everything",
    pastTurnsFor("minimal") === 0 &&
      pastTurnsFor("compact") === 2 &&
      pastTurnsFor("expanded") === Number.POSITIVE_INFINITY,
  );
  check(
    "isDisplayMode accepts exactly the three modes",
    DISPLAY_MODES.length === 3 &&
      DISPLAY_MODES.every((mode) => isDisplayMode(mode)) &&
      !isDisplayMode("always") &&
      !isDisplayMode(undefined),
  );
}

// ---- row budget ------------------------------------------------------------
{
  const auto = { ...COMPACT_MODE, maxRows: "auto" };
  check(
    "effectiveRowBudget: auto clamps to 6..18",
    effectiveRowBudget(auto, 10) === 6 &&
      effectiveRowBudget(auto, 24) === 7 &&
      effectiveRowBudget(auto, 40) === 12 &&
      effectiveRowBudget(auto, 100) === 18,
    [10, 24, 40, 100]
      .map((rows) => `${rows}:${effectiveRowBudget(auto, rows)}`)
      .join(","),
  );
  check(
    "effectiveRowBudget: numeric override clamps to 1..48",
    effectiveRowBudget({ ...COMPACT_MODE, maxRows: 0 }, 24) === 1 &&
      effectiveRowBudget({ ...COMPACT_MODE, maxRows: 52 }, 24) === 48 &&
      effectiveRowBudget({ ...COMPACT_MODE, maxRows: 9 }, 24) === 9,
  );
}

// ---- middle ellipsis -------------------------------------------------------
{
  const path = "src/really/long/path/fetch.ts";
  const mid = middleEllipsize(path, 20);
  check(
    "middleEllipsize: keeps fetch.ts and uses a middle ellipsis",
    mid.includes("fetch.ts") && mid.includes("…") && visibleWidth(mid) <= 20,
    JSON.stringify(mid),
  );
  const narrow = middleEllipsize(path, 11);
  check(
    "middleEllipsize: under ~12 cols falls back to the basename",
    narrow.includes("fetch.ts") && visibleWidth(narrow) <= 11,
    JSON.stringify(narrow),
  );
  const tiny = middleEllipsize(path, 7);
  check(
    "middleEllipsize: tiny widths are safe",
    visibleWidth(tiny) <= 7,
    JSON.stringify(tiny),
  );
  const ascii = middleEllipsize(path, 20, "ascii");
  check(
    "middleEllipsize: ascii mode has no non-ASCII bytes",
    /^[\x00-\x7F]*$/.test(ascii) && ascii.includes("fetch.ts"),
    JSON.stringify(ascii),
  );
  const emoji = "src/🚀🚀/deep/fetch.ts";
  check(
    "middleEllipsize: wide-character paths stay within width",
    visibleWidth(middleEllipsize(emoji, 14)) <= 14 &&
      visibleWidth(middleEllipsize(emoji, 9)) <= 9,
  );
}

// ---- duration --------------------------------------------------------------
check(
  "formatDuration: 0.1s / 8.4s / 14s / 1m04s",
  formatDuration(100) === "0.1s" &&
    formatDuration(8400) === "8.4s" &&
    formatDuration(14000) === "14s" &&
    formatDuration(64000) === "1m04s",
  [100, 8400, 14000, 64000].map(formatDuration).join(","),
);

// ---- tool summaries --------------------------------------------------------
{
  check(
    "summarizeToolArgs: read -> path",
    summarizeToolArgs("read", { path: "a/b.ts" }) === "a/b.ts",
  );
  check(
    "summarizeToolArgs: bash -> command",
    summarizeToolArgs("bash", { command: "pnpm test" }) === "pnpm test",
  );
  check(
    "summarizeToolArgs: grep -> pattern",
    summarizeToolArgs("grep", { pattern: "TODO" }) === "TODO",
  );
  check(
    "summarizeToolArgs: web_search -> query",
    summarizeToolArgs("web_search", { query: "pi tui" }) === "pi tui",
  );
  check(
    "summarizeToolArgs: codemode -> first script line",
    summarizeToolArgs("codemode", "const x = 1;\nreturn x;") === "const x = 1;",
    JSON.stringify(summarizeToolArgs("codemode", "const x = 1;\nreturn x;")),
  );
  check(
    "summarizeToolArgs: fallback -> first 40 JSON chars",
    summarizeToolArgs("mystery", { a: 1 }).length <= 40 &&
      summarizeToolArgs("mystery", { a: 1 }).includes('"a"'),
  );
}

// ---- edit diff -------------------------------------------------------------
{
  const diff = countEditDiff({
    details: {
      diff: [
        "--- a/fetch.ts",
        "+++ b/fetch.ts",
        "@@ -1,2 +1,3 @@",
        "-old",
        "+new",
        "+extra",
        " context",
      ].join("\n"),
    },
  });
  check(
    "countEditDiff: counts + and - lines but not file headers",
    diff.added === 2 && diff.removed === 1,
    JSON.stringify(diff),
  );
  const none = countEditDiff({ content: [] });
  check(
    "countEditDiff: no diff -> zero counts",
    none.added === 0 && none.removed === 0,
    JSON.stringify(none),
  );
}

// ---- render width safety ---------------------------------------------------
for (const width of [10, 40, 60, 200]) {
  const lines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 }, terminalRows: 24 },
    width,
    theme,
  );
  check(
    `renderPanel: every line fits ${width} cols`,
    lines.length > 0 && allLinesFit(lines, width),
    describeOverflow(lines, width),
  );
}
{
  const lines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 } },
    60,
    theme,
  );
  const joined = lines.join("\n");
  check(
    "renderPanel: narrow path retains fetch.ts and duration column",
    joined.includes("fetch.ts") && joined.includes("0.1s"),
    joined,
  );
  const longPathLines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 } },
    50,
    theme,
  );
  const longPathJoined = longPathLines.join("\n");
  check(
    "renderPanel: long read path uses a middle ellipsis and keeps its filename",
    longPathJoined.includes("middleware.ts") &&
      longPathJoined.includes("…") &&
      allLinesFit(longPathLines, 50),
    longPathJoined,
  );
  check(
    "renderPanel: diffstat appears at 60 cols",
    joined.includes("+9") && joined.includes("−2"),
    joined,
  );
}
{
  const lines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 } },
    40,
    theme,
  );
  const joined = lines.join("\n");
  check(
    "renderPanel: 40 cols drops duration and diffstat",
    !joined.includes("0.1s") && !joined.includes("+9"),
    joined,
  );
  check(
    "renderPanel: 40 cols keeps per-tool rows",
    joined.includes("turn 2") && joined.includes("read"),
    joined,
  );
}
{
  const lines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 } },
    30,
    theme,
  );
  const joined = lines.join("\n");
  check(
    "renderPanel: <40 cols collapses the live turn to one header line",
    joined.includes("turn 2 · 3 tools") &&
      !joined.includes("read") &&
      !joined.includes("Thinking"),
    joined,
  );
}

// ---- overflow fold ---------------------------------------------------------
{
  const state = makeState({
    pastTurns: [
      { number: 1, toolCount: 1, durationMs: 1000 },
      { number: 2, toolCount: 1, durationMs: 2000 },
    ],
    currentTurn: {
      number: 3,
      startedAt: NOW - 1000,
      completed: false,
      thinking: null,
      tools: Array.from({ length: 10 }, (_, index) => ({
        id: `tool-${index}`,
        name: "read",
        args: { path: `src/file-${index}.ts` },
        summary: `src/file-${index}.ts`,
        status: "success",
        durationMs: 100,
      })),
    },
    queued: [],
    notices: [],
  });
  const lines = renderPanel(
    state,
    { config: { ...COMPACT_MODE, maxRows: 6 }, terminalRows: 24 },
    80,
    theme,
  );
  const foldRows = lines.filter((line) => /… \d+ earlier/.test(line));
  check(
    "overflow: exactly one fold row",
    foldRows.length === 1,
    lines.join("\n"),
  );
  check(
    "overflow: total lines respect maxRows including prompt",
    lines.length <= 6,
    `lines=${lines.length}`,
  );
  check(
    "overflow: newest tool stays at the bottom",
    lines[lines.length - 1].includes("file-9.ts"),
    lines[lines.length - 1],
  );
  check(
    "overflow: oldest content is folded away",
    !lines.join("\n").includes("turn 1"),
    lines.join("\n"),
  );
}

// ---- expanded mode ---------------------------------------------------------
{
  const args = {};
  for (let index = 0; index < 12; index++) {
    args[`ARG_LINE_${index}`] = "argument value ".repeat(3);
  }
  const resultText = Array.from(
    { length: 12 },
    (_, index) => `RES_LINE_${index} result text`,
  ).join("\n");
  const state = makeState({
    pastTurns: [],
    queued: [],
    notices: [],
    currentTurn: {
      number: 1,
      startedAt: NOW - 1000,
      completed: false,
      thinking: null,
      tools: [
        {
          id: "expanded",
          name: "bash",
          args,
          summary: "long command",
          status: "error",
          durationMs: 100,
          errorText: resultText,
        },
      ],
    },
  });
  const lines = renderPanel(
    state,
    {
      config: { ...COMPACT_MODE, maxRows: 6, display: "expanded" },
      terminalRows: 24,
    },
    40,
    theme,
  );
  const joined = lines.join("\n");
  const argLines = lines.filter((line) => /ARG_LINE_\d+/.test(line)).length;
  const resultLines = lines.filter((line) => /RES_LINE_\d+/.test(line)).length;
  check(
    "expanded: arguments capped at 3 wrapped lines",
    argLines > 0 && argLines <= 3,
    `argLines=${argLines}`,
  );
  check(
    "expanded: result preview capped at 5 wrapped lines",
    resultLines > 0 && resultLines <= 5,
    `resultLines=${resultLines}`,
  );
  check(
    "expanded: ignores the node cap but respects the 48-line ceiling",
    lines.length > 6 && lines.length <= 48,
    `lines=${lines.length}`,
  );
  check(
    "expanded: error text uses the error theme token",
    joined.includes(ansi("error")) && joined.includes("RES_LINE_0"),
    joined,
  );
  check(
    "expanded: every line still fits",
    allLinesFit(lines, 40),
    describeOverflow(lines, 40),
  );
}
{
  const state = makeState({
    pastTurns: [],
    queued: [],
    notices: [],
    currentTurn: {
      number: 1,
      startedAt: NOW - 1000,
      completed: false,
      thinking: null,
      tools: Array.from({ length: 30 }, (_, index) => ({
        id: `tool-${index}`,
        name: "bash",
        args: { command: `echo ${index}` },
        summary: `echo ${index}`,
        status: "success",
        durationMs: 100,
      })),
    },
  });
  const lines = renderPanel(
    state,
    {
      config: { ...COMPACT_MODE, maxRows: 18, display: "expanded" },
      terminalRows: 24,
    },
    80,
    theme,
  );
  check(
    "expanded: hard 48-line ceiling with 30 tools",
    lines.length <= 48 && allLinesFit(lines, 80),
    `lines=${lines.length}`,
  );
}

// ---- ascii mode ------------------------------------------------------------
{
  const state = makeState();
  state.currentTurn.thinking.buffer = "check the retry loop";
  state.currentTurn.tools[0].summary = "src/deep/middleware.ts";
  state.currentTurn.tools[0].args = { path: "src/deep/middleware.ts" };
  state.currentTurn.tools[1].summary = "src/http/fetch.ts";
  state.currentTurn.tools[1].args = { path: "src/http/fetch.ts" };
  const lines = renderPanel(
    state,
    {
      config: { ...COMPACT_MODE, glyphs: "ascii", maxRows: 18 },
      terminalRows: 24,
    },
    80,
    theme,
  );
  const joined = lines.join("\n");
  check(
    "ascii mode: zero non-ASCII bytes",
    /^[\x00-\x7F]*$/.test(joined) && lines.length > 0,
    JSON.stringify(joined),
  );
  check(
    "ascii mode: includes ASCII prompt, branch, check, and compact glyphs",
    joined.includes("> ") &&
      joined.includes("|") &&
      joined.includes("v") &&
      joined.includes("... compacted"),
    joined,
  );
}

// ---- wide characters -------------------------------------------------------
{
  const state = makeState();
  state.prompt = "fix the 🚀🚀🚀 launch path and the 日本語 label";
  state.currentTurn.tools[0].summary = "src/🚀🚀🚀/middleware.ts";
  state.currentTurn.tools[0].args = { path: "src/🚀🚀🚀/middleware.ts" };
  state.queued = ["add 日本語 docs 🚀"];
  for (const width of [10, 20, 40, 60, 200]) {
    const lines = renderPanel(
      state,
      {
        config: { ...COMPACT_MODE, maxRows: 18, display: "expanded" },
        terminalRows: 24,
      },
      width,
      theme,
    );
    check(
      `wide characters: every line fits ${width} cols`,
      lines.length > 0 && allLinesFit(lines, width),
      describeOverflow(lines, width),
    );
  }
}

// ---- renderPanel needs no TUI ---------------------------------------------
{
  const lines = renderPanel(
    makeState(),
    { config: { ...COMPACT_MODE, maxRows: 18 }, terminalRows: 24 },
    80,
    theme,
  );
  check(
    "renderPanel: pure call works with no TUI instance",
    Array.isArray(lines) && lines.every((line) => typeof line === "string"),
  );
  check(
    "renderPanel: input state is not mutated",
    JSON.stringify(makeState()) ===
      JSON.stringify(
        (() => {
          const state = makeState();
          renderPanel(
            state,
            { config: { ...COMPACT_MODE, maxRows: 18 } },
            80,
            theme,
          );
          return state;
        })(),
      ),
  );
}

// ---- non-TUI handlers do nothing ------------------------------------------
{
  const handlers = new Map();
  let command;
  mod.default({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      if (name === "panel") command = options;
    },
  });
  const forbidden = () => {
    throw new Error("UI/config work ran in non-TUI mode");
  };
  const ctx = {
    mode: "rpc",
    ui: new Proxy(
      {},
      {
        get() {
          return forbidden;
        },
      },
    ),
  };
  let threw = false;
  try {
    for (const [name, handler] of handlers) {
      await handler(
        {
          type: name,
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "thinking_delta", delta: "x" },
          source: "interactive",
          text: "hello",
          messageType: "user",
          prompt: "hello",
          toolCallId: "t",
          toolName: "bash",
          args: {},
        },
        ctx,
      );
    }
    await command.handler("on", ctx);
  } catch (error) {
    threw = true;
  }
  check(
    "non-TUI: every event handler and /panel returns without UI or config work",
    !threw && handlers.size === 18 && typeof command?.handler === "function",
    `handlers=${handlers.size} threw=${threw}`,
  );
}

// ---- TUI lifecycle smoke test ---------------------------------------------
{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  // This block exercises the tree itself, so pin the pre-collapse idle mode.
  writeFileSync(
    join(tempAgent, "prompt-panel.json"),
    JSON.stringify({ idleMode: "full" }),
  );
  try {
    const handlers = new Map();
    let command;
    let widget;
    let toolsExpanded = false;
    const notifications = [];
    const tui = {
      terminal: { rows: 24 },
      requestRender() {},
    };
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand(name, options) {
        if (name === "panel") command = options;
      },
    });
    const ui = {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setWidget(_key, content) {
        if (content === undefined) {
          widget = undefined;
        } else if (typeof content === "function") {
          widget = content(tui, theme);
        } else {
          widget = content;
        }
      },
      getToolsExpanded() {
        return toolsExpanded;
      },
    };
    const ctx = { mode: "tui", ui };
    const call = async (name, event = {}) => {
      const handler = handlers.get(name);
      if (handler) await handler(event, ctx);
    };

    await call("session_start", { reason: "startup" });
    await call("input", {
      source: "interactive",
      text: "fix src/http/fetch.ts",
    });
    check(
      "lifecycle: prompt input mounts the widget",
      !!widget && typeof widget.render === "function",
    );
    await call("agent_start", {});
    await call("turn_start", { turnIndex: 0 });
    await call("message_start", {
      message: { role: "assistant", content: [] },
    });
    await call("message_update", {
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "where the retry loop should go",
        partial: {
          content: [
            { type: "thinking", thinking: "where the retry loop should go" },
          ],
        },
      },
    });
    await call("tool_execution_start", {
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src/http/fetch.ts" },
    });
    await call("tool_execution_end", {
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src/http/fetch.ts" },
      isError: false,
      durationMs: 100,
      result: {
        details: { diff: "@@ -1 +1,2 @@\n-old\n+new\n+extra\n" },
      },
    });
    const running = widget.render(80).join("\\n");
    check(
      "lifecycle: a live turn shows the thinking row alongside its tools",
      running.includes("Thinking") &&
        running.includes("retry loop") &&
        running.includes("fetch.ts") &&
        running.includes("+2") &&
        running.includes("−1"),
      running,
    );

    await call("turn_end", {});

    const completedTurn = widget.render(80).join("\n");
    check(
      "lifecycle: a completed turn drops the stale thinking row",
      !completedTurn.includes("Thinking") &&
        !completedTurn.includes("retry loop") &&
        completedTurn.includes("fetch.ts"),
      completedTurn,
    );

    await call("agent_settled", { aborted: false });

    const rendered = widget.render(80).join("\n");
    check(
      "lifecycle: a settled turn drops the stale thinking row",
      rendered.includes("fix src/http/fetch.ts") &&
        rendered.includes("turn 1") &&
        !rendered.includes("Thinking") &&
        !rendered.includes("retry loop") &&
        rendered.includes("fetch.ts") &&
        rendered.includes("+2") &&
        rendered.includes("−1"),
      rendered,
    );
    check(
      "lifecycle: rendered lines fit the requested width",
      widget.render(80).every((line) => visibleWidth(line) <= 80),
    );

    // Idle collapse: a settled panel shrinks to one row (or nothing) and
    // expands again on its own as soon as the next run starts.
    await command.handler("idle glyph", ctx);
    const collapsed = widget.render(80);
    check(
      "lifecycle: idle=glyph collapses a settled run to one summary row",
      collapsed.length === 1 &&
        /1 turn · 1 tool/.test(collapsed[0]) &&
        !collapsed[0].includes("fetch.ts"),
      JSON.stringify(collapsed),
    );
    toolsExpanded = true;
    check(
      "lifecycle: ctrl+o no longer overrides the mode's idle glyph",
      widget.render(80).length === 1,
      JSON.stringify(widget.render(80)),
    );
    toolsExpanded = false;
    await command.handler("display expanded", ctx);
    check(
      "lifecycle: /panel display expanded reveals the finished tree while idle",
      widget.render(80).length > 1,
      JSON.stringify(widget.render(80)),
    );
    await command.handler("display compact", ctx);
    await call("input", { source: "interactive", text: "third prompt" });
    check(
      "lifecycle: a new prompt expands the collapsed panel without a keypress",
      widget.render(80).length > 1 && widget.render(80).join("\n").includes("third prompt"),
      JSON.stringify(widget.render(80)),
    );
    await call("agent_start", {});
    await call("agent_settled", { aborted: false });
    await command.handler("idle hidden", ctx);
    check(
      "lifecycle: idle=hidden renders no rows while idle",
      widget.render(80).length === 0,
      JSON.stringify(widget.render(80)),
    );
    await call("agent_start", {});
    check(
      "lifecycle: a running agent expands a hidden panel again",
      widget.render(80).length > 1,
      JSON.stringify(widget.render(80)),
    );
    await call("agent_settled", { aborted: false });
    await command.handler("idle full", ctx);
    check(
      "lifecycle: idle=full keeps the finished tree",
      widget.render(80).length > 1,
      JSON.stringify(widget.render(80)),
    );

    // A second prompt must continue the turn numbering. Past-turn rows survive
    // the new prompt, so restarting the counter renders "turn 3, turn 4, turn 1".
    await call("agent_settled", { aborted: false });
    const firstRunRows = widget.render(80).map((line) =>
      line.replace(/\x1b\[[0-9;]*m/g, ""),
    );
    const firstRunNumbers = firstRunRows
      .map((line) => /turn (\d+)/.exec(line)?.[1])
      .filter((value) => value !== undefined)
      .map(Number);
    await call("input", { source: "interactive", text: "second prompt" });
    await call("turn_start", { turnIndex: 0 });
    const rows = widget.render(80).map((line) =>
      line.replace(/\x1b\[[0-9;]*m/g, ""),
    );
    const numbers = rows
      .map((line) => /turn (\d+)/.exec(line)?.[1])
      .filter((value) => value !== undefined)
      .map(Number);
    check(
      "lifecycle: turn numbering continues across prompts",
      numbers.length > 0 &&
        numbers.every(
          (value, index) => index === 0 || value >= numbers[index - 1],
        ) &&
        // The live turn is the newest row and must exceed every number the first
        // run produced; the reset bug made it repeat the same number instead.
        (firstRunNumbers.length === 0 ||
          numbers[numbers.length - 1] >
            Math.max(...firstRunNumbers)),
      `first=${JSON.stringify(firstRunNumbers)} second=${JSON.stringify(numbers)}`,
    );

    await command.handler("status", ctx);
    const status = notifications[notifications.length - 1];
    check(
      "lifecycle: /panel reports enabled state, row budget, and config path",
      status.type === "info" &&
        status.message.includes("enabled=on") &&
        status.message.includes("rows=") &&
        status.message.includes("idle=full") &&
        status.message.includes(join(tempAgent, "prompt-panel.json")),
      JSON.stringify(status),
    );

    await command.handler("off", ctx);
    check("lifecycle: /panel off removes the widget", widget === undefined);
    const saved = JSON.parse(
      readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"),
    );
    check(
      "lifecycle: /panel off persists enabled=false",
      saved.enabled === false,
      JSON.stringify(saved),
    );

    await command.handler("display minimal", ctx);
    check(
      "lifecycle: /panel display persists the mode",
      JSON.parse(readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"))
        .display === "minimal",
    );
    const beforeInvalid = notifications.length;
    await command.handler("display sometimes", ctx);
    check(
      "lifecycle: /panel display rejects an unknown mode without writing",
      notifications.length > beforeInvalid &&
        notifications[notifications.length - 1].type === "warning" &&
        JSON.parse(readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"))
          .display === "minimal",
    );

    await command.handler("on", ctx);
    check(
      "lifecycle: /panel on remounts after a prompt was seen",
      !!widget && typeof widget.render === "function",
    );
    await call("session_shutdown", { reason: "quit" });
    check("lifecycle: session_shutdown removes the widget", widget === undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

// --- Review regression cases -------------------------------------------------
// These assert rendered CONTENT, not just width safety. The final per-line clip
// makes every row "fit" even when its layout math is wrong, so a width-only
// assertion cannot catch a swallowed suffix or a silent mid-word chop.

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const cfg = (overrides = {}) => ({ ...COMPACT_MODE, ...overrides });
const render = (state, config, width) =>
  renderPanel(state, { config, terminalRows: 24 }, width, theme);

// --- Run totals --------------------------------------------------------------
// The collapsed row sums every turn of a run, not just the retained past turns.

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-run-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const realNow = Date.now;
  let clock = 1_000_000;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  Date.now = () => clock;
  try {
    // minimal, so a 3-turn run outruns what the panel still shows.
    writeFileSync(
      join(tempAgent, "prompt-panel.json"),
      JSON.stringify({ display: "minimal", idleMode: "glyph" }),
    );
    const handlers = new Map();
    let command;
    let widget;
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand(name, options) {
        if (name === "panel") command = options;
      },
    });
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const ctx = {
      mode: "tui",
      ui: {
        notify() {},
        setWidget(_key, content) {
          widget =
            typeof content === "function" ? content(tui, theme) : content;
        },
        getToolsExpanded() {
          return false;
        },
      },
    };
    const call = (name, event = {}) => handlers.get(name)?.(event, ctx);
    const rows = () => widget.render(80).map(plain);
    const glyph = () => rows()[0] ?? "";
    const runTool = async (id, name, args = {}, result = "ok") => {
      await call("tool_execution_start", {
        toolCallId: id,
        toolName: name,
        args,
      });
      await call("tool_execution_end", {
        toolCallId: id,
        toolName: name,
        result,
        isError: false,
      });
    };

    await call("session_start", { reason: "startup" });
    await call("input", { source: "interactive", text: "three turns" });
    await call("agent_start", {});

    await call("turn_start", {});
    await runTool("a", "read", { path: "a.ts" });
    clock += 2000;
    await call("turn_end", {});

    await call("turn_start", {});
    await runTool("b", "bash", { command: "one" });
    clock += 3000;
    await runTool("c", "bash", { command: "two" });
    await call("turn_end", {});

    await call("turn_start", {});
    clock += 1000;
    await call("turn_end", {});

    await call("agent_settled", { aborted: false });
    check(
      "run totals: sums turns, tools, and elapsed time beyond what the mode shows",
      glyph().trim() === "✓ 3 turns · 3 tools · 6.0s",
      glyph(),
    );
    await command.handler("idle full", ctx);
    check(
      "run totals: minimal keeps the tree to the live turn",
      rows().filter((line) => /turn \d+/.test(line)).length === 1,
      JSON.stringify(rows()),
    );
    await command.handler("display expanded", ctx);
    check(
      "run totals: expanded reveals every turn of the run, not just the mode's depth",
      rows().filter((line) => /turn \d+/.test(line)).length === 3,
      JSON.stringify(rows()),
    );
    await command.handler("display compact", ctx);
    await command.handler("idle glyph", ctx);

    await call("input", { source: "interactive", text: "second run" });
    await call("agent_start", {});
    await call("turn_start", {});
    clock += 2500;
    await call("turn_end", {});
    await call("agent_settled", { aborted: false });
    check(
      "run totals: a new prompt starts a fresh total",
      glyph().trim() === "✓ 1 turn · 2.5s",
      glyph(),
    );

    // A retry re-enters agent_start before settling; totals keep accumulating.
    await call("input", { source: "interactive", text: "retried run" });
    await call("agent_start", {});
    await call("turn_start", {});
    await runTool("d", "read", { path: "d.ts" });
    clock += 1000;
    await call("turn_end", {});
    await call("agent_end", {});
    await call("agent_start", {});
    await call("turn_start", {});
    await runTool("e", "read", { path: "e.ts" });
    clock += 1500;
    await call("turn_end", {});
    await call("agent_settled", { aborted: false });
    check(
      "run totals: a retry keeps accumulating instead of resetting",
      glyph().trim() === "✓ 2 turns · 2 tools · 2.5s",
      glyph(),
    );

    // Abort mid-turn: no turn_end, but the unfinished turn still counts.
    await call("input", { source: "interactive", text: "aborted run" });
    await call("agent_start", {});
    await call("turn_start", {});
    await call("tool_execution_start", {
      toolCallId: "f",
      toolName: "bash",
      args: { command: "sleep 60" },
    });
    clock += 1200;
    await call("agent_settled", { aborted: true });
    check(
      "run totals: an aborted run stays expanded and marks its live turn",
      rows().length > 1 &&
        rows().some((line) => /✗ turn 7/.test(line)) &&
        rows().some((line) => line.includes("sleep 60")),
      JSON.stringify(rows()),
    );

    await call("session_shutdown", { reason: "quit" });
  } finally {
    Date.now = realNow;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

for (const glyphs of ["unicode", "ascii"]) {
  const ellipsis = glyphs === "ascii" ? "..." : "\u2026";
  for (const width of [20, 24, 30, 40, 60]) {
    const lines = render(makeState(), cfg({ glyphs }), width);
    const queuedRows = lines.filter((line) => plain(line).includes("queued"));
    check(
      `queued row keeps its suffix at ${width} cols (${glyphs})`,
      queuedRows.length === 1,
      `found ${queuedRows.length}`,
    );
    const text = queuedRows.length === 1 ? plain(queuedRows[0]) : "";
    check(
      `queued row ends with the word queued at ${width} cols (${glyphs})`,
      /queued\s*$/.test(text),
      JSON.stringify(text),
    );
    check(
      `queued row does not double its ellipsis at ${width} cols (${glyphs})`,
      !text.includes(`${ellipsis}${ellipsis}`),
      JSON.stringify(text),
    );
  }
}

{
  const base = makeState();
  const longBash = {
    id: "t1",
    name: "bash",
    args: { command: "pnpm test" },
    summary: "run the entire test suite across every workspace ".repeat(8),
    status: "success",
    durationMs: 2500,
    startedAt: NOW - 900,
  };
  const state = makeState({
    currentTurn: { ...base.currentTurn, tools: [longBash] },
    queued: [],
    notices: [],
  });
  for (const width of [45, 55]) {
    const lines = render(state, cfg(), width);
    const row = plain(lines.find((line) => line.includes("bash")) ?? "");
    check(
      `bash row ellipsizes instead of hard-cutting at ${width} cols`,
      row.endsWith("\u2026"),
      JSON.stringify(row),
    );
    check(
      `bash row still fits at ${width} cols`,
      allLinesFit(lines, width),
    );
  }
}

{
  const durations = [0, 999, 8400, 14000, 59999, 3_599_000, 3_600_000, 999_999_000];
  const tooWide = durations.filter((ms) => formatDuration(ms).length > 6);
  check(
    "duration never exceeds the fixed 6-column column",
    tooWide.length === 0,
    tooWide.map((ms) => `${ms}->${formatDuration(ms)}`).join(", "),
  );
}

{
  const mid = middleEllipsize("src/very/long/directory/middleware.ts", 24);
  check(
    "middle ellipsis keeps the basename and is not a tail ellipsis",
    mid.includes("\u2026") && mid.endsWith("middleware.ts"),
    JSON.stringify(mid),
  );
  check("middle ellipsis respects its budget", visibleWidth(mid) <= 24);
}

{
  const state = makeState({
    pastTurns: [
      { number: 7, toolCount: 0, durationMs: 900 },
      { number: 8, toolCount: 3, durationMs: 8400 },
    ],
    currentTurn: { ...makeState().currentTurn, number: 9 },
  });
  const lines = render(state, cfg({ display: "compact", maxRows: 18 }), 80).map(plain);
  const zeroToolRow = lines.find((line) => line.includes("turn 7")) ?? "";
  check(
    "past turns without tool calls keep their row but omit the count",
    zeroToolRow !== "" && !zeroToolRow.includes("tool"),
    JSON.stringify(lines),
  );
  check(
    "past turns with tool calls still get their row",
    lines.some((line) => line.includes("turn 8")),
    JSON.stringify(lines),
  );
  const numbers = lines
    .map((line) => /turn (\d+)/.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .map(Number);
  check(
    "past turn numbering has no gaps",
    numbers.length === 3 &&
      numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1),
    JSON.stringify(numbers),
  );
}

{
  const summary = summarizeToolArgs("bash", { command: "cd /Users/someone/project && pnpm test" });
  check(
    "bash summaries drop a leading cd prefix",
    summary === "pnpm test",
    JSON.stringify(summary),
  );
  const onlyCd = summarizeToolArgs("bash", { command: "cd /tmp" });
  check(
    "a lone cd command is left intact",
    onlyCd === "cd /tmp",
    JSON.stringify(onlyCd),
  );
}

// --- Expansion mode ----------------------------------------------------------

{
  const base = makeState();
  const render = (config) =>
    renderPanel(base, { config, terminalRows: 40 }, 100, theme).map(plain);
  const showsArgs = (config) =>
    render({ ...DEFAULT_CONFIG, ...config, maxRows: 18 }).some((line) =>
      line.includes('"path"'),
    );

  check(
    "display=expanded shows tool arguments",
    showsArgs({ display: "expanded" }),
  );
  check(
    "the shipped default is compact, with one line per tool",
    DEFAULT_CONFIG.display === "compact" &&
      !("expand" in DEFAULT_CONFIG) &&
      !showsArgs({}),
    String(DEFAULT_CONFIG.display),
  );
  check(
    "display=minimal also keeps tools on one line",
    !showsArgs({ display: "minimal" }),
  );
}

{
  const manyTools = [];
  for (let index = 0; index < 30; index++) {
    manyTools.push({
      id: `t${index}`,
      name: "bash",
      args: { command: `echo ${index}` },
      summary: `echo ${index}`,
      status: "success",
      durationMs: 100,
      startedAt: NOW,
    });
  }
  const base = makeState();
  const state = makeState({
    currentTurn: { ...base.currentTurn, tools: manyTools },
    queued: [],
    notices: [],
  });
  const countAt = (terminalRows) =>
    renderPanel(
      state,
      { config: { ...DEFAULT_CONFIG, display: "expanded" }, terminalRows },
      100,
      theme,
    ).length;
  const small = countAt(24);
  const large = countAt(100);
  check(
    "expanded output is capped at 60% of the terminal",
    small <= 15,
    `lines=${small}`,
  );
  check(
    "expanded output still fits the 48-line ceiling on a tall terminal",
    large <= 48 && large > small,
    `small=${small} large=${large}`,
  );
}

// --- Pulse and thinking pacing ------------------------------------------------

{
  const glyphAt = (tick) => {
    const lines = renderPanel(
      makeState({ tick, queued: [], notices: [] }),
      { config: { ...DEFAULT_CONFIG, display: "compact" }, terminalRows: 40 },
      100,
      theme,
    ).map(plain);
    const turnRows = lines.filter((line) => /turn \d+/.test(line));
    // The live turn is the last row; the earlier matches are compressed past turns.
    return /^\s{2}(\S) turn/.exec(turnRows[turnRows.length - 1] ?? "")?.[1];
  };
  const marks = [0, 1, 2, 3].map(glyphAt);
  check(
    "the running glyph holds still for the whole pulse window",
    marks[0] === marks[1] && marks[1] === marks[2],
    JSON.stringify(marks),
  );
  check(
    "the running glyph still alternates after the pulse window",
    marks[3] !== marks[0],
    JSON.stringify(marks),
  );
}

{
  const base = makeState();
  const thinkingRow = (thinking, config = {}) => {
    const state = makeState({
      currentTurn: { ...base.currentTurn, tools: [], thinking },
      queued: [],
      notices: [],
    });
    const lines = renderPanel(
      state,
      { config: { ...DEFAULT_CONFIG, display: "compact", ...config }, terminalRows: 40 },
      100,
      theme,
    ).map(plain);
    return lines.find((line) => line.includes("Thinking")) ?? "";
  };

  const sentence = thinkingRow({
    buffer:
      "First I read the file. Now the current sentence is still being written out",
    done: false,
  });
  check(
    "thinking shows the sentence in progress without a leading ellipsis",
    sentence.includes("Now the current sentence") &&
      !sentence.includes("… Now"),
    JSON.stringify(sentence),
  );

  const tokens = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp".split(" ");
  const snapped = thinkingRow({
    buffer: tokens.join(" "),
    done: false,
  }, { thinkingPreviewChars: 15 });
  const preview = snapped.split("Thinking · ")[1] ?? "";
  const previewTokens = preview
    .replace(/^…/, "")
    .split(" ")
    .filter(Boolean);
  check(
    "a truncated thinking preview never starts mid-word",
    preview.startsWith("…") &&
      previewTokens.length > 0 &&
      previewTokens.every((token) => tokens.includes(token)),
    JSON.stringify(preview),
  );

  const throttled = thinkingRow({
    buffer: "a much newer buffer that has not been snapshotted yet",
    preview: "the older snapshot sentence",
    previewAt: 1,
    done: false,
  });
  check(
    "thinking renders the throttled snapshot, not the live buffer",
    throttled.includes("older snapshot") && !throttled.includes("much newer"),
    JSON.stringify(throttled),
  );
}

{
  const base = makeState();
  const state = makeState({
    currentTurn: {
      ...base.currentTurn,
      tools: [
        {
          id: "deep",
          name: "edit",
          args: {
            path: "a.ts",
            oldText: "old line\n".repeat(20),
            newText: "new line\n".repeat(20),
          },
          summary: "a.ts",
          status: "success",
          durationMs: 300,
          startedAt: NOW,
          resultText: "ok written",
        },
        {
          id: "running",
          name: "bash",
          args: { command: "sleep 5" },
          summary: "sleep 5",
          status: "running",
          startedAt: NOW,
          partialText: "",
        },
      ],
    },
    queued: [],
    notices: [],
  });
  const lines = renderPanel(
    state,
    { config: { ...COMPACT_MODE, display: "expanded" }, terminalRows: 60 },
    100,
    theme,
  ).map(plain);
  const detail = lines.filter((line) => line.includes("│"));
  check(
    "a capped argument preview ends with an ellipsis instead of looking complete",
    detail.some((line) => line.trimEnd().endsWith("…")),
    JSON.stringify(detail),
  );
  check(
    "a running tool with an empty partial result renders no result line",
    !lines.some((line) => line.includes('"content":[]')),
    JSON.stringify(lines),
  );
}

// --- Turn history ------------------------------------------------------------
// Completed turns stay retained as one-line records; expanding the panel is
// what decides how many of them are visible.

{
  const base = makeState();
  const sixTurns = Array.from({ length: 6 }, (_, index) => ({
    number: index + 1,
    toolCount: index % 3,
    durationMs: 1000 * (index + 1),
  }));
  const state = makeState({
    pastTurns: sixTurns,
    currentTurn: { ...base.currentTurn, number: 7, tools: [], thinking: null },
    queued: [],
    notices: [],
  });
  const view = (config, terminalRows = 100) =>
    renderPanel(state, { config, terminalRows }, 100, theme).map(plain);
  const turnRows = (rows) =>
    rows.filter((line) => /^\s+[✓✗●○] turn \d+/.test(line));

  const compact = turnRows(view(cfg({ display: "compact" })));
  check(
    "compact: shows the live turn plus the previous two",
    compact.length === 3 &&
      compact.some((line) => line.includes("turn 6")) &&
      !compact.some((line) => line.includes("turn 4")),
    JSON.stringify(compact),
  );
  const expandedTurns = turnRows(view(cfg({ display: "expanded" })));
  check(
    "expanded: reveals every retained turn plus the live one",
    expandedTurns.length === 7 &&
      expandedTurns.some((line) => line.includes("turn 1")),
    JSON.stringify(expandedTurns),
  );
  const minimalTurns = turnRows(view(cfg({ display: "minimal" })));
  check(
    "minimal: keeps only the live turn",
    minimalTurns.length === 1 &&
      minimalTurns.some((line) => line.includes("turn 7")),
    JSON.stringify(minimalTurns),
  );

  // Scrolling is a viewport, never a mode: the same state at different offsets
  // renders the same number of rows, and never reveals turns the mode drops.
  const scrolledView = (scroll) =>
    renderPanel(
      { ...state, scroll },
      { config: cfg({ display: "compact", maxRows: 4 }), terminalRows: 24 },
      100,
      theme,
    ).map(plain);
  check(
    "scroll: moving the window never changes the panel's row count",
    [0, 1, 2, 9].every((scroll) => scrolledView(scroll).length === 4),
    JSON.stringify({ top: scrolledView(9), tail: scrolledView(0) }),
  );
  check(
    "scroll: moving the window swaps rows but reveals no dropped turn",
    scrolledView(0).some((line) => line.includes("turn 7")) &&
      scrolledView(9).some((line) => line.includes("refactor the auth")) &&
      [0, 1, 2, 9].every(
        (scroll) => !scrolledView(scroll).some((line) => line.includes("turn 1")),
      ),
    JSON.stringify({ top: scrolledView(9), tail: scrolledView(0) }),
  );
  check(
    "scroll: an idle totals row is a click target, not a scroll target",
    (() => {
      const idleState = {
        ...state,
        phase: "idle",
        currentTurn: { ...state.currentTurn, completed: true },
      };
      let glyphLayout;
      const glyph = renderPanel(
        idleState,
        {
          config: cfg({ idleMode: "glyph" }),
          terminalRows: 100,
          onLayout: (layout) => {
            glyphLayout = layout;
          },
        },
        100,
        theme,
      ).map(plain);
      let openLayout;
      const open = renderPanel(
        { ...idleState, summaryOpen: true },
        {
          config: cfg({ idleMode: "glyph" }),
          terminalRows: 100,
          onLayout: (layout) => {
            openLayout = layout;
          },
        },
        100,
        theme,
      ).map(plain);
      return (
        glyph.length === 1 &&
        glyphLayout.summaryStart === 0 &&
        glyphLayout.summaryEnd === 1 &&
        open.length > 1 &&
        open[open.length - 1].includes("turns") &&
        openLayout.summaryStart === open.length - 1 &&
        openLayout.summaryEnd === open.length
      );
    })(),
  );

  const many = makeState({
    pastTurns: Array.from({ length: 20 }, (_, index) => ({
      number: index + 1,
      toolCount: 1,
      durationMs: 1000,
    })),
    currentTurn: { ...base.currentTurn, number: 21, tools: [], thinking: null },
    queued: [],
    notices: [],
  });
  const folded = renderPanel(
    many,
    {
      config: cfg({ display: "expanded" }),
      terminalRows: 24,
    },
    100,
    theme,
  ).map(plain);
  check(
    "expanded: overflow folds the oldest turns and keeps the live turn last",
    folded.some((line) => /… \d+ earlier/.test(line)) &&
      folded.length <= 14 &&
      /turn 21/.test(folded[folded.length - 1] ?? ""),
    JSON.stringify(folded),
  );
}

// --- Prompt truncation --------------------------------------------------------
// The collapsed prompt is one row, cut at a word boundary so the last visible
// token is never chopped in half.

{
  const base = makeState({
    currentTurn: null,
    pastTurns: [],
    queued: [],
    notices: [],
  });
  // Row 0 is the rule above the prompt block.
  const row = (prompt, width = 60, overrides = {}) =>
    plain(
      render({ ...base, prompt }, cfg({ display: "minimal", ...overrides }), width)[1] ??
        "",
    );
  const bodyOf = (line) => line.replace(/^[>❯] /, "").replace(/(…|\.\.\.)$/, "");
  const endsAtWordBoundary = (prompt, line) => {
    const next = prompt.charAt(bodyOf(line).length);
    return next === "" || /\s/.test(next);
  };
  const longPrompt =
    "refactor the authentication middleware to use the new token store";

  check(
    "prompt: a prompt that fits is untouched",
    row("refactor auth") === "❯ refactor auth",
  );
  check(
    "prompt: truncation lands on a word boundary, not mid-word",
    (() => {
      const line = row(longPrompt, 40);
      return (
        line.endsWith("…") &&
        endsAtWordBoundary(longPrompt, line) &&
        !/\s…$/.test(line) &&
        visibleWidth(line) <= 40
      );
    })(),
    JSON.stringify(row(longPrompt, 40)),
  );
  check(
    "prompt: a word ending exactly at the clip is kept",
    row("alpha beta gamma", 13) === "❯ alpha beta…",
    JSON.stringify(row("alpha beta gamma", 13)),
  );
  check(
    "prompt: a chopped word is dropped whole",
    row("alpha beta gamma", 12) === "❯ alpha…",
    JSON.stringify(row("alpha beta gamma", 12)),
  );
  check(
    "prompt: a single token with no boundary still gets a hard cut",
    (() => {
      const line = row("x".repeat(80), 20);
      return line.endsWith("…") && visibleWidth(line) <= 20;
    })(),
    JSON.stringify(row("x".repeat(80), 20)),
  );
  check(
    "prompt: word boundaries hold at every width and in ascii mode",
    [40, 48, 60].every((width) => {
      const ansiLine = row(longPrompt, width);
      const asciiLine = row(longPrompt, width, { glyphs: "ascii" });
      return (
        endsAtWordBoundary(longPrompt, ansiLine) &&
        endsAtWordBoundary(longPrompt, asciiLine) &&
        visibleWidth(ansiLine) <= width &&
        visibleWidth(asciiLine) <= width
      );
    }),
    JSON.stringify([40, 48, 60].map((width) => row(longPrompt, width))),
  );
}

// --- Prompt styling ----------------------------------------------------------
// The prompt is italic with a border rule above it, so it reads as the pinned
// ask rather than as another block of model output.

{
  const base = makeState({
    prompt: "refactor the auth middleware",
    currentTurn: null,
    pastTurns: [],
    queued: [],
    notices: [],
    promptExpanded: false,
  });
  const view = (state, config, width = 60, activeTheme = theme) =>
    renderPanel(state, { config, terminalRows: 24 }, width, activeTheme);
  const italicTheme = {
    fg: theme.fg,
    italic: (text) => `\x1b[3m${text}\x1b[0m`,
  };
  const minimal = cfg({ display: "minimal" });

  const styled = view(base, minimal, 60, italicTheme);
  check(
    "style: the prompt body is italic when the theme supports it",
    styled[1].includes("\x1b[3m") && plain(styled[1]).startsWith("❯ refactor"),
    JSON.stringify(styled.map(plain)),
  );
  check(
    "style: a theme without italics still renders the prompt",
    !view(base, minimal)[1].includes("\x1b[3m") &&
      plain(view(base, minimal)[1]).startsWith("❯ refactor"),
  );
  check(
    "style: an expanded prompt is italic on every wrapped line",
    view({ ...base, promptExpanded: true }, minimal, 60, italicTheme)
      .slice(1)
      .every((line) => line === "" || line.includes("\x1b[3m")),
  );
  check(
    "style: a border rule sits above the prompt and spans the width",
    (() => {
      const lines = view(base, minimal);
      const rule = plain(lines[0]);
      return (
        /^─+$/.test(rule) &&
        visibleWidth(rule) === 60 &&
        lines[0].includes(ansi("border")) &&
        plain(lines[1]).startsWith("❯ ")
      );
    })(),
    JSON.stringify(view(base, minimal).map(plain)),
  );
  check(
    "style: the rule follows ascii glyph mode",
    /^-+$/.test(plain(view(base, cfg({ display: "minimal", glyphs: "ascii" }))[0])),
  );
  check(
    "style: no rule when there is no prompt to separate",
    view({ ...base, prompt: "" }, minimal).length === 0 &&
      view(base, cfg({ display: "minimal", showPrompt: false })).length === 0,
  );
  check(
    "style: the idle totals row has no rule",
    view(
      {
        ...base,
        phase: "idle",
        currentTurn: null,
        run: { turns: 2, tools: 3, durationMs: 4000 },
      },
      minimal,
    ).length === 1,
  );
}

// --- Prompt expansion ---------------------------------------------------------
// Clicking the prompt block expands the full text in place; the renderer is
// pure, so `promptExpanded` is plain state.

{
  const longPrompt =
    "refactor the auth middleware to use the new token store, keep the old " +
    "session cookie path working for one release, and add a migration note " +
    "to the changelog";
  const base = makeState({
    prompt: longPrompt,
    currentTurn: null,
    pastTurns: [],
    queued: [],
    notices: [],
  });

  const collapsed = render(base, cfg({ display: "minimal" }), 60).map(plain);
  check(
    "prompt: a rule sits above one ellipsized row",
    collapsed.length === 2 &&
      /^─+$/.test(collapsed[0]) &&
      collapsed[1].startsWith("❯ ") &&
      collapsed[1].endsWith("…"),
    JSON.stringify(collapsed),
  );

  let promptLayout;
  const expandedLines = renderPanel(
    { ...base, promptExpanded: true },
    {
      config: cfg({ display: "minimal" }),
      terminalRows: 40,
      onLayout: (layout) => {
        promptLayout = layout;
      },
    },
    60,
    theme,
  );
  const expanded = expandedLines.map(plain);
  check(
    "prompt: expanded wraps the full text in place",
    expanded.length > 2 &&
      /^─+$/.test(expanded[0]) &&
      expanded[1].startsWith("❯ ") &&
      expanded.slice(2).every((line) => line === "" || line.startsWith("  ")) &&
      expanded.join(" ").replace(/\s+/g, " ").includes("add a migration note"),
    JSON.stringify(expanded),
  );
  check(
    "prompt: expanded rows stay inside the width",
    expandedLines.every((line) => visibleWidth(line) <= 60),
  );
  check(
    "prompt: onLayout reports the prompt rows as the click target, not the rule",
    promptLayout.promptStart === 1 &&
      promptLayout.promptEnd === expanded.length &&
      promptLayout.maxScrollOffset === 0,
    JSON.stringify(promptLayout),
  );

  const multiParagraph = renderPanel(
    { ...base, prompt: "first ask\n\nsecond paragraph with detail", promptExpanded: true },
    { config: cfg({ display: "minimal" }), terminalRows: 40 },
    60,
    theme,
  ).map(plain);
  check(
    "prompt: expanded keeps paragraph breaks",
    multiParagraph.some((line) => line.trim() === "") &&
      multiParagraph.some((line) => line.includes("second paragraph")),
    JSON.stringify(multiParagraph),
  );

  // A prompt longer than the panel is not truncated any more: it is windowed,
  // and scrolling reaches the rest.
  const hugeState = {
    ...base,
    prompt: "word ".repeat(200),
    promptExpanded: true,
  };
  const hugeView = (scroll) => {
    let layout;
    const lines = renderPanel(
      { ...hugeState, scroll },
      {
        config: cfg({ display: "minimal", maxRows: 5 }),
        terminalRows: 24,
        onLayout: (next) => {
          layout = next;
        },
      },
      40,
      theme,
    ).map(plain);
    return { lines, layout };
  };

  const tail = hugeView(0);
  check(
    "scroll: a long prompt shows its tail with an earlier marker",
    tail.lines.length === 5 &&
      /^\s*… \d+ earlier$/.test(tail.lines[0]) &&
      tail.layout.scrollOffset === 0 &&
      tail.layout.maxScrollOffset > 0 &&
      tail.layout.promptStart === 1 &&
      tail.layout.promptEnd === 5,
    JSON.stringify(tail),
  );
  const top = hugeView(Number.POSITIVE_INFINITY);
  check(
    "scroll: scrolling to the top starts at the prompt's first line, under its rule",
    /^─+$/.test(top.lines[0]) &&
      top.lines[1].startsWith("❯ word") &&
      /^\s*… \d+ more$/.test(top.lines[4]) &&
      top.layout.scrollOffset === top.layout.maxScrollOffset &&
      top.layout.promptStart === 1 &&
      top.layout.promptEnd === 4,
    JSON.stringify(top),
  );
  const middle = hugeView(2);
  check(
    "scroll: a mid offset keeps markers on both ends",
    /^\s*… \d+ earlier$/.test(middle.lines[0]) &&
      /^\s*… \d+ more$/.test(middle.lines[4]) &&
      middle.layout.scrollOffset === 2,
    JSON.stringify(middle),
  );
  const clamped = hugeView(9999);
  check(
    "scroll: an offset past the end clamps to the top",
    clamped.layout.scrollOffset === clamped.layout.maxScrollOffset &&
      clamped.lines[1].startsWith("❯ word"),
    JSON.stringify(clamped.layout),
  );

  check(
    "prompt: a new prompt renders collapsed by default",
    render(base, cfg({ display: "minimal" }), 60).length === 2,
  );

  let idleLayout;
  renderPanel(
    { ...base, phase: "idle", currentTurn: null, run: null, promptExpanded: true },
    {
      config: cfg({ display: "minimal" }),
      terminalRows: 40,
      onLayout: (layout) => {
        idleLayout = layout;
      },
    },
    60,
    theme,
  );
  check(
    "prompt: a collapsed idle glyph reports no prompt rows to click",
    idleLayout.promptStart === 0 &&
      idleLayout.promptEnd === 0 &&
      idleLayout.maxScrollOffset === 0,
    JSON.stringify(idleLayout),
  );
}

// --- Prompt click -------------------------------------------------------------

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-click-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  try {
    const longPrompt =
      "refactor the auth middleware to use the new token store, keep the old " +
      "session cookie path working for one release, and add a migration note " +
      "to the changelog";
    const handlers = new Map();
    let widget;
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand() {},
    });
    const ui = {
      notify() {},
      setWidget(_key, content) {
        widget =
          typeof content === "function"
            ? content({ terminal: { rows: 30 }, requestRender() {} }, theme)
            : undefined;
      },
      getToolsExpanded() {
        return false;
      },
    };
    const ctx = { mode: "tui", ui };
    const call = (name, event) => handlers.get(name)?.(event, ctx);
    const rows = () => widget.render(60).map(plain);
    const click = (y, button = "left") => {
      widget.handleMouse({ type: "press", button, y });
      return widget.handleMouse({ type: "click", button, y });
    };

    call("session_start", { reason: "startup" });
    call("input", { source: "interactive", text: longPrompt });
    check(
      "click: the rule sits above one truncated prompt row",
      rows().length === 2 &&
        /^─+$/.test(rows()[0]) &&
        rows()[1].endsWith("…"),
      JSON.stringify(rows()),
    );

    check(
      "click: a right-click on the prompt does nothing",
      click(1, "right") === undefined && rows().length === 2,
    );
    check(
      "click: a click on the rule does nothing",
      click(0) === undefined && rows().length === 2,
      JSON.stringify(rows()),
    );
    check(
      "click: a click below the prompt row does nothing",
      click(2) === undefined && rows().length === 2,
    );

    check(
      "click: a click on the prompt expands it in place",
      click(1) !== undefined &&
        rows().length > 2 &&
        rows().join(" ").includes("add a migration note"),
      JSON.stringify(rows()),
    );
    const expandedRows = rows().length;
    check(
      "click: clicking the last prompt row collapses it again",
      click(expandedRows - 1) !== undefined && rows().length === 2,
      JSON.stringify(rows()),
    );

    click(1);
    call("input", { source: "interactive", text: longPrompt });
    check(
      "click: a new prompt starts collapsed",
      rows().length === 2,
      JSON.stringify(rows()),
    );

    check(
      "click: a press in the prompt block is claimed, not a selection",
      JSON.stringify(
        widget.handleMouse({ type: "press", button: "left", y: 1 }),
      ) === JSON.stringify({ handled: true, render: false }),
    );

    call("session_shutdown", { reason: "quit" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

// --- Panel scroll -------------------------------------------------------------

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-scroll-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  writeFileSync(
    join(tempAgent, "prompt-panel.json"),
    JSON.stringify({ maxRows: 3 }),
  );
  try {
    const longPrompt =
      "refactor the auth middleware to use the new token store, keep the old " +
      "session cookie path working for one release, and add a migration note " +
      "to the changelog";
    const handlers = new Map();
    let widget;
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand() {},
    });
    const ui = {
      notify() {},
      setWidget(_key, content) {
        widget =
          typeof content === "function"
            ? content({ terminal: { rows: 30 }, requestRender() {} }, theme)
            : undefined;
      },
      getToolsExpanded() {
        return false;
      },
    };
    const ctx = { mode: "tui", ui };
    const call = (name, event) => handlers.get(name)?.(event, ctx);
    const rows = () => widget.render(60).map(plain);
    const click = (y) => {
      widget.handleMouse({ type: "press", button: "left", y });
      return widget.handleMouse({ type: "click", button: "left", y });
    };
    const wheel = (delta) =>
      widget.handleMouse({ type: "wheel", button: "none", wheelDelta: delta, y: 0 });

    call("session_start", { reason: "startup" });
    call("input", { source: "interactive", text: longPrompt });
    check(
      "scroll: the wheel stays on a panel that fits instead of scrolling the transcript",
      wheel(-1) !== undefined &&
        wheel(1) !== undefined &&
        rows().length === 2 &&
        /^─+$/.test(rows()[0]),
    );

    click(1);
    const top = rows();
    check(
      "scroll: expanding a long prompt opens at its first line, under its rule",
      top.length === 3 &&
        /^─+$/.test(top[0]) &&
        top[1].startsWith("❯ refactor") &&
        /… \d+ more$/.test(top[2]),
      JSON.stringify(top),
    );

    check(
      "scroll: wheel down reveals the newest rows",
      wheel(1) !== undefined && /^\s*… \d+ earlier$/.test(rows()[0]),
      JSON.stringify(rows()),
    );

    check(
      "scroll: at the tail the wheel still reports handled",
      wheel(1) !== undefined && !/… \d+ more$/.test(rows()[2]),
      JSON.stringify(rows()),
    );

    check(
      "scroll: a click on the earlier marker is not a prompt click",
      click(0) === undefined && /^\s*… \d+ earlier$/.test(rows()[0]),
      JSON.stringify(rows()),
    );

    check(
      "scroll: a click on a visible prompt row collapses it",
      click(1) !== undefined && rows().length === 2,
      JSON.stringify(rows()),
    );

    click(1);
    wheel(-1);
    call("input", { source: "interactive", text: longPrompt });
    check(
      "scroll: a new prompt resets the offset",
      rows().length === 2 && wheel(-1) !== undefined,
      JSON.stringify(rows()),
    );

    call("session_shutdown", { reason: "quit" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

// --- Wheel reveals history ----------------------------------------------------
// A panel that fits has nothing to window, but it still hides retained turns
// behind the collapsed depth. The wheel over the panel unfolds them in place
// instead of scrolling the transcript, and folding code back down returns to
// the compact view.

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-wheel-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  writeFileSync(
    join(tempAgent, "prompt-panel.json"),
    JSON.stringify({
      maxRows: 20,
      display: "minimal",
      idleMode: "full",
      animate: false,
    }),
  );
  try {
    const handlers = new Map();
    let widget;
    let command;
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand(name, options) {
        if (name === "panel") command = options;
      },
    });
    const ui = {
      notify() {},
      setWidget(_key, content) {
        widget =
          typeof content === "function"
            ? content({ terminal: { rows: 40 }, requestRender() {} }, theme)
            : undefined;
      },
      getToolsExpanded() {
        return false;
      },
    };
    const ctx = { mode: "tui", ui };
    const call = (name, event = {}) => handlers.get(name)?.(event, ctx);
    const rows = () => widget.render(80).map(plain);
    const wheel = (delta) =>
      widget.handleMouse({
        type: "wheel",
        button: "none",
        wheelDelta: delta,
        y: 0,
      });
    const turnRows = () =>
      rows().filter((line) => /^\s+[✓✗●○] turn \d+/.test(line));
    const turnNumbers = () =>
      turnRows()
        .map((line) => Number(/turn (\d+)/.exec(line)?.[1]))
        .join(",");

    call("session_start", { reason: "startup" });
    call("input", { source: "interactive", text: "three turns" });
    call("agent_start", {});
    for (const number of [1, 2, 3]) {
      call("turn_start", {});
      call("tool_execution_start", {
        toolCallId: `t${number}`,
        toolName: "bash",
        args: { command: `echo ${number}` },
      });
      call("tool_execution_end", {
        toolCallId: `t${number}`,
        toolName: "bash",
        args: { command: `echo ${number}` },
        result: "ok",
      });
      call("turn_end", {});
    }
    call("agent_settled", { aborted: false });

    const click = (y) => {
      widget.handleMouse({ type: "press", button: "left", y });
      return widget.handleMouse({ type: "click", button: "left", y });
    };

    check(
      "scroll: minimal shows only the live turn",
      turnNumbers() === "3",
      turnNumbers(),
    );
    check(
      "scroll: the wheel stays on a panel that fits, in both directions",
      wheel(-1) !== undefined &&
        wheel(1) !== undefined &&
        turnNumbers() === "3",
      JSON.stringify(rows()),
    );

    await command.handler("idle glyph", ctx);
    check(
      "scroll: an idle run collapses to the totals row",
      rows().length === 1 && /turns? ·/.test(rows()[0]),
      JSON.stringify(rows()),
    );
    check(
      "scroll: the wheel over the totals row neither opens it nor moves the transcript",
      wheel(-1) !== undefined && rows().length === 1,
      JSON.stringify(rows()),
    );
    check(
      "click: the totals row opens the tree the mode would render",
      click(0) !== undefined &&
        rows().length > 1 &&
        rows().some((line) => line.includes("turn 3")) &&
        rows().some((line) => line.includes("three turns")),
      JSON.stringify(rows()),
    );
    const openRows = rows().length;
    check(
      "click: the totals footer closes it again",
      /turns? ·/.test(rows()[openRows - 1]) &&
        click(openRows - 1) !== undefined &&
        rows().length === 1 &&
        /turns? ·/.test(rows()[0]),
      JSON.stringify({ openRows, closed: rows() }),
    );

    click(0);
    check(
      "click: an open tree survives a scroll",
      wheel(-1) !== undefined && rows().length > 1,
      JSON.stringify(rows()),
    );

    call("agent_start", {});
    call("turn_start", {});
    call("turn_end", {});
    call("agent_settled", { aborted: false });
    check(
      "click: the next settle folds an opened tree back to the totals row",
      rows().length === 1 && /turns? ·/.test(rows()[0]),
      JSON.stringify(rows()),
    );

    call("input", { source: "interactive", text: "a second ask" });
    check(
      "click: a new prompt starts folded, with no history above the live turn",
      turnNumbers() === "" &&
        rows().length === 2 &&
        rows()[1].includes("a second ask"),
      JSON.stringify(rows()),
    );

    call("session_shutdown", { reason: "quit" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

// --- Idle collapse -----------------------------------------------------------

{
  const base = makeState();
  const finishedState = (overrides = {}) =>
    makeState({
      phase: "idle",
      currentTurn: {
        ...base.currentTurn,
        number: 3,
        completed: true,
        elapsedMs: 8400,
        toolCount: 2,
        thinking: { ...base.currentTurn.thinking, done: true },
      },
      queued: [],
      notices: [],
      ...overrides,
    });

  const full = render(finishedState(), cfg({ idleMode: "full" }), 80).map(plain);
  const glyph = render(finishedState(), cfg(), 80).map(plain);
  check(
    "idleMode defaults to the one-row glyph",
    glyph.length === 1 && glyph[0].includes("turns"),
    JSON.stringify(glyph),
  );
  check(
    "idleMode=full keeps the finished tree",
    full.length > 1 && full.some((line) => line.includes("turn 3")),
    JSON.stringify(full),
  );
  check(
    "idleMode=glyph sums the retained turns when no run record is present",
    glyph.length === 1 && /^\s*✓ 2 turns · 5 tools · 17s$/.test(glyph[0]),
    JSON.stringify(glyph),
  );
  check(
    "idleMode=glyph drops the pinned prompt, thinking row, and tool rows",
    !glyph[0].includes("refactor the auth") &&
      !glyph[0].includes("Thinking") &&
      !glyph[0].includes("fetch.ts") &&
      !glyph[0].includes("pnpm test"),
    JSON.stringify(glyph),
  );
  check(
    "expanding the glyph reveals the full panel instead of the one row",
    renderPanel(
      finishedState(),
      { config: cfg({ display: "expanded" }), terminalRows: 24 },
      80,
      theme,
    ).map(plain).length > 1,
  );
  check(
    "display: expanded also overrides idle collapse",
    render(finishedState(), cfg({ display: "expanded" }), 80).length > 1,
  );
  check(
    "display: compact still collapses to the glyph while idle",
    render(finishedState(), cfg({ display: "compact" }), 80).length === 1 &&
      render(finishedState(), cfg({ display: "minimal" }), 80).length === 1,
  );
  check(
    "idleMode=hidden also expands to the full panel",
    renderPanel(
      finishedState(),
      {
        config: cfg({ display: "expanded", idleMode: "hidden" }),
        terminalRows: 24,
      },
      80,
      theme,
    ).map(plain).length > 1,
  );
  check(
    "idleMode=glyph shows run totals: turns, tools, and summed time",
    plain(
      render(
        finishedState({
          run: { turns: 5, tools: 13, durationMs: 54000 },
          pastTurns: [{ number: 4, toolCount: 2, durationMs: 1000 }],
        }),
        cfg({ idleMode: "glyph" }),
        80,
      )[0] ?? "",
    ).trim() === "✓ 5 turns · 13 tools · 54s",
  );
  check(
    "idleMode=glyph uses singular nouns for a one-turn, one-tool run",
    plain(
      render(
        finishedState({ run: { turns: 1, tools: 1, durationMs: 8400 } }),
        cfg({ idleMode: "glyph" }),
        80,
      )[0] ?? "",
    ).trim() === "✓ 1 turn · 1 tool · 8.4s",
  );
  check(
    "idleMode=glyph omits the tool count when the run called no tools",
    plain(
      render(
        finishedState({ run: { turns: 1, tools: 0, durationMs: 1200 } }),
        cfg({ idleMode: "glyph" }),
        80,
      )[0] ?? "",
    ).trim() === "✓ 1 turn · 1.2s",
  );
  check(
    "idleMode=glyph keeps an interrupted run expanded",
    render(
      finishedState({ phase: "interrupted" }),
      cfg({ idleMode: "glyph" }),
      80,
    ).length > 1,
  );
  check(
    "idleMode=glyph marks an aborted run with the cross glyph",
    plain(
      render(
        finishedState({
          run: { turns: 3, tools: 4, durationMs: 9000, aborted: true },
        }),
        cfg({ idleMode: "glyph" }),
        80,
      )[0] ?? "",
    ).trim() === "✗ 3 turns · 4 tools · 9.0s",
  );
  check(
    "idleMode=hidden renders nothing while idle",
    render(finishedState(), cfg({ idleMode: "hidden" }), 80).length === 0,
  );
  check(
    "idleMode=glyph and hidden both render the full tree while a run is live",
    render(makeState(), cfg({ idleMode: "glyph" }), 80).length > 1 &&
      render(makeState(), cfg({ idleMode: "hidden" }), 80).length > 1 &&
      render(makeState(), cfg({ idleMode: "glyph" }), 80).map(plain).some((line) => line.includes("Thinking")),
  );
  check(
    "idleMode=glyph expands while a prompt is primed but no turn has started",
    render(
      finishedState({ phase: "primed", currentTurn: null }),
      cfg({ idleMode: "glyph" }),
      80,
    ).map(plain).some((line) => line.includes("refactor the auth")),
  );
  check(
    "idleMode=glyph expands when working output is queued",
    render(
      finishedState({ queued: ["also update the docs"] }),
      cfg({ idleMode: "glyph" }),
      80,
    ).map(plain).some((line) => line.includes("queued")),
  );
  check(
    "idleMode=glyph derives totals from the past turns when the live turn is gone",
    render(
      finishedState({
        currentTurn: null,
        pastTurns: [{ number: 7, toolCount: 4, durationMs: 14000 }],
      }),
      cfg({ idleMode: "glyph" }),
      80,
    ).map(plain).join("\n").includes("1 turn · 4 tools · 14s"),
  );
  check(
    "idleMode=glyph shows nothing when the run made no turns",
    render(
      finishedState({
        currentTurn: null,
        pastTurns: [],
        run: { turns: 0, tools: 0, durationMs: 0 },
      }),
      cfg({ idleMode: "glyph" }),
      80,
    ).length === 0,
  );
  check(
    "idleMode=glyph summary fits narrow widths and ascii mode",
    [20, 24, 30, 60].every((width) => {
      const lines = render(
        finishedState(),
        cfg({ idleMode: "glyph", glyphs: "ascii" }),
        width,
      );
      return (
        lines.length === 1 &&
        allLinesFit(lines, width) &&
        /^[\x00-\x7F]*$/.test(plain(lines[0]))
      );
    }),
  );
}


// --- animate stops the timer -------------------------------------------------
// `animate: false` freezes the glyph; the interval has nothing left to do, so it
// must not run. Turning it back on (or resetting) restarts it for a live run.

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-animate-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set();
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  writeFileSync(
    join(tempAgent, "prompt-panel.json"),
    JSON.stringify({ animate: false, tickMs: 50 }),
  );
  globalThis.setInterval = (fn, ms) => {
    const id = { fn, ms };
    live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
  };
  try {
    let command;
    const handlers = new Map();
    mod.default({
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerCommand(name, options) {
        if (name === "panel") command = options;
      },
    });
    const ui = {
      notify() {},
      setWidget() {},
      getToolsExpanded() {
        return false;
      },
    };
    const ctx = { mode: "tui", ui };
    const call = (name, event = {}) => handlers.get(name)?.(event, ctx);

    call("session_start", { reason: "startup" });
    call("input", { source: "interactive", text: "animate off" });
    call("agent_start", {});
    check(
      "animate: off means a live run starts no interval",
      live.size === 0,
      JSON.stringify({ live: live.size }),
    );

    await command.handler("reset", ctx);
    check(
      "animate: reset back to the defaults restarts the interval for a live run",
      live.size === 1,
      JSON.stringify({ live: live.size }),
    );

    call("agent_settled", { aborted: false });
    check(
      "animate: settling the run stops the interval",
      live.size === 0,
      JSON.stringify({ live: live.size }),
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

// --- Settings model ----------------------------------------------------------
// The pane is a thin shell over pure helpers: one row per config key, and a
// validated apply. Both are checked directly so a new config key cannot ship
// without a way to edit it.

{
  const ids = settingsItems(DEFAULT_CONFIG).map((item) => item.id).sort();
  const keys = Object.keys(DEFAULT_CONFIG).sort();
  check(
    "pane: every config key has a settings row",
    ids.join(",") === keys.join(","),
    `ids=${ids.join(",")} keys=${keys.join(",")}`,
  );
  check(
    "pane: every row starts on a value the row can cycle to",
    settingsItems(DEFAULT_CONFIG).every(
      (item) => Array.isArray(item.values) && item.values.includes(item.currentValue),
    ),
  );
  check(
    "pane: rows carry a description for the selected-item hint",
    settingsItems(DEFAULT_CONFIG).every(
      (item) => typeof item.description === "string" && item.description.length > 0,
    ),
  );

  const base = { ...DEFAULT_CONFIG };
  check(
    "pane: a maxRows choice becomes a number",
    applySettingValue("maxRows", "12", base).maxRows === 12 &&
      applySettingValue("maxRows", "auto", base).maxRows === "auto",
  );
  check(
    "pane: on/off rows become booleans",
    applySettingValue("animate", "off", base).animate === false &&
      applySettingValue("showPrompt", "on", base).showPrompt === true,
  );
  check(
    "pane: enum rows are stored verbatim",
    applySettingValue("idleMode", "hidden", base).idleMode === "hidden" &&
      applySettingValue("display", "expanded", base).display === "expanded",
  );
  check(
    "pane: an unknown id leaves the config alone",
    applySettingValue("nope", "x", base) === base,
  );
  check(
    "pane: a value the config rejects leaves it alone",
    applySettingValue("display", "sometimes", base) === base,
  );
}

// --- Settings pane -----------------------------------------------------------
// /panel with no arguments opens Pi's SettingsList: arrows move, Enter/Space
// cycle, Esc closes. Changes are written immediately, and the panel follows.

{
  const tempAgent = mkdtempSync(join(here, ".tmp-agent-pane-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgent;
  writeFileSync(
    join(tempAgent, "prompt-panel.json"),
    JSON.stringify({ maxRows: 6 }),
  );
  try {
    const notifications = [];
    let command;
    let factory;
    let widget;
    let closed = "unset";
    let renders = 0;
    mod.default({
      on() {},
      registerCommand(name, options) {
        if (name === "panel") command = options;
      },
    });
    const tui = {
      terminal: { rows: 40 },
      requestRender() {
        renders++;
      },
    };
    const ui = {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setWidget(_key, content) {
        widget =
          typeof content === "function" ? content(tui, theme) : undefined;
      },
      getToolsExpanded() {
        return false;
      },
      async custom(create) {
        factory = create;
        return undefined;
      },
    };
    const ctx = { mode: "tui", ui };
    const saved = () =>
      JSON.parse(readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"));

    await command.handler("", ctx);
    check(
      "pane: /panel with no arguments opens the pane instead of reporting",
      typeof factory === "function" && notifications.length === 0,
    );

    const pane = factory(tui, theme, undefined, (result) => {
      closed = result;
    });
    const lines = () => pane.render(70).map(plain);
    const cells = (line) =>
      line
        .replace(/^\s*(?:→\s+)?/, "")
        .split(/\s{2,}/)
        .map((cell) => cell.trim());
    const cursor = () => {
      const line = lines().find((text) => text.startsWith("→ "));
      return line === undefined ? undefined : cells(line)[0];
    };
    const valueOf = (label) => {
      const line = lines().find((text) => cells(text)[0] === label);
      return line === undefined ? undefined : cells(line)[1];
    };
    const selectRow = (label) => {
      for (let step = 0; step < 40; step++) {
        if (cursor() === label) return true;
        pane.handleInput("\x1b[B");
      }
      return false;
    };
    const key = (data) => {
      const before = renders;
      pane.handleInput(data);
      return renders > before;
    };

    check(
      "pane: the title and config path are rendered above the list",
      pane.render(160).map(plain)[1].includes("prompt-panel") &&
        pane.render(160).map(plain)[2].includes(join(tempAgent, "prompt-panel.json")),
      JSON.stringify(pane.render(160).map(plain).slice(0, 4)),
    );
    check(
      "pane: full-width rules divide the pane above and below, like /settings",
      (() => {
        const rows = lines();
        const rule = "─".repeat(70);
        return (
          rows.length > 8 &&
          rows[0] === rule &&
          rows[rows.length - 1] === rule &&
          rows.every((line) => visibleWidth(line) <= 70)
        );
      })(),
      JSON.stringify(lines().slice(0, 2).concat(lines().slice(-2))),
    );
    check(
      "pane: the first row is selected and the list pages in fullscreen",
      cursor() === "enabled" && pane.capturesViewportInput === true,
      cursor(),
    );
    check(
      "pane: PageUp/PageDown are not swallowed by the panel scroll",
      key("\x1b[B") && cursor() === "display",
      cursor(),
    );
    check(
      "pane: arrow up wraps to the last row",
      key("\x1b[A") !== undefined && cursor() === "enabled",
      cursor(),
    );

    check(
      "pane: values come from the config file",
      valueOf("maxRows") === "6",
      JSON.stringify(lines().slice(3, 8)),
    );
    check(
      "pane: selecting a row and pressing space cycles the value",
      selectRow("display") && key(" ") && valueOf("display") === "expanded",
      JSON.stringify({ cursor: cursor(), value: valueOf("display") }),
    );
    check(
      "pane: the change is persisted immediately",
      saved().display === "expanded",
      JSON.stringify(saved()),
    );
    check(
      "pane: enter cycles as well",
      key("\r") && valueOf("display") === "minimal" && saved().display === "minimal",
      JSON.stringify(saved()),
    );
    check(
      "pane: a numeric row stores a number, not a string",
      selectRow("maxRows") && key(" ") && saved().maxRows === 8,
      JSON.stringify(saved()),
    );
    check(
      "pane: a boolean row stores a boolean",
      selectRow("showThinking") &&
        key(" ") &&
        valueOf("showThinking") === "off" &&
        saved().showThinking === false,
      JSON.stringify(saved()),
    );
    check(
      "pane: clicking a row selects and cycles it, offset by the heading",
      (() => {
        const index = lines().findIndex((line) => cells(line)[0] === "showPrompt");
        const event = { type: "press", button: "left", x: 4, y: index };
        pane.handleMouse(event);
        const result = pane.handleMouse({ ...event, type: "click" });
        return (
          index > 4 &&
          result !== undefined &&
          valueOf("showPrompt") === "off" &&
          saved().showPrompt === false
        );
      })(),
      JSON.stringify({ rows: lines().slice(3, 10), saved: saved() }),
    );
    check(
      "pane: the dividers follow the ascii glyph setting",
      selectRow("glyphs") &&
        key(" ") &&
        valueOf("glyphs") === "ascii" &&
        lines()[0] === "-".repeat(70) &&
        saved().glyphs === "ascii",
      JSON.stringify({ value: valueOf("glyphs"), top: lines()[0]?.slice(0, 8) }),
    );
    check(
      "pane: a description explains the selected row",
      selectRow("showThinking") &&
        lines().some((line) => line.trim() === "Show the thinking row while a turn is live."),
      JSON.stringify(lines().slice(-4)),
    );

    check(
      "pane: switching enabled off removes the widget and persists it",
      selectRow("enabled") && key(" ") && saved().enabled === false && widget === undefined,
      JSON.stringify({ widget, saved: saved() }),
    );
    check(
      "pane: switching it back on persists true",
      key(" ") && saved().enabled === true,
      JSON.stringify(saved()),
    );

    pane.handleInput("\x1b");
    check(
      "pane: escape closes the pane",
      closed === undefined,
      JSON.stringify(closed),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgent, { recursive: true, force: true });
  }
}

console.log("");
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing case(s))`);
  process.exit(1);
}
console.log("RESULT: PASS (all cases)");
