# What agents can use

The **Access** tab decides what a team's agents may use on this computer. Each
team has its own access: pick the team from the **Team** list at the top of
the tab first.

Access has five parts:

| Part | What it means | New team gets |
|---|---|---|
| [Folders](#folders) | Folders agents can read, and prepare changes to | The *Nessie* folder |
| [Programs](Programs) | Programs agents can start | Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code |
| [Websites](#websites) | Sites the agents' own browser may open | None |
| [Local apps](#local-apps) | Apps on this computer agents can talk to (MCP servers) | All of them |
| [Coding assistants](#coding-assistants) | Your existing Claude Code and Codex conversations | As set when you connected |

Changes take effect straight away. Agents already working keep going under the
new rules; nothing restarts.

## The one thing to know

**Programs run as you.** A program an agent starts runs under your account on
this computer, with your access. A program you allow can open any file you can
open, not only the shared folders. The folder list limits what agents read
*directly*; the program list limits what they can *run*. Allow programs you
trust, and let agents ask for the rest.

## Folders

Agents can read the files in these folders and prepare changes to them. A
change to a real file is shown to you for approval first.

- **Add folder…** opens the folder picker. The folder is shared with the
  selected team only.
- **Remove** stops sharing a folder. The folder and its files stay where they are.
- Each row shows the name agents use for the folder (for example `nessie` or
  `projects`), so you can recognise it in an agent's message.

Agents' own browser, sandboxed commands and Codex sessions work with exactly
one folder. With two or more, those refuse to start until you remove the
extras. Reading files, terminals and local apps keep working.

Folders are not the same as [Documents](Documents). Folders are your files,
shared with agents. Documents is a copy of your team's Nessie documents kept on
this computer.

## Websites

Agents have their own browser, separate from yours, which opens only the sites
you list here.

- **Add website…** and enter an address starting with `https://`, for example
  `https://github.com`. The whole site is allowed.
- **Remove** takes a site off the list.

If the agents' browser isn't set up on this computer yet, the list is kept and
used once it is.

## Local apps

Local apps are programs on this computer that agents can talk to directly, such
as Kelpie. (Developers call them MCP servers.) Nessie Computer finds the ones
that are installed, including those set up for Claude Code, Codex and T3 Code
on this computer, and lets agents use all of them.

Each app has a switch. Switch one off and agents stop using it; install a new
one and it appears, switched on. The details of how an app starts stay on this
computer; Nessie only learns its name. An app that keeps failing to start is
tried again less and less often, up to every 30 minutes (see
[Troubleshooting](Troubleshooting)).

## Coding assistants

Under **For developers**:

- **Let agents read and message your Claude Code and Codex conversations.** When
  on, agents in this team can read the Claude Code and Codex conversations
  running on this computer and send them messages. Turning it off leaves those
  conversations running.
- **Set up Claude Code to receive messages from Nessie** shows the two steps to
  run Claude Code so Nessie can message it. Claude Code still asks for your
  permission as usual.

## Who decides what

| Decided on this computer (Nessie Computer) | Decided in Nessie |
|---|---|
| Folders, programs, websites, local apps, coding assistants | Which agents, people and projects may send work here |
| Pause and resume | Turning the computer off in Nessie, sharing it |

Nessie can't widen what you allow here. See
the computer's page in Nessie.
