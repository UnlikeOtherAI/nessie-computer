# Nessie Computer

Nessie Computer lets the agents in your Nessie team work on your own computer.
They can read the folders you share, run the programs you allow and use the
apps installed there. You decide what they can use, on the computer itself,
and you can pause them at any time.

It runs on Mac, Windows and Linux. On a Mac it lives in the menu bar; on
Windows, in the notification area beside the clock; on Linux, as a service you
control from the command line.

**Full guides:** [Nessie Computer wiki](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Home.md)

## Get started

1. **Install it** on the computer the agents should use. Download the latest
   package from [Releases](https://github.com/UnlikeOtherAI/nessie-computer/releases):

   | Computer | Download | Needs |
   |---|---|---|
   | Mac | the `.dmg` file | Apple silicon (M1 or newer), macOS 15 or later |
   | Windows | the `.msi` file | Windows 10 or 11, 64-bit |
   | Linux | `.deb` (Debian, Ubuntu) or `.rpm` (Fedora) | x86-64 |

   Every computer needs its own copy. [Install guide](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Install-Nessie-Computer.md)

2. **Add a team.** Open Nessie Computer. It
   shows an 8-digit pairing code. In Nessie, open **Computers**, choose
   **Add a computer** and enter the code. Nessie shows this computer's name;
   choose **Connect**. [Step by step](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Add-a-team.md)

3. **Check what the team can use.** Pick the team in the **Team** list at the top
   and open **Access**.

## What a new team can use

| | By default | You can |
|---|---|---|
| **Folders** | A *Nessie* folder in your home folder | Add or remove folders |
| **Programs** | Apps from UnlikeOtherAI, Claude Code, Codex and T3 Code | Allow more, block some, or allow none |
| **Other programs** | Agents ask first. You choose **Allow once**, **Always allow** or **Don't allow** | Answer on the computer |
| **Local apps** | Every app on this computer that agents can talk to (MCP servers) | Switch any off |
| **Claude Code and Codex** | Available if installed and signed in on this computer | Switch either off in **AI** |
| **Websites** | None | Add the sites the agents' browser may open |

Programs run under your account, so a program you allow can open any file you
can. Allow programs you trust. [How access works](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/What-agents-can-use.md)

## Everyday tasks

- **Pause.** Choose **Pause** in the menu bar or notification-area menu. Agents
  start nothing new until you choose **Resume**, even after a restart.
  [Pausing](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Pause-and-resume.md)
- **Several teams.** Add each one. In the window, pick a team from the
  **Team** list, then change its access, documents and AI.
  [Several teams](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Several-teams-on-one-computer.md)
- **Keep your documents on the computer.** Open **Documents**, turn on
  **Keep a copy of {team}'s documents on this computer** and pick a folder.
  Every document you can read in that team syncs both ways.
  [Documents](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Documents.md)
- **Use your ChatGPT plan.** Open **AI**, choose **Add a ChatGPT plan** and sign
  in with ChatGPT. Give each connection a name you recognise. The computer opens OpenAI’s personal-agent OAuth sign-in and sends requests
  to OpenAI itself, including when connected to hosted Nessie. A blocked
  sign-in shows a red message with the next step. Choose the connection’s model
  in Nessie under **Connected accounts** → **AI plans**. On a Mac, idle team
  connections briefly reconnect for sign-in. If the browser attempt expires,
  start sign-in again from **AI**; your name is kept.
  [AI](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/AI.md)
- **Update on a Mac.** Nessie Computer replaces its runtime after its work ends.
  Stale records from an ended runtime do not require restarting macOS.
  [Settings and updates](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Settings-and-updates.md)
- **Disconnect a team.** Pick it in the **Team** list, open **Settings**, choose **Disconnect…**.
  [Disconnect or uninstall](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Disconnect-or-uninstall.md)

## Command line

Everything the app does, the `nessie-computer` command does too, with the same
words. (`nessie-executor` is the same command under its older name.)

```sh
nessie-computer status                      # what each team is doing
nessie-computer add                         # add a team: get a code
nessie-computer pause                       # pause every team
nessie-computer resume --team "Sales · Acme"
nessie-computer access show --team "Sales · Acme"
nessie-computer access programs allow "npm *" --team "Sales · Acme"
nessie-computer requests list               # programs waiting for your answer
nessie-computer help access                 # help for any command
```

Add `--json` to any command for scripts. [Command line guide](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Command-line.md)
· [Command reference](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Command-reference.md)

## Help

- [Troubleshooting](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/Troubleshooting.md)
- [What leaves your computer](https://github.com/UnlikeOtherAI/nessie-computer/blob/main/docs/wiki/What-leaves-your-computer.md)
- [Report a problem](https://github.com/UnlikeOtherAI/nessie-computer/issues)
- [Security model](SECURITY.md) · [Build from source](CONTRIBUTING.md)

## Licence

[FSL-1.1-ALv2](LICENSE): fair source. You may use, inspect, change and share it
for permitted purposes, including internal commercial use; competing commercial
offerings are restricted. Each version becomes available under Apache 2.0 two
years after its release. Bundled third-party components keep their own licences.

Error and crash reporting uses the standard Sentry SDKs; see [configuration and verification](docs/error-reporting.md).
