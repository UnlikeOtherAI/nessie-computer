# Command line

`nessie-computer` does everything the Nessie Computer window does, with the
same words. Use it on Linux, over SSH, or in scripts. On a Mac or PC it is
installed with the app; the app and the command line control the same teams
and settings.

`nessie-executor` is the same command under its older name. Scripts that use it
keep working.

## How commands are built

Commands follow the window:

| Window | Command |
|---|---|
| Overview | `nessie-computer status`, `teams`, `who` |
| Settings → Help | `nessie-computer help`, `--version` |
| Connect a team / Disconnect | `nessie-computer connect`, `disconnect` |
| Pause / Resume | `nessie-computer pause`, `resume` |
| Access tab | `nessie-computer access …` (`folders`, `programs`, `websites`, `local-apps`, `coding-assistants`) |
| Documents tab | `nessie-computer documents …` |
| AI tab | `nessie-computer ai plans …`, `ai servers …` |
| Settings tab | `nessie-computer settings …` |
| Needs you → program requests | `nessie-computer requests …` |

- `--team` picks the team, by its name as shown (`"Sales · Acme"`, or just
  `Sales` when that's unambiguous) or by its id. With one team you can leave it out.
- `--json` prints machine-readable output on every command.
- `nessie-computer help` lists commands; `nessie-computer help <command>` (or
  `<command> --help`) explains one, with examples.
- Exit code 0 means it worked. Any other code means it didn't, and the message
  says why: 1 refused or failed, 2 typed wrong, 3 waiting timed out.

## Tutorial: check a computer

```sh
$ nessie-computer status
Nessie Computer 1.1.0 — working for 2 teams

  Sales · Acme        Working
  Research · Acme     Paused

Needs you: Sales agent wants to run `npm test` (Sales · Acme)
  nessie-computer requests list
```

```sh
$ nessie-computer access show --team Sales
Sales · Acme can use:
  Folders     nessie (/home/me/Nessie)
  Programs    Only these: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code
  Websites    none
  Local apps  all installed (kelpie)
  Coding assistants  can read and message Claude Code and Codex conversations
```

## Tutorial: connect a Linux server

On Windows, connect a team in the Nessie Computer app. Teams its background
service runs can't be changed from the command line yet; use the app for them.

On the server (as the user the agents should run as):

```sh
$ nessie-computer connect
Pairing code: 4821 9037   (valid for 10 minutes)
In Nessie, open Computers and choose Add a computer, then enter the code.
Waiting for Nessie…
Connected to Sales · Acme.
It starts at boot and keeps running after you log out.
```

For your organisation's own Nessie server:

```sh
nessie-computer connect --server https://nessie.example.com
```

Then decide what it may use:

```sh
nessie-computer access folders add /srv/projects --team Sales
nessie-computer access programs allow git --team Sales
nessie-computer access programs allow "pnpm *" --team Sales
nessie-computer access programs block "git push *" --team Sales
```

## Tutorial: answer program requests from a terminal

```sh
$ nessie-computer requests list
ID        TEAM          AGENT         PROGRAM   WAITS
7f3a9c21  Sales · Acme  Sales agent   npm test  1 min 42 s

$ nessie-computer requests allow-once 7f3a9c21
$ nessie-computer requests always 7f3a      # allows `npm` from now on
$ nessie-computer requests deny 7f3a
```

## Tutorial: scripts

Every command takes `--json`:

```sh
# Pause every team before a backup, resume after.
nessie-computer pause
run-backup
nessie-computer resume

# Is anything waiting for me?
nessie-computer requests list --json | jq length
```

## For the apps and scripts (plumbing)

The apps use a few lower-level commands (`describe`, `configure
--configuration-input-stdin`, `serve`, …) that take a team's state folder
(`--state-dir`) and JSON. They are listed under
[Command reference → Plumbing](Command-reference#plumbing). Prefer the commands
above in your own scripts; they stay stable as the app changes.

See the full [Command reference](Command-reference).
