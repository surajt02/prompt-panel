# prompt-panel

A [Pi](https://pi.dev) extension that puts two things directly above the prompt editor:

1. **Your current prompt**, pinned, italic, and ellipsized at a word boundary, so you never lose
   track of the ask while the agent scrolls the conversation away.
2. **A live tree of what the agent is doing** — thinking, tool calls, edits with diffstats —
   Claude-Code style.

```
❯ refactor the auth middleware to use the new token store
  ✓ turn 3 · 2 tools · 8.4s
  ✓ turn 4 · 1.1s
  ● turn 5 · ✻ Thinking · where the retry loop should go, then whether…
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

Requires Pi **1.5.0+** (developed and verified against 1.5.1). Non-interactive modes (`--print`,
JSON, RPC) are a no-op.

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
  "thinkingMode": "text",
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
| `display` | `"compact"` | How much of the run to show: `"minimal"` = the prompt and the live turn; `"compact"` = the live turn plus the previous two, one line per tool; `"expanded"` = every retained turn (up to 500), with tool arguments and result previews. Pi's `ctrl+o` shows the `expanded` view while it is on without changing this value. |
| `showPrompt` | `true` | Show the pinned prompt row. |
| `showThinking` | `true` | Show thinking on the live turn's header. |
| `thinkingMode` | `"text"` | How it reads there: `"text"` = the clause in progress, cut at a word boundary; `"glyph"` = just a pulsing `✻ Thinking` label, no preview text. |
| `thinkingPreviewChars` | `60` | Width budget of the thinking preview, clipped at a word boundary. |
| `animate` | `true` | Pulse the running glyph. `false` freezes it and stops the timer. |
| `tickMs` | `200` | Refresh cadence while a run is active. |
| `pulseMs` | `600` | How long an animated glyph holds before its next stage. The thinking mark cycles three stages, the running glyph two. |
| `thinkingMs` | `500` | How often the thinking preview advances. |
| `idleMode` | `"glyph"` | What stays on screen once nothing is running: `"glyph"` = one row of run totals (`✓ 5 turns · 13 tools · 54s`), expandable back to the full tree; `"full"` = always the finished tree; `"hidden"` = nothing (also expandable). It applies to `minimal` and `compact`; `expanded` always keeps the tree. |
| `glyphs` | `"unicode"` | `"ascii"` for terminals without Unicode glyph support. |

Every key is also editable from `/panel`, which opens a settings pane in place of the editor —
arrows move, `Enter` or `Space` cycles the value on the selected row, page keys page the list,
`Esc` closes, and a click selects and cycles a row. It is Pi's own settings list, so it behaves
like `/settings` and `/tools`, and each change is saved and applied immediately: the panel behind
the pane updates as you cycle.

Settings are that file, so they persist across sessions. What does not persist is view state — the
scroll offset, an expanded prompt, a totals row you clicked open — along with the run tree itself.

A file written before `display` existed usually still has `expand` and `pastTurns`; those are read
as a mode (`expand: "always"` → `expanded`, `pastTurns: 0` → `minimal`, otherwise `compact`) and
dropped the next time anything is saved.

## Commands

| Command | Effect |
| --- | --- |
| `/panel` | Open the settings pane (arrows, `Enter`/`Space`, `Esc`). |
| `/panel status` | Report enabled state, row budget, display mode, idle mode, and config path. |
| `/panel on` · `off` | Toggle the panel. |
| `/panel rows <n\|auto>` | Set the row budget. |
| `/panel thinking on\|off` | Toggle the thinking preview. |
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
  the row is cut where it has to be. Clicking it — the `❯` or any text on the row — expands
  the full text in place, wrapped under the text column and opened at its first line, and
  clicking again collapses it. An expanded prompt longer than the panel is not truncated: scroll
  it with the mouse wheel. A new prompt always starts collapsed.
- **Depth.** `display` picks how much of the run the tree keeps, and `/panel display` (or the
  settings pane) switches it while you work:

  | Mode | Shows |
  | --- | --- |
  | `minimal` | the prompt and the live turn |
  | `compact` | the live turn plus the previous two |
  | `expanded` | every turn the session still retains, with tool arguments and results |

  Each completed turn compresses to one line (`✓ turn 3 · 2 tools · 8.4s`), newest at the
  bottom; the live turn keeps its thinking header and tool rows in every mode. The mode decides the
  depth (Pi's `ctrl+o` overlays `expanded` on top of it, see below): scrolling moves the window
  inside it and never adds a turn, so the panel's height only changes when the mode, budget, or
  run state changes. Turns are retained as compact records (number, tool count, duration) up to
  500; turn numbers stay monotonic across prompts and never gap.
- **Thinking** rides on the live turn's header row — `● turn 5 · ✻ Thinking · where the retry
  loop should go, then whether the…` — instead of taking a row of its own, so the panel spends
  that row on tool activity. The preview is the clause currently being written, cut at a word
  boundary with a trailing ellipsis, the same cut the pinned prompt uses, so it reads as the
  thought in progress rather than as a tail fragment. The head only changes when new words fit,
  so a long clause holds still instead of crawling, and it advances at most once per `thinkingMs`.
  Its mark cycles `✻` → `✶` → `✳`, one stage per `pulseMs` and half a stage out of step with the
  running glyph's two-frame flip (frozen when `animate` is off), independent of the `thinkingMs`
  text cadence — an animation that flipped on the same frame as the tool dot read as one blinking
  widget rather than a thought beside running work. It is measured against what the turn details leave on the row: too
  little room for a preview keeps just `✻ Thinking`, and too little for even that drops the
  suffix, so a narrow panel keeps its turn row intact. `thinkingMode: "glyph"` never shows the
  text, for readers who would rather see that something is happening than read a clipped
  sentence. The suffix disappears when the turn finishes, and stays hidden until the thought has
  content.
- **Tools** show a status glyph (`✓` / `✗` / pulsing `●`), the tool name, a one-line argument
  summary, and a duration. Paths ellipsize in the middle so the filename survives; every other
  summary ellipsizes at the end. Nested calls (`parentToolCallId`) indent one level and stay under
  the parent they belong to. A batch runs in parallel, so a later call can finish first: finished
  rows stack above the calls still running — the running row is the last one, on the `└`
  connector — and each of those two groups keeps event order.
- **A row appears while the call is still being written**, which is the only way a fast tool is
  readable at all. The name arrives with the call's first token and the summary — path, command,
  script line — fills in as the arguments stream, so a `write` or `edit`, whose execution takes
  milliseconds, is on screen for the seconds the model spends composing it instead of for one
  frame. Such a row carries the live glyph and no duration; it is not labelled `running`, because
  nothing executes yet. Pi then executes that same row — a second one never appears — and it
  gains its duration and diffstat when it finishes. In `expanded` mode the argument preview waits
  until execution starts, so a growing file body cannot crawl under the row.
- **Expansion** is the `expanded` mode: arguments up to 3 wrapped lines plus a result preview up
  to 5 lines, errors in the error colour, and every retained turn. `minimal` and `compact` keep
  one line per tool, so the panel stays readable while you work. Pi's own `ctrl+o` (whatever
  `app.tools.expand` is bound to) shows that view too while it is on: it expands the transcript
  as it always did, and the panel follows it. That is an overlay, not a second setting — nothing
  is written to the config, `/panel status` and the settings pane keep reporting the configured
  mode, and the panel returns to it the moment `ctrl+o` goes off. It also wins over `idleMode`,
  the way `display: "expanded"` does, so a collapsed totals row opens while it is held. Expanded
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
  removes the row entirely, though `display: "expanded"` — or `ctrl+o` held on — keeps the tree
  either way. Esc freezes the tree with the active rows marked interrupted (an interrupted panel
  stays expanded). A new prompt swaps the prompt line, archives the tree, and clears the live
  turn. `/new`, `/resume`, `/tree`, and `/reload` reset it; resuming a session replays nothing.
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
(word-boundary truncation, row budgets, glyph pacing, display modes, the `ctrl+o` overlay, the
wheel staying inside the panel, lifecycle transitions), not just line widths — the panel clips
every line as a safety net, which means a width-only assertion cannot detect a layout bug.

`docs/` holds no code: `upstream-reveal-entry.md` is the argument for the one Pi API this
extension is waiting on, kept in the repo so the evidence stays checkable against the Pi version
it was verified against.

## Limitations

- Mouse: the prompt block and the idle totals row are clickable, and the panel owns the wheel
  while the pointer is over it — it scrolls its own window when the content overflows and does
  nothing at the ends. It never scrolls the transcript, which also means a panel short enough to
  fit is a no-op for the wheel rather than a pass-through. Other rows are display-only; use
  `/panel display expanded` (or `ctrl+o`) for tool arguments and results. Clicks and wheel events
  require Pi's fullscreen TUI (`tuiMode: "fullscreen"`, the default) — regular mode leaves mouse
  reporting to the terminal, so no mouse events reach extensions there.
- No jump-to-block: the Pi extension API has no transcript scroll hook, so a tree row cannot take
  you to the corresponding conversation block, and the panel cannot build one on its own — the
  transcript handle, and the entry-to-row map, are private. Turns are retained as compact records
  (`number`, tool count, duration, aborted) and do not yet carry the session entry id that a reveal
  hook would target. The intended shape — click a turn's header row, land on that turn, no
  keyboard binding — plus the verified evidence and prior art are written up in
  [`docs/upstream-reveal-entry.md`](docs/upstream-reveal-entry.md), which is the request to file
  upstream.
- No keybinding: the panel registers no shortcut of its own, so there is no keyboard equivalent of
  clicking the prompt or the totals row. `/panel`, its subcommands, and the mouse are the controls.
  `ctrl+o` is Pi's binding (`app.tools.expand`), not the panel's: the panel only reads its state,
  which is why rebinding it in `keybindings.json` moves both together.
- Expanded detail covers the live turn only; completed turns are one-liners by design.
- Width handling is delegated to `@earendil-works/pi-tui`, so the effective version is whatever
  Pi maps extension imports to.

## License

MIT — see [`LICENSE`](LICENSE).
