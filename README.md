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
  "display": "compact",
  "showPrompt": true,
  "showThinking": true,
  "thinkingPreviewChars": 60,
  "animate": true,
  "tickMs": 200,
  "pulseMs": 600,
  "thinkingMs": 500,
  "idleMode": "glyph",
  "glyphs": "unicode"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; off removes the widget and its timer. |
| `maxRows` | `"auto"` | `"auto"` = 30% of the terminal height, clamped 6–18. A number is clamped 1–48. |
| `display` | `"compact"` | How much of the run to show: `"minimal"` = the prompt and the live turn; `"compact"` = the live turn plus the previous two, one line per tool; `"expanded"` = every retained turn (up to 500), with tool arguments and result previews. |
| `showPrompt` | `true` | Show the pinned prompt row. |
| `showThinking` | `true` | Show the thinking row while a turn is live. |
| `thinkingPreviewChars` | `60` | Width budget of the thinking preview. |
| `animate` | `true` | Pulse the running glyph. `false` freezes it and stops the timer. |
| `tickMs` | `200` | Refresh cadence while a run is active. |
| `pulseMs` | `600` | How long the running glyph holds before alternating. |
| `thinkingMs` | `500` | How often the thinking preview advances. |
| `idleMode` | `"glyph"` | What stays on screen once nothing is running: `"glyph"` = one row of run totals (`✓ 5 turns · 13 tools · 54s`), expandable back to the full tree; `"full"` = always the finished tree; `"hidden"` = nothing (also expandable). It applies to `minimal` and `compact`; `expanded` always keeps the tree. |
| `glyphs` | `"unicode"` | `"ascii"` for terminals without Unicode glyph support. |

Every key is also editable from `/panel`, which opens a settings pane in place of the editor — arrows
move, `Enter` or `Space` cycles the value on the selected row, page keys page the list, and `Esc`
closes. It is Pi's own settings list, so it behaves like `/settings` and `/tools`, and each change is
saved and applied immediately: the panel behind the pane updates as you cycle.

## Commands

| Command | Effect |
| --- | --- |
| `/panel` | Open the settings pane (arrows, `Enter`/`Space`, `Esc`). |
| `/panel status` | Report enabled state, row budget, display mode, idle mode, and config path. |
| `/panel on` · `off` | Toggle the panel. |
| `/panel rows <n\|auto>` | Set the row budget. |
| `/panel thinking on\|off` | Toggle the thinking row. |
| `/panel ascii on\|off` | Switch glyph set. |
| `/panel display minimal\|compact\|expanded` | Set the display mode. |
| `/panel idle full\|glyph\|hidden` | Set what the panel keeps while idle. |
| `/panel reset` | Restore defaults. |

Every change is persisted to the config file. If the file cannot be written (read-only home),
the value still applies for the session and you are warned once.

## Behaviour

- **Prompt.** The text is italic — the `❯` stays accent — so the pinned ask cannot be mistaken
  for another block of model output. Collapsed, the prompt is one row ellipsized at a word
  boundary, so the last visible word is never chopped in half; only a single token longer than
  the row is cut where it has to be. Clicking it — the `❯` or any text on the row — expands the
  full text in place, wrapped under the text column and opened at its first line, and clicking
  again collapses it. An expanded prompt longer than the panel is not truncated: scroll it with
  the mouse wheel. A new prompt always starts collapsed.
- **Depth.** `display` picks how much of the run the tree keeps, and `/panel display` (or the
  settings pane) switches it while you work:

  | Mode | Shows |
  | --- | --- |
  | `minimal` | the prompt and the live turn |
  | `compact` | the live turn plus the previous two |
  | `expanded` | every turn the session still retains, with tool arguments and results |

  Each completed turn compresses to one line (`✓ turn 3 · 2 tools · 8.4s`), newest at the bottom;
  the live turn keeps its thinking row and tool rows in every mode. The mode alone decides the
  depth: scrolling moves the window inside it and never adds a turn, so the panel's height only
  changes when the mode, budget, or run state changes. Turns are retained as compact records
  (number, tool count, duration) up to 500; turn numbers stay monotonic across prompts and never
  gap.
- **Thinking** is a single row that rewrites itself with the tail of the live buffer. It prefers
  the sentence currently in progress, snaps to a word boundary, and advances at most once per
  `thinkingMs` so it does not crawl per token. It disappears when the turn finishes.
- **Tools** show a status glyph (`✓` / `✗` / pulsing `●`), the tool name, a one-line argument
  summary, and a duration. Paths ellipsize in the middle so the filename survives; every other
  summary ellipsizes at the end. Nested calls (`parentToolCallId`) indent one level; parallel
  calls stay in event order.
- **Expansion** is the `expanded` mode: arguments up to 3 wrapped lines plus a result preview up
  to 5 lines, errors in the error colour, and every retained turn. `minimal` and `compact` keep
  one line per tool, so the panel stays readable while you work; Pi's own `ctrl+o` still expands
  the transcript, but it no longer changes the panel — the mode is the only switch. Expanded
  output is windowed to 48 lines or 60% of the terminal, whichever is larger, and scrolls inside
  the panel — the wheel over the panel moves it one to five rows at a time, and `… N earlier` /
  `… N more` markers show what is off-screen. The wheel never leaves the panel while the pointer
  is over it: it stops at the ends instead of scrolling the transcript underneath, so pointing at
  the tree can never move the conversation. Scroll the transcript from outside the panel.
- **Budget.** The window shows the newest rows by default. Below 60 columns the duration column
  is dropped, below 48 the diffstat, below 40 the live turn collapses to one line.
- **Lifecycle.** Hidden until your first prompt. Once a run settles, the panel collapses to one
  row of totals — `✓ 5 turns · 13 tools · 54s`, summed over every turn of that run, including
  turns the mode no longer keeps on screen — and expands back automatically as soon as the next
  run starts, before its first token. The collapsed row is not a dead end: clicking it opens the
  tree the mode would render, with the totals row repeated at the bottom as the control that
  folds it again — so you can inspect a finished run without changing the mode. A new prompt, or
  the next run settling, folds it back. `idleMode: "full"` always keeps the tree and `"hidden"`
  removes the row entirely, though `display: "expanded"` keeps the tree either way. Esc freezes the
  tree with the active rows marked interrupted (an interrupted panel stays expanded). A new
  prompt swaps the prompt line, archives the tree, and clears the live turn. `/new`, `/resume`,
  `/tree`, and `/reload` reset it; resuming a session replays nothing.
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

- Mouse: the prompt block and the idle totals row are clickable, and the panel owns the wheel
  while the pointer is over it — it scrolls its own window when the content overflows and does
  nothing at the ends. It never scrolls the transcript, which also means a panel short enough to
  fit is a no-op for the wheel rather than a pass-through. Other rows are display-only; use
  `/panel display expanded` for tool arguments and results. Clicks and wheel events require Pi's
  fullscreen TUI (`tuiMode: "fullscreen"`, the default) — regular mode leaves mouse reporting to
  the terminal, so no mouse events reach extensions there.
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

## License

MIT — see [`LICENSE`](LICENSE).
