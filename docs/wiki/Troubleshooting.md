# Troubleshooting

Start with the menu bar or notification-area icon and the first line of its
menu. It always says what is going on.

| Icon | Menu says | Meaning |
|---|---|---|
| Plain | **Working for 2 teams** | Connected. Agents you allow can use the computer. |
| Grey | **Paused** | You paused it. Choose **Resume**. |
| Grey | **No team connected** | Choose **＋ Add another team** in the **Team** list. |
| Grey | **Not connected — open Nessie Computer** | A team couldn't connect. Open the window; the **Needs you** strip says why and offers a fix. |
| Amber | **Needs you: …** | Something waits for you: a program request, a Documents question, or a problem with a fix. Choose the line. |
| Amber (Mac) | **Updates are stuck — teams can't start** | The update helper isn't answering, so no team can start. Open Nessie Computer and choose **Restart updates**. |
| Red (Windows) | **Background service isn't running** | Choose **Start it**, or reinstall Nessie Computer. |

Every problem in the **Needs you** strip comes with one button that fixes it. **Details**
underneath shows the technical message, which helps if you contact support.

## Common problems

### I can't find the icon
- **Mac:** a crowded menu bar hides icons, especially beside the camera notch.
  Open Nessie Computer from Applications or Spotlight; the window opens.
- **Windows:** check the hidden icons (**^** by the clock). Drag the icon out to
  keep it visible. Or open Nessie Computer from the Start menu.

### The code doesn't work in Nessie
Codes work once and last 5 minutes. On the computer choose **Get a new code**.
Check you're in the right team in Nessie, and on the right Nessie server if your
organisation runs its own.

### A team shows "Team name not available yet"
Nessie hasn't named that team on this computer yet. Nessie Computer asks for
every team's name when it opens and every hour after, and keeps a name once it
has one, even while Nessie can't be reached. To ask now, quit and reopen Nessie
Computer, or run `nessie-computer teams`.

### Nessie says the computer is offline
- The computer may be asleep. Work waits until it wakes.
- Nessie Computer may not be running. Open it.
- If it says **Paused**, Nessie shows **Paused on the computer** instead of
  offline; choose **Resume**.

### An agent says it isn't allowed to run something
The program isn't on the team's [Programs](Programs) list. When the agent asks,
answer the request under **Needs you**. If you missed it, add the program on
**Access → Programs**.

### "Another copy of this computer connected to Nessie"
The same team was connected from another computer, or Nessie Computer files
were copied between machines. Choose **Reconnect here** to take the connection
back to this computer. If you didn't expect a second computer, check the
computer's page in Nessie first.

### "This computer's settings are older than Nessie expects"
Usually after reinstalling or restoring a backup. Choose **Send current
settings again**. Nothing about what agents can use changes.

### "This computer's key no longer matches"
The team was connected again from somewhere else, or the computer's files were
restored. [Disconnect](Disconnect-or-uninstall) the team and
[connect it](Add-a-team) again.

### ChatGPT says terminals and coding tools are stopped
That is expected while a ChatGPT plan is signed in. See
[AI](AI#before-you-sign-in).

### Documents shows something to check
See [Documents → When something needs you](Documents#when-something-needs-you).

## Logs

**Settings → Help → Open logs folder** opens the logs. On the command line:

```sh
nessie-computer status --json
```

## Still stuck

[Open an issue](https://github.com/UnlikeOtherAI/nessie-executor/issues) with
what you did, what the window said (including **Details**), your system and
your Nessie Computer version (**Settings → Help**). Don't paste pairing codes,
keys or private files.
