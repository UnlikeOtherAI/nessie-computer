# Nessie Computer console: the team tabs

The shared console (`packages/executor-console`) shows three tabs that follow
the team chosen in the dropdown: **Access**, **Documents** and **AI**. They
render into the shell's empty `#tab-access`, `#tab-documents` and `#tab-ai`
panels through the shell API `window.nc` ([contract §5.3](plans/2026-11-08-nessie-computer.md)).
Every string they show is registered with `nc.words.register` in en-GB, en-US,
cs, de, es, fr and it.

## Files

| File | Owns |
|---|---|
| `access.js` | The Access frame: heading, loading and Try again, section order, the shared row/switch helpers |
| `access-sections.js` | Folders, Websites, Local apps, Coding assistants (save when pressed) |
| `access-programs.js` | Programs: built-ins, owner-added programs, mode, Advanced patterns, explicit Apply |
| `access-words.js` | Access words (`access.*`) |
| `documents.js`, `documents-words.js`, `documents-reasons-words.js` | Documents (formerly `sync*.js`) |
| `ai.js`, `ai-words.js`, `chatgpt.js`, `chatgpt-words.js`, `inference-endpoints.js` | AI: ChatGPT plans and model servers |
| `team-drafts.js` | One draft per team, one save at a time, failures beside the control |
| `autosave.js` | The save queue |

The shell includes them in this order: `access.js`, `access-words.js`,
`access-sections.js`, `access-programs.js`, `documents-reasons-words.js`,
`documents-words.js`, `documents.js`, `ai.js`, `ai-words.js`, `chatgpt.js`,
`chatgpt-words.js`, `inference-endpoints.js`, with `autosave.js` and
`team-drafts.js` before them. `access-sections.js`, `access-programs.js` and
`documents-reasons-words.js` are additions to the list in contract §5.3.

## How a save behaves

A team has one draft, the whole configuration as the person has asked for it.
Every edit changes the draft; a save sends the whole draft through
`executor_configure`, which the runtime applies live (§4.1). Nothing here
restarts or reconnects a team, and nothing posts an OS notification. After a
save the tab reads the team's describe and shows that.

A failed save appears beside the control that asked for it, with the rule still
in force named ("Programs weren't saved: … Programs still allowed: no
programs.") and a **Try again** that resends the draft as it stands. A save
whose answer was lost is checked by reading the team again: if what it reports
is what was sent, it counts as saved.

## Access

- **Folders**: each row shows the folder, its path and the name agents use.
  Remove and Add folder… save at once. The runtime refuses an executor with no
  folder (`src/workspace-folders.ts`), so the last folder's Remove waits and the
  tab says to disconnect the team instead.
- **Programs**: "Currently allowed" is always the saved policy. Built-ins
  (Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code) are switches on
  `commandPolicy.trusted`; owner-added programs are `<program> *` allowlist
  patterns with Remove; Add program… takes a program name. The mode is "Only
  these programs" or "Any program", with "Programs run as you and can open any
  file you can." beside it. Advanced holds the pattern grammar (allowed and
  blocked). Edits gather until **Apply**, behind a "Now / After Apply" line;
  an invalid pattern blocks Apply. "No programs" (only listed, nothing on) is
  applied like any other state and announced beside the Apply line.
- **Websites**: `allowedOrigins`, https origins only, kept whether or not the
  agent browser is set up; a note says when it is not (`sandbox.browserConfigured`).
- **Local apps**: every entry of `describe.localApps` with a switch on
  `mcpPolicy.disabled`; a runtime without `localApps` is told to update.
- **Coding assistants** under "For developers": the existing-conversations
  switch and the Claude Code channel recipe dialog.

## Documents

One switch, "Keep a copy of {team}'s documents on this computer", the folder
with Change…, the honest status line, **Allow in Nessie** (the one deep-linked
step when Nessie requires it), Pause/Resume, Open folder, Deleted files, files
to check and deletions on hold. Behaviour and commands are unchanged from the
former Sync tab; only the frame, the words and the error placement changed.

## AI

ChatGPT plans: any number, each named (prefilled "ChatGPT plan N", editable)
and signed in with **Sign in with ChatGPT**. The restriction is one sentence
beside its checkbox; background-work consent is kept with its revision fence.
Model servers: name, address, where it runs, optional key.

## Verification

`node tray-windows/test/team-tabs-harness.mjs [--access-only|--documents-only|--ai-only]`
runs the headless journeys against the shell stand-in in
`tray-windows/test/team-tabs-shell.mjs` (a `window.nc` exactly as §5.3 names it)
and the host fake in `team-tabs-host.mjs`. Pictures land in
`.artifacts/team-tabs/after`; the base revision's pictures from the old
harness were kept under `.artifacts/team-tabs/before`. Local only; never in CI.
Once the shell lands, point the harness at the real `index.html` and delete the
stand-in.
