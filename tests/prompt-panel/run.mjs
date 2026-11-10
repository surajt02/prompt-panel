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
  parseConfig,
  effectiveRowBudget,
  middleEllipsize,
  formatDuration,
  summarizeToolArgs,
  countEditDiff,
  renderPanel,
} = mod;

// Collapsed baseline: the shipped default is expand:"always", but these cases
// assert exact row budgets, so they pin the collapsed layout explicitly.
const COLLAPSED = { ...DEFAULT_CONFIG, expand: "never" };

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
    "countEditDiff",
    "effectiveRowBudget",
    "formatDuration",
    "middleEllipsize",
    "parseConfig",
    "renderPanel",
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
      pastTurns: 0,
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
      result.config.pastTurns === 0 &&
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
    "parseConfig({}): idleMode defaults to full",
    !result.error && result.config.idleMode === "full",
    JSON.stringify(result),
  );
}
for (const [label, value] of [
  ["broken JSON", "{"],
  ["maxRows 0", { maxRows: 0 }],
  ["maxRows 49", { maxRows: 49 }],
  ["pastTurns -1", { pastTurns: -1 }],
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

// ---- row budget ------------------------------------------------------------
{
  const auto = { ...COLLAPSED, maxRows: "auto" };
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
    effectiveRowBudget({ ...COLLAPSED, maxRows: 0 }, 24) === 1 &&
      effectiveRowBudget({ ...COLLAPSED, maxRows: 52 }, 24) === 48 &&
      effectiveRowBudget({ ...COLLAPSED, maxRows: 9 }, 24) === 9,
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
    { config: { ...COLLAPSED, maxRows: 18 }, terminalRows: 24 },
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
    { config: { ...COLLAPSED, maxRows: 18 } },
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
    { config: { ...COLLAPSED, maxRows: 18 } },
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
    { config: { ...COLLAPSED, maxRows: 18 } },
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
    { config: { ...COLLAPSED, maxRows: 18 } },
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
    { config: { ...COLLAPSED, maxRows: 6 }, terminalRows: 24 },
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
      config: { ...COLLAPSED, maxRows: 6, expand: "follow" },
      expanded: true,
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
      config: { ...COLLAPSED, maxRows: 18, expand: "follow" },
      expanded: true,
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
      config: { ...COLLAPSED, glyphs: "ascii", maxRows: 18 },
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
        config: { ...COLLAPSED, maxRows: 18, expand: "follow" },
        expanded: true,
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
    { config: { ...COLLAPSED, maxRows: 18 }, terminalRows: 24 },
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
            { config: { ...COLLAPSED, maxRows: 18 } },
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
  try {
    const handlers = new Map();
    let command;
    let widget;
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
        return false;
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

    await command.handler("", ctx);
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

    await command.handler("expand never", ctx);
    check(
      "lifecycle: /panel expand persists the mode",
      JSON.parse(readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"))
        .expand === "never",
    );
    const beforeInvalid = notifications.length;
    await command.handler("expand sometimes", ctx);
    check(
      "lifecycle: /panel expand rejects an unknown mode without writing",
      notifications.length > beforeInvalid &&
        notifications[notifications.length - 1].type === "warning" &&
        JSON.parse(readFileSync(join(tempAgent, "prompt-panel.json"), "utf8"))
          .expand === "never",
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
const cfg = (overrides = {}) => ({ ...COLLAPSED, ...overrides });
const render = (state, config, width) =>
  renderPanel(state, { config, expanded: false, terminalRows: 24 }, width, theme);

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
    // pastTurns=1 so a 3-turn run outruns what the panel still retains.
    writeFileSync(
      join(tempAgent, "prompt-panel.json"),
      JSON.stringify({ pastTurns: 1, idleMode: "glyph" }),
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
      "run totals: sums turns, tools, and elapsed time beyond the pastTurns cap",
      glyph().trim() === "✓ 3 turns · 3 tools · 6.0s",
      glyph(),
    );
    await command.handler("idle full", ctx);
    check(
      "run totals: the full panel still shows only the retained past turn",
      rows().filter((line) => /turn \d+/.test(line)).length === 2,
      JSON.stringify(rows()),
    );
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
  const lines = render(state, cfg({ pastTurns: 2, maxRows: 18 }), 80).map(plain);
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
  const render = (config, expanded) =>
    renderPanel(
      base,
      { config, expanded, terminalRows: 40 },
      100,
      theme,
    ).map(plain);

  const always = render({ ...DEFAULT_CONFIG, expand: "always", maxRows: 18 }, false);
  check(
    "expand=always shows arguments even when ctrl+o is off",
    always.some((line) => line.includes('"path"')),
    JSON.stringify(always.slice(0, 6)),
  );

  check(
    "the shipped default follows ctrl+o instead of forcing expansion",
    DEFAULT_CONFIG.expand === "follow",
    String(DEFAULT_CONFIG.expand),
  );
  check(
    "the default config collapses when ctrl+o is off",
    !render({ ...DEFAULT_CONFIG, maxRows: 18 }, false).some((line) =>
      line.includes('"path"'),
    ),
  );
  check(
    "the default config expands when ctrl+o is on",
    render({ ...DEFAULT_CONFIG, maxRows: 18 }, true).some((line) =>
      line.includes('"path"'),
    ),
  );

  const followOff = render({ ...DEFAULT_CONFIG, expand: "follow", maxRows: 18 }, false);
  const followOn = render({ ...DEFAULT_CONFIG, expand: "follow", maxRows: 18 }, true);
  check(
    "expand=follow collapses when ctrl+o is off",
    !followOff.some((line) => line.includes('"path"')),
  );
  check(
    "expand=follow expands when ctrl+o is on",
    followOn.some((line) => line.includes('"path"')),
  );

  const never = render({ ...DEFAULT_CONFIG, expand: "never", maxRows: 18 }, true);
  check(
    "expand=never ignores the ctrl+o flag",
    !never.some((line) => line.includes('"path"')),
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
      { config: { ...DEFAULT_CONFIG }, expanded: true, terminalRows },
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
      { config: { ...DEFAULT_CONFIG, expand: "never" }, terminalRows: 40 },
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
      { config: { ...DEFAULT_CONFIG, expand: "never", ...config }, terminalRows: 40 },
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
    { config: { ...COLLAPSED, expand: "follow" }, expanded: true, terminalRows: 60 },
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

  const full = render(finishedState(), cfg(), 80).map(plain);
  const glyph = render(finishedState(), cfg({ idleMode: "glyph" }), 80).map(plain);
  check(
    "idleMode defaults to the finished tree",
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

console.log("");
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing case(s))`);
  process.exit(1);
}
console.log("RESULT: PASS (all cases)");
