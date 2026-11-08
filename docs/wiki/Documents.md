# Documents

**Documents** keeps a copy of a team's Nessie documents in a folder on this
computer and keeps it up to date in both directions. Edit a file in the folder
and Nessie gets the change; change a document in Nessie and the file updates.

It syncs every document you can read in that team. There is nothing to pick.

## Turn it on

1. Open the **Documents** tab and pick the team from the **Team** list.
2. Turn on **Keep a copy of Sales · Acme's documents on this computer**.
3. Nessie Computer suggests the main folder (a *Nessie* folder in your
   Documents, or the one your other teams already use) and shows the team's
   subfolder inside it. To use another main folder, choose **Change…**.
4. If the folder already has files, it asks **Add these files to Nessie?** and
   says how many. Choose **Add and sync** or **Cancel**.
5. The first time, Nessie asks you to confirm: choose **Allow in Nessie**,
   which opens the right page in Nessie, then **Allow**. Nothing is copied
   before that.

The status line then shows **Up to date**, or **Syncing 12 files** while it works.

## Several teams

Each team has its own **Documents** switch, so you choose team by team. Pick
the team from the **Team** list, then turn its switch on or off; the other
teams aren't affected.

All teams can share one main folder. Each team gets its own subfolder inside
it, by organisation and then team:

```
Documents/Nessie/
  UnlikeOtherAI/
    Platform/
      My Documents/
      Website relaunch/
    Research/
      My Documents/
  Acme/
    Sales/
```

The tab shows where the selected team's files go, for example
*"Platform · UnlikeOtherAI's documents go in Nessie/UnlikeOtherAI/Platform"*.
Every team is offered the same main folder; choose **Change…** if you want a
team somewhere else. A team that already synced before this layout keeps its
existing folder.

## What syncs

- All documents you can read in the team: project and organisation documents,
  and your own (under *My Documents*).
- Documents you can only read appear read-only on the computer. Some formats
  that can't be edited as files (such as spreadsheets) are read-only too.
- Agents' private documents are theirs, not yours, and don't sync.

Documents needs a computer that is yours alone. If the computer is shared with
the whole team in Nessie, the tab says **Not available on a shared computer**.

## Everyday use

| Button | What it does |
|---|---|
| **Open folder** | Opens the sync folder |
| **Pause sync** / **Resume sync** | Stops and restarts copying; changes wait |
| **Deleted files…** | Files sync removed from the folder, kept for 30 days. **Restore** puts one back. |
| **Change…** | Moves sync to another folder |

## When something needs you

| You see | What to do |
|---|---|
| **Files to check** | The same file changed in both places. Choose **Use my version**, **Use Nessie's version** or **Keep both**. **Show in folder** opens it first. |
| **Delete in Nessie too?** | You deleted many files at once in the folder. Choose **Restore files** to bring them back, or **Delete in Nessie too** if you meant it. |
| **Folder missing — choose it again** | The folder was moved or deleted. Nothing was deleted in Nessie. Choose it in its new place. |
| **Disk full** | Free some space. Sync tries again every minute. |
| **Offline** | Changes are kept and sent when the computer is back online. |
| **Waiting for you to allow it again in Nessie** | Your access changed. Choose **Allow in Nessie**. |

The menu bar or notification-area icon turns amber when Documents needs you.

## Turn it off

Turn the switch off. The folder and its files stay on the computer; nothing is
deleted in Nessie.

## On the command line

```sh
nessie-computer documents on --team "Sales · Acme" --folder ~/Documents/Nessie
nessie-computer documents status --team "Sales · Acme"
nessie-computer documents conflicts --team "Sales · Acme"
nessie-computer documents deleted --team "Sales · Acme"
nessie-computer documents off --team "Sales · Acme"
```
