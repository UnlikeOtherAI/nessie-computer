# Add a team

Adding a team lets that team's agents use this computer. It takes one code:
the computer shows it, you type it into Nessie within 5 minutes. There is no
address to type.

## In the app

1. Open Nessie Computer. The first time, it shows a code straight away.
   Later, open the **Team** list at the top and choose **＋ Add another team**
   (or **Add another team…** in the menu bar / notification-area menu).
2. Choose **Copy** next to the 8-digit code.
3. Choose **Open Nessie to finish**. Nessie opens on **Computers → Add a
   computer** with the code filled in.
4. Check the team at the top of Nessie's page: the computer is added to the
   team you are in.
5. Nessie shows this computer's name and system. If it's this computer,
   choose **Connect**.

The new team appears in the **Team** list. If 5 minutes pass, choose **Get a
new code**.

## On the command line

```sh
$ nessie-computer add
Code: 4821 9037   (5 minutes)
In Nessie, open Computers, choose Add a computer and enter the code.
Waiting for Nessie…
Connected to Sales · Acme.
```

`nessie-computer connect` does the same. See
[Who runs your teams](Command-line.md#who-runs-your-teams).

## Your organisation runs its own Nessie

Only for organisations with their own Nessie server. Choose **Use your
organisation's own Nessie server**, enter the address and choose **Get code**,
or run `nessie-computer add --server https://nessie.example.com`.

## What a new team can use

- **Folders:** a *Nessie* folder in your home folder.
- **Programs:** apps from UnlikeOtherAI, Claude Code, Codex and T3 Code.
  Anything else, agents ask you first. See [Programs](Programs.md).
- **Local apps:** every app on the computer that agents can talk to.
- **Claude Code and Codex:** available for the agents' AI if installed and signed in.
- **Websites:** none.

Change any of this on **Access**. Who in your team may send work here is set
on the computer's page in Nessie.

## If you didn't expect a team

Pick it in the **Team** list, open **Settings** and choose **Disconnect…**.
