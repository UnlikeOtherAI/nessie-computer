# Pause and resume

**Pause** stops agents starting anything new on this computer. It stays paused
until you choose **Resume** — closing the app, restarting the computer or
installing an update doesn't undo it.

## Pause everything

- **Menu bar / notification area:** choose **Pause**. With more than one team,
  choose **Pause → All teams**.

The icon turns grey and the menu says *"Paused"*. Choose **Resume** the same
way to let agents back in.

## Pause one team

- **Menu:** **Pause → Sales · Acme**.
- **Window:** pick the team in the **Team** list, open **Settings**, choose **Pause**.

Other teams carry on.

## What happens to work in progress

Work an agent already started finishes; nothing new starts. To stop it now,
quit Nessie Computer, or stop it in Nessie from the agent's conversation.

In Nessie, a paused computer shows **Paused on the computer**, and agents are
told it's paused instead of trying to use it.

## Pause, Turn off and Quit

| | Where | What it does | Undo |
|---|---|---|---|
| **Pause** | on this computer | Agents start nothing new here. The computer stays connected. | **Resume** on this computer |
| **Turn off for now** | in Nessie, on the computer's page | Nessie sends no work to the computer | **Turn on** in Nessie |
| **Quit** | on this computer | Closes Nessie Computer. On a Mac this stops all work here; on Windows, teams run by the background service keep running. | Open Nessie Computer |
| **Disconnect** | either | Ends the team's connection for good | [Connect the team](Add-a-team.md) again |

## On the command line

```sh
nessie-computer pause                          # every team
nessie-computer pause --team "Sales · Acme"    # one team
nessie-computer resume
nessie-computer status                         # shows "Paused"
```
