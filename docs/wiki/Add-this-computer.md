# Add this computer

Adding this computer to Nessie lets agents in one of your teams use it. It
takes one code: the computer shows it, you type it into Nessie within 5
minutes. There is no address to type.

You need Nessie Computer installed here, and a Nessie account in the team that
should use this computer.

## On a Mac or PC

1. Open Nessie Computer and choose **Add this computer** (on **Overview**, or
   **Add this computer…** in the menu bar / notification-area menu).
2. It shows an 8-digit code straight away, with a 5-minute countdown. Choose
   **Copy**.
3. Choose **Open Nessie to finish**. Nessie opens in your browser on
   **Computers → Add a computer** with the code already filled in. (Or open
   Nessie yourself, go to **Computers**, choose **Add a computer** and paste
   the code.)
4. Check Nessie shows the right team at the top of the page: the computer is
   added to the team you are in.
5. Nessie shows this computer's name and system, for example *"Alex's MacBook
   Pro · macOS"*. If it is this computer, choose **Connect**.
6. Back on the computer, **Overview** says *"Connected to Sales · Acme"* and
   lists what that team can now use.

A code works once. If 5 minutes pass, choose **Get a new code**.

## On the command line

```sh
$ nessie-computer add
Code: 4821 9037   (5 minutes)
In Nessie, open Computers, choose Add a computer and enter the code.
Waiting for Nessie…
Connected to Sales · Acme.
```

`nessie-computer connect` does the same. Where the Nessie Computer app is
installed (Windows, and Macs with the app), the app then runs the team. On a
Mac without the app it runs in the background and starts when you log in; on
Linux it starts at boot and keeps running after you log out. See
[Who runs your teams](Command-line#who-runs-your-teams).

## Add it to another team

Do the same again. In Nessie, switch to the other team first. Each team gets
its own settings on this computer; see
[Several teams on one computer](Several-teams-on-one-computer).

## Your organisation runs its own Nessie

Only for organisations with their own Nessie server. In the app, choose **Use
your organisation's own Nessie server**, enter the address your administrator
gave you (for example `https://nessie.example.com`) and choose **Get code**.
On the command line:

```sh
nessie-computer add --server https://nessie.example.com
```

Then continue from step 3, in your organisation's Nessie.

## What the team can use straight away

- **Folders:** a *Nessie* folder in your home folder, created for you.
- **Programs:** apps from UnlikeOtherAI, Claude Code, Codex and T3 Code. Agents
  ask before running anything else. See [Programs](Programs).
- **Local apps:** every app on the computer that agents can talk to.
- **Websites:** none.

Change any of this on **Access**. See [What agents can use](What-agents-can-use).

## If you didn't expect a team

Nessie Computer always says which team it was added to. If you didn't mean to,
choose **Disconnect…** on that team's card. Nothing else on the computer changes.

## Next

- [What agents can use](What-agents-can-use)
- [Who can send work here](Who-can-send-work-here)
- [Several teams on one computer](Several-teams-on-one-computer)
