# Command reference

Every command is `nessie-computer <command> [options]`. `nessie-executor` is
the same command under its older name.

The commands reach every team on the computer: the ones the app runs, the ones
the command line runs, and on Windows the ones the background service runs.

Options every command accepts:

| Option | Meaning |
|---|---|
| `--team <team>` | The team: its name as shown (`"Sales · Acme"`), a unique part of it (`Sales`), or its id. Optional when only one team is connected. |
| `--json` | Machine-readable output (one JSON document on standard output). |
| `--help` | Help for this command, with examples. Same as `nessie-computer help <command>`. |

Exit codes: `0` worked · `1` refused or failed (the message says why) · `2` the
command was typed wrong · `3` waiting timed out (for example `add`).

---

## Overview

### `status`
What Nessie Computer and each team are doing, and anything that needs you.

```sh
nessie-computer status [--team <team>] [--json]
```
Each team shows **Working**, **Paused**, **Needs you** or **Not connected** (with the reason).

### `teams`
List connected teams: label, status, server and id.

```sh
nessie-computer teams [--json]
```
Names are kept on this computer and read again from Nessie once they are an
hour old, so a team keeps its name while Nessie can't be reached.

### `who`
Who can send work to this computer for a team: agents, people and projects.
Read from Nessie each time; nothing is stored.

```sh
nessie-computer who [--team <team>] [--json]
```

---

## Adding this computer

### `add`
Add this computer to a team: get a code from Nessie and wait until it's entered
under **Computers → Add a computer**, within 5 minutes. `connect` is the same
command under its older name.

```sh
nessie-computer add [--server <https://address>] [--no-wait] [--json]
```
- `--server` — only for an organisation with its own Nessie (default `https://api.nessie.works`).
- `--no-wait` — print the code and return; `status` shows when it's done.

Who runs the new team (see [Who runs your teams](Command-line#who-runs-your-teams)):

- **Windows, or a Mac with the Nessie Computer app:** the app. `add` opens
  it if it isn't open.
- **A Mac without the app:** a background service that starts when you log in.
- **Linux:** a service that starts at boot and keeps running after you log out.

### `disconnect`
End a team's connection to this computer and delete its settings here. Your
own files stay as they are.

```sh
nessie-computer disconnect --team <team> [--yes]
```
Without `--yes` it asks first. A team the app is running is disconnected in the
app, or after you quit it.

---

## Pausing

### `pause` / `resume`
Pause stops agents starting anything new; work already running finishes. It
lasts until you resume, across restarts and updates.

```sh
nessie-computer pause  [--team <team>]     # without --team: every team
nessie-computer resume [--team <team>]     # without --team: every team
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
`--name` sets the name agents use (default: from the folder's name). Keep at
least one folder; to end a team's access, disconnect it.

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
nessie-computer access local-apps remove <name> [--team <team>]
```
- `all on` uses every installed local app, including new ones (the default).
- `all off` switches off every local app found now; apps installed later start
  switched on.
- `remove` takes away a local app you added yourself. Apps found on the
  computer are switched off instead.

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
An id may be shortened to its first characters while it stays unique. A
request waits up to 15 minutes, then is refused. Only the command that asked
waits; the agent's other work carries on.

---

## Now working

What agents are doing on this computer, one session per agent and team, as
Overview shows it.

```sh
nessie-computer sessions [list] [--team <team>] [--json]
nessie-computer sessions stop <id> [--team <team>]   # ends that session's work here
```
Each command shows as running, waiting to start, or waiting for you (a program
request). `stop` ends everything the session is doing on this computer and
tells Nessie; other sessions keep working. An id may be shortened to its first
characters while it stays unique.

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
`on` prints the Nessie page to open if Nessie asks you to allow it. On Windows,
documents are kept only for teams connected under your own account, not for
teams the background service runs.

---

## AI

### `ai local` — Claude Code and Codex on this computer
```sh
nessie-computer ai local [list]            [--team <team>]
nessie-computer ai local on|off claude-code|codex [--account <account>] [--team <team>]
nessie-computer ai local add claude-code|codex <name> [--team <team>]   # runs the program's own sign-in
nessie-computer ai local sign-in <account> [--team <team>]
nessie-computer ai local remove <account> [--team <team>]
```
`list` shows each program, the account it's signed in to and whether it's
available to the team's agents. A program that is installed and signed in is
on for every team by default; `off` stops that team's agents using it and `on`
undoes that. Agents use the program's own sign-in, and Nessie decides whether
only you or the whole team may. `add` makes another account on this computer,
on by default, and runs the program's own sign-in in this terminal; `--account`
picks it for `on` and `off`. `remove`
signs it out and deletes it. Not on Windows teams the background service runs:
the service can't use your sign-in.

### `ai plans` — ChatGPT plans
```sh
nessie-computer ai plans [list]            [--team <team>]
nessie-computer ai plans add [<name>] [--yes] [--team <team>]   # opens ChatGPT sign-in in your browser
nessie-computer ai plans rename <plan> <new name> [--team <team>]
nessie-computer ai plans sign-in <plan> [--yes] [--team <team>]
nessie-computer ai plans background <plan> on|off [--team <team>]
nessie-computer ai plans disconnect <plan> [--team <team>]
```
While a ChatGPT plan is signed in, agents can't open terminals or coding tools
under your account. `add` and `sign-in` ask you to accept that first; `--yes`
accepts it without asking.

On Windows the Nessie Computer service keeps ChatGPT plans, as in the app. The
first `add` for a team connects its ChatGPT plan connection: Windows asks you to
allow it, then this computer shows one more code to enter in Nessie under
**Computers → Add a computer**.

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
nessie-computer settings login [on|off]        # open Nessie Computer when I log in
nessie-computer settings auto-restart [on|off] # restart a team if it stops
nessie-computer settings updates               # version and update status
nessie-computer settings updates check
nessie-computer settings updates install
nessie-computer settings updates automatic on|off
nessie-computer settings logs                  # prints where the logs are
```
`login` and `auto-restart` are the app's **Open Nessie Computer when I log in**
and **Restart a team if it stops**: change either here or in the app's
Settings. Where no app runs the teams (Linux, and Macs without the app),
`auto-restart` sets each command-line service, and `login` isn't available. The
Windows background service always starts its own teams again.

---

## Help and version

```sh
nessie-computer help [<command>]
nessie-computer help plumbing
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
| `pairing-start`, `pairing-status`, `pairing-cancel` | The app's Add this computer dialog |
| `serve`, `connect`, `heartbeat --state-dir <dir>` | Running a team (services and the apps) |
| `pause`, `resume --state-dir <dir>` | The app's Pause |
| `program-requests`, `program-request answer --state-dir <dir>` | The app's program requests |
| `audience --state-dir <dir>` | The app's "Who can send work here" |
| `sessions`, `session stop --state-dir <dir>` | The app's Now working and its Stop |
| `sync --state-dir <dir> …` | The app's Documents tab |
| `local-inference connections …` | The app's model servers |
| `local-inference engines …` | The app's Claude Code and Codex rows |
| `personal-chatgpt-local --state-dir <dir>` | The app's ChatGPT plans |
| `unpair --state-dir <dir>` | The app's Disconnect |
| `team-names --state-dir <dir> …` | The apps' team names: one request per server for every team listed |
| `enable`, `disable`, `autorestart` | The Linux service |
| `configure-browser`, `configure-codex` | Setting up the agents' browser and sandbox |
| `serve-*`, `coding-session-host`, `deeptest-*` | Started by Nessie Computer itself |
