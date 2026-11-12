# Several teams on one computer

One computer can work for several Nessie teams. Each team is connected
separately and has its own settings, so what one team can use says nothing
about another.

## Connect another team

Open the **Team** list and choose **＋ Add another team**; see [Add a team](Add-a-team.md).
In Nessie, switch to the other team before you choose **Add a computer**,
because a computer is always added to the team you are in.

## The Team list

**Access**, **Documents**, **AI** and **Settings** show one team at a time. Pick it from the
**Team** list at the top of the tab, for example **Sales · Acme**. The heading
repeats the team's name so you always know whose settings you are changing.

**Settings** shows the selected team's Pause and Disconnect first, then the
settings for the whole computer.

| Per team (follows the Team list) | Whole computer |
|---|---|
| Folders, programs, websites, local apps, coding assistants | Open at login, restart if it stops |
| Documents (sync) and its folder | Software updates, notifications |
| ChatGPT plans and model servers | Pause every team (menu bar / notification area) |

## How teams are named

Everywhere — the window, the menu, notifications and the command line — a team
is shown as **team · organisation**, for example **Sales · Acme**. If two
teams have the same name on different Nessie servers, the server is added:
**Sales · Acme (nessie.example.com)**.

## Pausing one team

Pick the team, open **Settings** and choose **Pause**, or use **Pause → team**
in the menu. See [Pause and resume](Pause-and-resume.md).

## On the command line

Use `--team` with the team's name as shown, or its id:

```sh
nessie-computer teams
nessie-computer access show --team "Research · Acme"
```
