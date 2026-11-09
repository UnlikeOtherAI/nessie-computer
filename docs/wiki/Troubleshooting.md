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
| Amber (Mac) | **Needs you: allow Nessie Computer in System Settings to finish updating** | macOS is waiting for you to allow the update helper. Choose the line; Login Items opens. Switch Nessie Computer on. |
| Amber (Mac) | **Needs you: updates can't start — …** | macOS refused to register the update helper, for the reason shown. Nessie Computer asks again by itself; **Try again** in the window asks at once. |
| Amber (Mac) | **Updates are stuck — teams can't start** | The update helper isn't answering, so no team can start. Nessie Computer restarts it by itself; **Restart updates** in the window does it at once. If an older Nessie desktop app is open, quit it. |
| Red (Windows) | **Can't reach the Nessie Computer service** | The background service isn't answering. Restart Windows; if the icon stays red, reinstall Nessie Computer. |

A tab that couldn't read its team (Access, Documents, or AI's Claude Code,
Codex and model-server checks) tries again by itself within a minute; **Try
again** only hurries it.

Every problem in the **Needs you** strip comes with one button that fixes it, unless
Nessie Computer is already fixing it by itself. **Details**
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
Computer, or run `nessie-computer teams`. If Nessie still can't name the team,
`nessie-computer teams` says why: the server, the team and the answer it gave.

### A local app doesn't start
Nessie Computer tries again later and later: twice at once, then after a
minute, then twice as long each time, up to every 30 minutes. It starts as
usual as soon as the app works again, for example once Kelpie's device is back
on the network. `nessie-computer access local-apps --json` shows, under
`start`, how many starts in a row failed, why, and when it tries next.

### Nessie says the computer is offline
- The computer may be asleep. Work waits until it wakes.
- Nessie Computer may not be running. Open it.
- If it says **Paused**, Nessie shows **Paused on the computer** instead of
  offline; choose **Resume**.

### An agent says it isn't allowed to run something
The program isn't on the team's [Programs](Programs) list. When the agent asks,
answer the request under **Needs you**. If you missed it, add the program on
**Access → Programs**.

### "Another copy of this team connected to Nessie after this computer did"
The same team was connected from another computer, or Nessie Computer files
were copied between machines. Choose **Connect again** to take the connection
back to this computer. If you didn't expect a second computer, check the
computer's page in Nessie first.

### "This computer's copy of the team's settings is older than the one Nessie recorded"
Usually after reinstalling or restoring a backup. Choose **Send these settings
again**. Nothing about what agents can use changes.

### "Nessie did not accept this computer's signature"
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
