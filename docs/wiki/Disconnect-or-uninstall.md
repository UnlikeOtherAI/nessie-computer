# Disconnect or uninstall

## Disconnect a team

Disconnecting ends one team's connection to this computer for good.

1. On **Overview**, choose **Disconnect…** on the team's card.
2. Nessie Computer says what will happen: the team's settings on this computer
   and any file changes you haven't approved yet are deleted. Your own files
   stay as they are.
3. Choose **Disconnect**.

Nessie then shows the computer as disconnected for that team. If the computer
is offline and can't tell Nessie, Nessie Computer says so; remove the computer
on its page in Nessie as well.

To use the team again, [connect it](Add-this-computer) with a new code.

To stop for a while instead, use [Pause](Pause-and-resume).

## Remove the computer in Nessie

On the computer's page in Nessie, choose **Remove from Nessie**. Nessie Computer
then shows the team as disconnected; choose **Disconnect…** there to clear its
settings.

## Uninstall

Disconnect every team first, so Nessie knows the computer is gone.

- **Mac:** quit Nessie Computer from its menu, then move it from Applications
  to the Bin.
- **Windows:** **Settings → Apps → Installed apps → Nessie Computer →
  Uninstall**.
- **Linux:** `sudo apt remove nessie-executor` or `sudo dnf remove nessie-executor`.

Uninstalling leaves your own files and the sync folder alone.
