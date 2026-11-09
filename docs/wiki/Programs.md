# Programs

Programs decides which programs a team's agents may start on this computer —
in a terminal, as a command, or as a coding assistant. Open **Access**, pick
the team, then find **Programs**.

## The defaults

A new team may start these without asking:

| Program | Recognised by |
|---|---|
| **Apps from UnlikeOtherAI** | UnlikeOtherAI's code signature: Developer ID team `23B7GTLBN7` on a Mac, the *UnlikeOtherAI s.r.o.* publisher on Windows. A program that is only *named* like one doesn't count. Linux has no signature to check, so there the switch reads *Not available on this computer*; add those programs yourself. |
| **Claude Code** | the `claude` command on your computer |
| **Codex** | the `codex` command on your computer |
| **T3 Code** | T3 Code's command on your computer |

Each has a switch. Switch one off to stop agents starting it.

Teams connected before this version keep the rules they had.

## Choosing how strict to be

| Choice | Agents may start |
|---|---|
| **Only these programs** (default) | The switched-on defaults and the programs you add. Anything else, they ask. |
| **Any program** | Everything, except programs you block |
| **No programs** | Nothing. Switch off every default and leave the list empty. |

Changes to programs wait until you choose **Apply**. Before you apply, the tab
shows what changes, for example *"Adds `npm` · Removes Codex"*.
**Currently allowed** always shows the rules in force right now.

## When an agent asks to run a program

If an agent wants a program that isn't allowed, Nessie Computer asks you. You
see a notification, and the request appears in the **Needs you** strip at the
top of the window:

> **Sales agent** wants to run `npm`
> in Sales · Acme · test
> **Allow once** · **Always allow npm** · **Don't allow**

When Nessie doesn't say which agent asked, it reads *An agent wants to run `npm`*.

- **Allow once** runs it this time only.
- **Always allow npm** adds `npm` to the team's programs, so agents can run any
  `npm` command from now on.
- **Don't allow** refuses it. The agent is told you declined.

The agent waits up to 15 minutes for your answer; only that command waits, and
the agent's other work carries on. If you don't answer, the request is refused
and the agent is told nobody answered. Only someone using
this computer can answer; nobody can approve it from Nessie.

## Adding and blocking programs

- **Add program…** and type the program's name, for example `git` or `pnpm`.
  Agents may then run it with any arguments.
- To block a program, add it under **Advanced: patterns** → **Blocked programs**
  (or run `nessie-computer access programs block <program>`). It is refused
  even when everything else is allowed. Blocked always wins.
- **Remove** takes a program you added off the list.

### Advanced: patterns

Under **Advanced: patterns** you can be exact, one rule per line:

| Rule | Allows |
|---|---|
| `git status` | exactly `git status` |
| `git *` | `git` with anything after it |
| `npm run test *` | `npm run test` with anything after it |

A rule in **Blocked** is refused even if another rule allows it, for example
allow `git *` and block `git push *`.

## Things to keep in mind

- Programs run as you, so they can open any file you can. See
  [What agents can use](What-agents-can-use#the-one-thing-to-know).
- A program you allow can start other programs. Allowing a shell (such as
  `bash` or `powershell`) is the same as choosing **Any program**.
- Each team has its own programs list. Allowing `npm` for one team doesn't allow
  it for another.

## On the command line

```sh
nessie-computer access programs show --team "Sales · Acme"
nessie-computer access programs allow npm --team "Sales · Acme"
nessie-computer access programs block "git push *" --team "Sales · Acme"
nessie-computer access programs mode only-these --team "Sales · Acme"
nessie-computer requests list
nessie-computer requests always <request-id>
```

See [Command reference → access programs](Command-reference#access-programs).
