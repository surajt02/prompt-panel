# prompt-panel

A [Pi](https://pi.dev) extension that puts two things directly above the prompt editor:

1. **Your current prompt**, pinned and truncated, so you never lose track of the ask while the
   agent scrolls the conversation away.
2. **A live tree of what the agent is doing** — thinking, tool calls, edits with diffstats —
   Claude-Code style.

```
❯ refactor the auth middleware to use the new token store
  ✓ turn 3 · 2 tools · 8.4s
  ✓ turn 4 · 1.1s
  ● turn 5
    ✻ Thinking · …where the retry loop should go
    ├ ✓ read  src/…/middleware.ts                          0.1s
    ├ ✓ edit  src/http/fetch.ts                        +9 −2  0.3s
    └ ● bash  pnpm test                                  running
  ❯ also update the docs · queued
```

The panel adds; it never replaces. Transcript rendering, tool renderers, and thinking blocks
are untouched.

## Install

Copy the extension into your global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/surajt02/prompt-panel/main/extensions/prompt-panel.ts \
  -o ~/.pi/agent/extensions/prompt-panel.ts
```

Or clone and link it:

```bash
git clone git@github.com:surajt02/prompt-panel.git
ln -sfn "$PWD/prompt-panel/extensions/prompt-panel.ts" ~/.pi/agent/extensions/prompt-panel.ts
```

Pi loads every `*.ts` in that directory, so the panel appears on the next `/reload` or new
session. A symlink works: Pi resolves the import map for `@earendil-works/pi-tui` itself, so the
repo does not need `node_modules` at runtime. The package also carries a `pi.extensions` manifest,
so it can be installed as a Pi package later.

Requires Pi **1.5.0+**. Non-interactive modes (`--print`, JSON, RPC) are a no-op.

## Configuration

`~/.pi/agent/prompt-panel.json` — every key is optional; a missing file means defaults, and a
malformed file produces one error notification and then defaults.

```json
{
  "enabled": true,
  "maxRows": "auto",
  "pastTurns": 2,
  "showPrompt": true,
  "showThinking": true,
  "thinkingPreviewChars": 60,
  "animate": true,
  "tickMs": 200,
  "pulseMs": 600,
  "thinkingMs": 500,
  "expand": "follow",
  "idleMode": "glyph",
  "glyphs": "unicode"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; off removes the widget and its timer. |
| `maxRows` | `"auto"` | `"auto"` = 30% of the terminal height, clamped 6–18. A number is clamped 1–48. |
| `pastTurns` | `2` | How many completed turns stay visible as one-line summaries while the panel is collapsed. Expanding reveals every turn the session still retains (up to 500). |
| `showPrompt` | `true` | Show the pinned prompt row. |
| `showThinking` | `true` | Show the thinking row while a turn is live. |
| `thinkingPreviewChars` | `60` | Width budget of the thinking preview. |
| `animate` | `true` | Pulse the running glyph. `false` freezes it and stops the timer. |
| `tickMs` | `200` | Refresh cadence while a run is active. |
| `pulseMs` | `600` | How long the running glyph holds before alternating. |
| `thinkingMs` | `500` | How often the thinking preview advances. |
| `expand` | `"follow"` | `"follow"` = `ctrl+o` decides; `"always"` = always expanded; `"never"` = one line per tool. Expansion also reveals every retained turn and overrides idle collapse. |
| `idleMode` | `"glyph"` | What stays on screen once nothing is running: `"glyph"` = one row of run totals (`✓ 5 turns · 13 tools · 54s`), expandable back to the full tree; `"full"` = always the finished tree; `"hidden"` = nothing (also expandable). |
| `glyphs` | `"unicode"` | `"ascii"` for terminals without Unicode glyph support. |

## Commands

| Command | Effect |
| --- | --- |
| `/panel` | Report enabled state, row budget, expand mode, idle mode, and config path. |
| `/panel on` · `off` | Toggle the panel. |
| `/panel rows <n\|auto>` | Set the row budget. |
| `/panel thinking on\|off` | Toggle the thinking row. |
| `/panel ascii on\|off` | Switch glyph set. |
| `/panel expand always\|follow\|never` | Set the expansion mode. |
| `/panel idle full\|glyph\|hidden` | Set what the panel keeps while idle. |
| `/panel reset` | Restore defaults. |

Every change is persisted to the config file. If the file cannot be written (read-only home),
the value still applies for the session and you are warned once.

## Behaviour

- **Prompt.** The pinned prompt is one ellipsized row. Clicking it — the `❯` or any text on the
  row — expands the full text in place, wrapped under the text column and opened at its first
  line, and clicking again collapses it. A prompt longer than the panel is not truncated: scroll
  it with the mouse wheel. A new prompt always starts collapsed.
- **Depth.** The live tree is the current run. Each completed turn compresses to one line
  (`✓ turn 3 · 2 tools · 8.4s`), newest at the bottom. Collapsed, only the newest `pastTurns` are
  shown; expanding the panel (`ctrl+o`, or `expand: "always"`) reveals every turn the session
  still retains, so you can read the whole run's shape at once. Turns are retained as compact
  records (number, tool count, duration) up to 500; turn numbers stay monotonic across prompts
  and never gap.
- **Thinking** is a single row that rewrites itself with the tail of the live buffer. It prefers
  the sentence currently in progress, snaps to a word boundary, and advances at most once per
  `thinkingMs` so it does not crawl per token. It disappears when the turn finishes.
- **Tools** show a status glyph (`✓` / `✗` / pulsing `●`), the tool name, a one-line argument
  summary, and a duration. Paths ellipsize in the middle so the filename survives; every other
  summary ellipsizes at the end. Nested calls (`parentToolCallId`) indent one level; parallel
  calls stay in event order.
- **Expansion** follows `ctrl+o` (Pi's built-in tool expansion) in `follow` mode: arguments up to
  3 wrapped lines plus a result preview up to 5 lines, errors in the error colour, and every
  retained turn instead of the newest `pastTurns`. Expanded output is windowed to 48 lines or 60%
  of the terminal, whichever is larger, and scrolls inside the panel — the wheel over the panel
  moves it one to five rows at a time, and `… N earlier` / `… N more` markers show what is
  off-screen. Wheel events fall through to the transcript whenever the panel fits on screen.
- **Budget.** The window shows the newest rows by default. Below 60 columns the duration column
  is dropped, below 48 the diffstat, below 40 the live turn collapses to one line.
- **Lifecycle.** Hidden until your first prompt. Once a run settles, the panel collapses to one
  row of totals — `✓ 5 turns · 13 tools · 54s`, summed over every turn of that run, including
  turns `pastTurns` no longer keeps on screen — and expands back automatically as soon as the next
  run starts, before its first token. The collapsed row is not a dead end: `ctrl+o` (or
  `expand: "always"`) brings the full finished tree back, so you can inspect an old run without
  starting a new one. `idleMode: "full"` always keeps the tree, and `"hidden"` removes it while
  idle (also expandable). Esc freezes the tree with the active rows marked interrupted (an
  interrupted panel stays expanded). A new prompt swaps the prompt line, archives the tree, and
  clears the live turn. `/new`, `/resume`, `/tree`, and `/reload` reset it; resuming a session
  replays nothing.
- **Cost when idle.** Zero. The interval runs only while a run is active and is cleared on settle,
  abort, shutdown, disable, and disposal.

## Cleanup

`/panel off` removes the widget for the session. To remove the extension, delete
`~/.pi/agent/extensions/prompt-panel.ts` (and optionally `~/.pi/agent/prompt-panel.json`) and run
`/reload`.

## Development

```bash
npm install     # provides @earendil-works/pi-tui for the printable-width helpers
npm test
```

The test harness copies `extensions/prompt-panel.ts` into a temporary `.mts` file and imports it
directly, so it needs no TUI, no session, and no network. It asserts rendered **content**
(truncation markers, row budgets, glyph pacing, expansion modes, lifecycle transitions), not just
line widths — the panel clips every line as a safety net, which means a width-only assertion
cannot detect a layout bug.

`docs/` holds no code: `upstream-reveal-entry.md` is the argument for the one Pi API this
extension is waiting on, kept in the repo so the evidence stays checkable against the Pi version
it was verified against.

## Limitations

- Mouse: the prompt block is clickable and the panel scrolls under the wheel. Other rows are
  display-only; use `ctrl+o` to expand. Clicks and wheel events require Pi's fullscreen TUI
  (`tuiMode: "fullscreen"`, the default) — regular mode leaves mouse reporting to the terminal,
  so no mouse events reach extensions there.
- No jump-to-block: the Pi extension API has no transcript scroll hook, so a tree row cannot take
  you to the corresponding conversation block, and the panel cannot build one on its own — the
  transcript handle, and the entry-to-row map, are private. Turns are retained as compact records
  (`number`, tool count, duration, aborted) and do not yet carry the session entry id that a reveal
  hook would target. The intended shape — click a turn's header row, land on that turn, no
  keyboard binding — plus the verified evidence and prior art are written up in
  [`docs/upstream-reveal-entry.md`](docs/upstream-reveal-entry.md), which is the request to file
  upstream.
- Expanded detail covers the live turn only; completed turns are one-liners by design.
- Width handling is delegated to `@earendil-works/pi-tui`, so the effective version is whatever
  Pi maps extension imports to.
