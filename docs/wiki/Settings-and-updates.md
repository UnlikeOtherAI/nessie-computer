# Settings and updates

**Settings** holds what applies to the whole computer, for every team.

| Setting | What it does | Default |
|---|---|---|
| **Open Nessie Computer when I log in** | Starts it when you sign in to the computer | On |
| **Restart a team if it stops** | If a team's connection stops without you stopping it, Nessie Computer starts it again. A paused team stays paused. | On |
| **Notifications** | Lets Nessie Computer tell you when an agent asks to run a program or something needs you | Asked the first time it's needed |
| **Software updates** | See below | |
| **Help** | Version, **Open logs folder**, and where to find the command line | |

## Software updates

Settings shows the **Installed version** and whether a newer one is available.

- **Install updates automatically:** when on, updates install by themselves.
  They wait for agents' work to finish first. Your teams, access and sign-ins
  stay as they are. While an update waits, new work can't start for up to an
  hour. If work is still running after that, teams carry on and the update
  tries again about six hours later.
- When it's off, Nessie Computer tells you when an update is ready. Choose
  **Update to {version}** or **Remind me in 24 hours**.
- **Check for updates** checks now.

On a Mac, updates need Nessie Computer's background helper. If Settings shows
**Set up updates**, choose it and switch the helper on in System Settings.

If the window or Settings says **Allow Nessie Computer in System Settings to
finish updating**, macOS is waiting for you to allow the helper. Choose **Open
Login Items** and switch Nessie Computer on there; updates then finish by
themselves.

If the window or Settings says **Updates can't start:** followed by a reason,
macOS refused to register the update helper, so it isn't running yet. Nessie
Computer asks macOS again by itself: after 15 seconds, then less often, at
least every 15 minutes, for as long as it takes. **Try again** asks at once. If
macOS still refuses, Login Items opens: switch Nessie Computer on there.

If the window or Settings says **Updates are stuck — teams can't start**, the
helper isn't answering. Nessie Computer restarts it by itself, and again later
while it stays stuck: after 15 minutes, then less often, at least every four
hours. **Restart updates** does it at once. Your teams, access and sign-ins stay
on the computer. When you install a newer Nessie Computer on a Mac, it restarts
the helper by itself, so the helper picks up the new version.

On a Mac, the helper swaps in the new version's runtime only once no other
Nessie app could start the old one. An older Nessie desktop app keeps it
waiting until you quit that app; the helper finishes by itself once you do.

If you installed with a package manager (such as `apt` or `dnf`), update with
that tool; Settings says so.

## On the command line

```sh
nessie-computer settings login on               # open Nessie Computer when I log in
nessie-computer settings auto-restart on
nessie-computer settings updates            # version and update status
nessie-computer settings updates check
nessie-computer settings updates automatic off
nessie-computer settings logs               # where the logs are
```

`login` and `auto-restart` change the same two switches as this tab. On Linux,
and on a Mac without the app, `auto-restart` sets each team's command-line
service instead.
