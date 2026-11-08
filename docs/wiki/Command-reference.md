# Command reference

Every command is `nessie-computer <command> [options]`. `nessie-executor` is
the same command under its older name.

Options every command accepts:

| Option | Meaning |
|---|---|
| `--team <team>` | The team: its name as shown (`"Sales · Acme"`), a unique part of it (`Sales`), or its id. Optional when only one team is connected. |
| `--json` | Machine-readable output (one JSON document on standard output). |
| `--help` | Help for this command, with examples. Same as `nessie-computer help <command>`. |

Exit codes: `0` worked · `1` refused or failed (the message says why) · `2` the
command was typed wrong · `3` waiting timed out (for example `connect`).

---

## Overview

### `status`
What Nessie Computer and each team are doing, and anything that needs you.

```sh
nessie-computer status [--team <team>] [--json]
```
Each team shows **Working**, **Paused** or **Not connected** (with the reason).

### `teams`
List connected teams: label, status, server and id.

```sh
nessie-computer teams [--json]
```

### `who`
Who can send work to this computer for a team: agents, people and projects.
Read from Nessie each time; nothing is stored.

```sh
nessie-computer who [--team <team>] [--json]
```

---

## Connecting

### `connect`
Get a pairing code for a new team and wait until it's entered in Nessie.

```sh
nessie-computer connect [--server <https://address>] [--no-wait] [--json]
```
- `--server` — your organisation's own Nessie (default `https://api.nessie.works`).
- `--no-wait` — print the code and return; `status` shows when it's done.

On Linux, a connected team starts at boot and keeps running after you log out.

### `disconnect`
End a team's connection to this computer and delete its settings here. Your
own files stay as they are.

```sh
nessie-computer disconnect --team <team> [--yes]
```
Without `--yes` it asks first.

---

## Pausing

### `pause` / `resume`
Pause stops agents starting anything new; work already running finishes. It
lasts until you resume, across restarts and updates.

```sh
nessie-computer pause  [--team <team>]     # without --team: every team
nessie-computer resume [--team <team>]
```

---

## Access

### `access show`
Everything a team can use.

```sh
nessie-computer access show [--team <team>] [--json]
```

### `access folders`
```sh
nessie-computer access folders [list]          [--team <team>]
nessie-computer access folders add <path>      [--name <name>] [--team <team>]
nessie-computer access folders remove <name|path> [--team <team>]
```
`--name` sets the name agents use (default: from the folder's name).

### `access programs`
```sh
nessie-computer access programs [show]            [--team <team>]
nessie-computer access programs allow <program|pattern> [--team <team>]
nessie-computer access programs block <program|pattern> [--team <team>]
nessie-computer access programs remove <program|pattern> [--team <team>]
nessie-computer access programs mode only-these|any|none  [--team <team>]
nessie-computer access programs default <unlikeotherai|claude-code|codex|t3-code> on|off [--team <team>]
```
- A bare program name (`npm`) means the program with any arguments (`npm *`).
- Patterns: `git status` exactly; `git *` with anything after it. Blocked wins.
- `mode none` switches every default off and clears the list.
- Every change shows what changed, then applies it at once.

### `access websites`
```sh
nessie-computer access websites [list]       [--team <team>]
nessie-computer access websites add <https://site> [--team <team>]
nessie-computer access websites remove <https://site> [--team <team>]
```

### `access local-apps`
Apps on this computer agents can talk to (MCP servers).

```sh
nessie-computer access local-apps [list]   [--team <team>]
nessie-computer access local-apps on|off <name> [--team <team>]
nessie-computer access local-apps all on|off    [--team <team>]
```
`all on` uses every installed local app, including new ones (the default).

### `access coding-assistants`
```sh
nessie-computer access coding-assistants [show] [--team <team>]
nessie-computer access coding-assistants conversations on|off [--team <team>]
nessie-computer access coding-assistants claude-setup [--team <team>]
```
`conversations` lets agents read and message your Claude Code and Codex
conversations. `claude-setup` prints the steps to let Claude Code receive
messages from Nessie.

---

## Program requests

When an agent asks to run a program that isn't allowed.

```sh
nessie-computer requests [list]   [--team <team>] [--json]
nessie-computer requests allow-once <id>
nessie-computer requests always <id>        # adds the program to the team's programs
nessie-computer requests deny <id>
nessie-computer requests watch    [--team <team>]   # prints new requests as they arrive
```
A request waits up to 2 minutes, then is refused.

---

## Documents

```sh
nessie-computer documents [status]   [--team <team>]
nessie-computer documents on         [--folder <path>] [--add-existing-files] [--team <team>]
nessie-computer documents off        [--team <team>]
nessie-computer documents folder <path> [--team <team>]
nessie-computer documents pause|resume  [--team <team>]
nessie-computer documents conflicts  [--team <team>]
nessie-computer documents resolve <id> mine|nessie|both [--team <team>]
nessie-computer documents deleted    [--team <team>]
nessie-computer documents restore <id> [--team <team>]
nessie-computer documents held       [--team <team>]       # large deletions waiting for you
nessie-computer documents held restore|delete [--team <team>]
```
`on` prints the Nessie page to open if Nessie asks you to allow it.

---

## AI

### `ai plans` — ChatGPT plans
```sh
nessie-computer ai plans [list]            [--team <team>]
nessie-computer ai plans add [<name>]      [--team <team>]   # opens ChatGPT sign-in in your browser
nessie-computer ai plans rename <plan> <new name> [--team <team>]
nessie-computer ai plans sign-in <plan>    [--team <team>]
nessie-computer ai plans background <plan> on|off [--team <team>]
nessie-computer ai plans disconnect <plan> [--team <team>]
```

### `ai servers` — model servers
```sh
nessie-computer ai servers [list]          [--team <team>]
nessie-computer ai servers add <name> <address> [--where this-computer|network] [--key-stdin] [--team <team>]
nessie-computer ai servers check           [--team <team>]
nessie-computer ai servers remove <name>   [--team <team>]
```
`--key-stdin` reads an API key from standard input so it never appears in your
shell history.

---

## Settings

```sh
nessie-computer settings                       # everything below
nessie-computer settings login on|off          # open at login
nessie-computer settings auto-restart on|off   # restart a team if it stops
nessie-computer settings updates               # version and update status
nessie-computer settings updates check
nessie-computer settings updates install
nessie-computer settings updates automatic on|off
nessie-computer settings logs                  # prints the logs folder
```

---

## Help and version

```sh
nessie-computer help [<command>]
nessie-computer --version
```

---

## Plumbing

Lower-level commands the apps and services use. They take a team's state
folder (`--state-dir`) and JSON on standard input or output. Their help is in
`nessie-computer help plumbing`. Prefer the commands above in your own scripts.

| Command | Used for |
|---|---|
| `describe --state-dir <dir>` | One team's full settings as JSON |
| `configure --configuration-input-stdin --state-dir <dir>` | Save a team's settings from JSON |
| `pairing-start`, `pairing-status`, `pairing-cancel` | The app's Connect a team dialog |
| `serve`, `connect`, `heartbeat --state-dir <dir>` | Running a team (services and the apps) |
| `pause`, `resume --state-dir <dir>` | The app's Pause |
| `program-requests`, `program-request answer --state-dir <dir>` | The app's program requests |
| `audience --state-dir <dir>` | The app's "Who can send work here" |
| `sync --state-dir <dir> …` | The app's Documents tab |
| `local-inference endpoint …` | The app's model servers |
| `enable`, `disable`, `autorestart` | The Linux service |
| `configure-browser`, `configure-codex` | Setting up the agents' browser and sandbox |
| `serve-*`, `coding-session-host`, `deeptest-*` | Started by Nessie Computer itself |
