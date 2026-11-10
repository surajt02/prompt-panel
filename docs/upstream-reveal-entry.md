# Upstream request: reveal a session entry in the transcript

Status: **drafted, not filed.** Verified against Pi `1.5.1`
(`~/.pi/agent/install/releases/1.5.1`). Everything below was read out of the installed
`dist`, not from docs, so it can be re-checked line by line.

## The ask, in one line

Give extensions a way to scroll the fullscreen transcript to a session entry:

```ts
ctx.ui.revealEntry(
  entryId: string,
  options?: { align?: "top" | "center"; highlightMs?: number },
): boolean;
```

`false` when the entry is not on the current branch or is not rendered, so callers can fall back
without guessing. Inline mode may no-op and return `false`.

## Why prompt-panel needs it

The panel already renders one clickable row per turn and can map a click to a window row. What it
cannot do is move the transcript. Clicking a turn header should land on that turn's conversation
block, which is the whole point of reading a tree: the tree says *where*, the transcript says
*what*. Header rows only, no keyboard binding (decided; see [Follow-up](#follow-up-in-prompt-panel)).

## Why it is impossible today

- `ExtensionUIContext` (`packages/coding-agent/src/core/extensions/types.ts`, `dist/core/extensions/types.d.ts:83`)
  exposes `select`/`confirm`/`input`/`notify`/`onTerminalInput`/`setStatus`/`setWidget`/`setFooter`/
  `setHeader`/`custom`/`pasteToEditor`/`setEditorText`/`getEditorText`/`editor`/… — grepping that
  file for `scroll` returns nothing. `ExtensionContextActions` is likewise silent.
- `TUI` (`pi-tui/dist/tui.d.ts:223`) has no scrolling members. `ViewportTUI` (`:254`) adds only
  `setLayoutRoot`. Scroll methods live on the concrete `TuiAltScreen`.
- The transcript is `ChatViewport.transcript: ScrollView` (`dist/modes/interactive/chat-viewport.d.ts`),
  kept as the private `transcriptScrollView` field (`interactive-mode.js:249`, assigned at `:720`).
  Extensions never receive a handle to it.
- `TuiAltScreen` does expose `viewportTop` (`:84`), `getScreenLines()` (`:96`), and `scrollBy` /
  `scrollToTop` / `scrollToBottom` (`:109-111`), but there is no entry → row map, so a caller
  cannot compute a delta.

## Why the missing piece is small

The mapping is nearly there on both sides:

- Every message component is already constructed with the session entry id: `addMessageToChat`
  passes `options?.messageId` into `CustomMessageComponent`, `CompactionSummaryMessageComponent`
  and `BranchSummaryMessageComponent` (`interactive-mode.js:3260+`). Assistant/user/tool blocks
  likewise come from entries; only the id is not retained in an index.
- The scroll arithmetic already exists for search: `refreshSearch` (`tui-alt-screen.js:400-475`)
  reads `box.scrollContentLines`, then
  `scrollView.scrollTo(firstSegment.row - Math.floor(viewportHeight / 3), { disableFollow: true })`.
  `scrollToPrompt` does the same for the editor.
- `ScrollView` (`pi-tui/dist/components/scroll-view.d.ts:48`) is exported and has `scrollTop`,
  `viewportHeight`, `scrollTo`, `scrollBy`.

So the delta is an entry-id → component index, a layout-rect lookup for that component, and one
`scrollTo` call behind a public method.

Prompts already carry the id a caller needs: `turn_end` includes `messageEntryId` and
`toolResultEntryIds` (`dist/core/extensions/types.d.ts:848-855`).

## Workaround reviewed and rejected

Cast the widget factory's `tui` to `TuiAltScreen`, scan `getScreenLines()` for the turn's text,
then `scrollBy` the distance. No: only *rendered* rows exist, so the interesting entries — the ones
scrolled off-screen — cannot be found at all; rows repeat (identical tool headers), content wraps,
the panel's own rows pollute the scan, and the result is silently coupled to transcript styling.
A second-handle variant (`ctx.ui.transcript.scrollBy(rows)`) is insufficient for the same reason:
the caller still cannot compute `rows`.

## Prior art

- `earendil-works/pi#11847` — "New extension APIs: Widget placement and scrolling" (5 Nov 2026):
  asked for `ctx.ui.transcript.getViewport()`, `scrollToEntry(entryId)`, `scrollToEnd()`,
  `onViewportChange(cb)`, plus `setWidget(..., { placement: "aboveTranscript" })`. Auto-closed
  `NOT_PLANNED` by the new-contributor bot, not by a maintainer. Its author also reported building
  the feature by wrapping the private `layoutRoot` and `getPrimaryScrollView()`.
- Reference the issue rather than restating it; the narrow ask here is the reveal primitive alone.

## Filing notes (read before posting)

- `CONTRIBUTING.md` requires the **Contribution Proposal** template, a single screen of text, and
  "write in your own voice (do not use an LLM to generate text)". This file is the evidence pack,
  not issue prose — do not paste it.
- All issues from new contributors are auto-closed by default; a maintainer reopens or replies
  `lgtmi`/`lgtm`. Agent-generated issue volume is a permanent-block offence.
- Points worth making, in the proposal's three fields: **what** — `revealEntry(entryId)` returning
  whether it moved; **why** — a turn tree is only useful if a row can take you to the turn
  (prompt-panel: `surajt02/prompt-panel`); **how (optional)** — the message components already
  receive `messageId`, and `refreshSearch` already does the row→`scrollTo` arithmetic.

## Follow-up in prompt-panel

Once `revealEntry` exists, the change is contained:

1. Record `turn_end`'s `messageEntryId` on `TurnRecord` and carry it into `PastTurn` when the turn
   is archived — one short string per retained turn, so the 500-turn cap and its memory bound stay
   as they are.
2. Extend `PanelLayout` with `turnRows: { number, start, end }[]`, filled while `renderPanel`
   builds `content`, excluding marker rows the way the prompt range already does.
3. Claim the press on a turn **header** row only (tools keep selection/future per-tool actions),
   and call `revealEntry` on click. Keep the existing prompt-block click and the wheel
   fall-through untouched.
4. No keyboard path: no global binding, no `/panel` subcommand. Turn rows stay display-only
   everywhere except the header click.
