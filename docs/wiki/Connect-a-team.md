# Connect a team

Connecting a team lets that team's agents send work to this computer. You do it
once per team, with an 8-digit pairing code that the computer shows and you
enter in Nessie.

You need: Nessie Computer installed on this computer, and a Nessie account in
the team you want to connect.

## On a Mac or PC

1. Open Nessie Computer and choose **Connect a team** (on **Overview**, or in
   the menu bar / notification-area menu).
2. The computer shows an 8-digit **pairing code** and how long it stays valid
   (10 minutes). Choose **Copy**.
3. Choose **Open Nessie to finish**. Nessie opens in your browser on
   **Computers → Add a computer** with the code filled in. (Or open Nessie
   yourself, go to **Computers**, choose **Add a computer** and paste the code.)
4. Make sure Nessie shows the team you want at the top of the page. A computer
   is always added to the team you are in.
5. Nessie shows this computer's name and system, for example *"Alex's MacBook
   Pro · macOS"*. If it is this computer, choose **Connect**.
6. Back on the computer, **Overview** shows *"Connected to Sales · Acme"* and
   what the team can now use.

The code works once. If it runs out, choose **Get a new code**.

## What the team can use straight away

- **Folders:** a *Nessie* folder in your home folder, created for you. Agents'
  own browser and sandbox work with exactly one folder, so add others only if
  you need them.
- **Programs:** apps from UnlikeOtherAI, Claude Code, Codex and T3 Code. Agents
  ask before running anything else. See [Programs](Programs).
- **Local apps:** every app on the computer that agents can talk to.
- **Websites:** none.

Change any of this on **Access**. See [What agents can use](What-agents-can-use).

## Your organisation runs its own Nessie

In the Connect a team dialog choose **Use your organisation's own Nessie
server**, enter the address your administrator gave you (for example
`https://nessie.example.com`) and choose **Get code**. Then continue from step 3.

## From the command line

```sh
nessie-computer connect
```

The command prints the code and waits. Enter the code in Nessie as above. When
Nessie accepts it, the command prints the team it connected to and starts it:
in the Nessie Computer app where it is installed, otherwise as a background
service. See [Command line](Command-line#connect-a-linux-server).

## If you didn't expect a team

Nessie Computer always tells you which team it connected to. If it isn't one
you meant to connect, choose **Disconnect…** on that team's card. Nothing else
on the computer changes.

## Next

- [What agents can use](What-agents-can-use)
- [Who can send work here](Who-can-send-work-here) — Nessie decides which agents and people
- [Several teams on one computer](Several-teams-on-one-computer)
