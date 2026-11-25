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
| Amber (Mac) | **Updates are stuck — teams can't start** | The update helper has missed two status checks. An already running team can keep working. Nessie Computer restarts it by itself; **Restart updates** in the window does it at once. If an older Nessie desktop app is open, quit it. |
| Red (Windows) | **Can't reach the Nessie Computer service** | The background service isn't answering. Restart Windows; if the icon stays red, reinstall Nessie Computer. |

A tab that couldn't read its team (Access, Documents, or AI's Claude Code,
Codex and model-server checks) tries again by itself within a minute; **Try
again** only hurries it.

Every problem in the **Needs you** strip comes with one button that fixes it, unless
Nessie Computer is already fixing it by itself. **Details**
underneath shows the technical message, which helps if you contact support.

If the team's reconnect was waiting for a finished settings save, Nessie Computer
retries the save's cleanup on its next attempt. On Windows it can also restart
a team after its previous process exits while Windows still holds its process record.

## Common problems

### I can't find the icon
- **Mac:** a crowded menu bar hides icons, especially beside the camera notch.
  Open Nessie Computer from Applications or Spotlight; the window opens.
- **Windows:** check the hidden icons (**^** by the clock). Drag the icon out to
  keep it visible. Or open Nessie Computer from the Start menu.

### The code doesn't work in Nessie
Codes work once and last 10 minutes. On the computer choose **Get a new code**.
Check you're in the right team in Nessie, and on the right Nessie server if your
organisation runs its own.

### Nessie says there were too many pairing attempts
Nessie gives one network twenty codes in ten minutes; every computer behind the
same router counts together. Wait a few minutes, then choose **Get a new code**.

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
The program isn't on the team's [Programs](Programs.md) list. When the agent asks,
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
restored. [Disconnect](Disconnect-or-uninstall.md) the team and
[connect it](Add-a-team.md) again.

### Windows says the command-line tool did not answer in time
An older Windows version could accumulate completed-command records while a
coding session stayed open. This could also delay adding a team and loading
Documents or AI. Install the current Nessie Computer update. It recovers those
old records automatically and keeps your team connections and permissions.
Do not delete the computer's state folder to clear the error.


### A session start fails although Claude Code or Codex is allowed
Check **Access > Programs** for that team and **Settings** for an available
Nessie Computer update. Windows also verifies its private settings before
starting a session; a timeout is not necessarily a missing program permission.
Keep the original conversation and its error when reporting this. Do not delete
local state or start another session when the first start's outcome is unknown.
If a session is created but stops before any output, its creation alone does not
mean the program ran. Keep the session ID and error, check for an update under
**Settings**, and report them from the original conversation. An update preserves
expired requests; it does not silently rerun their commands.

### ChatGPT says terminals and coding tools are stopped
Update Nessie Computer. Plans and programs now work side by side; see
[AI](AI.md#plans-and-everything-else-together).

### Documents shows something to check
See [Documents → When something needs you](Documents.md#when-something-needs-you).

## Logs

**Settings → Help → Open logs folder** opens the logs. On the command line:

```sh
nessie-computer status --json
```

## Still stuck

[Open an issue](https://github.com/UnlikeOtherAI/nessie-computer/issues) with
what you did, what the window said (including **Details**), your system and
your Nessie Computer version (**Settings → Help**). Don't paste pairing codes,
keys or private files.


### Adding a team that is already connected

In Nessie Computer, open the team menu and choose **Add another team**. If you
finish the code in a team that already uses this computer, the app returns to
that team and says it is already connected. Its folders, programs and permissions
stay as they were. Different teams can have the same name and remain separate.

If an older app already shows duplicate connections, keep the one you use while
checking their running work before disconnecting extras. Adding another connection
does not repair a failed task or transfer its history.

### Claude or Codex installed with npm on Windows

Nessie Computer finds the normal npm installation automatically, including
Claude's native executable and Codex's Node launcher. Keep using the program's
existing sign-in. You do not need to edit command paths or add a second login.
Each new session uses the current Windows user environment, so a newly installed
program is discovered without another setup step.

### Windows retains an old connection as working in another app

An old connection may retain a process number that Windows has since given to
another program. Current versions record the process's generation, so reusing a
number does not keep a departed connection running.

Let active work finish, then update Nessie Computer. The installer clears old
connection locks only when Windows can prove their original process has gone.
Team settings and history are kept.
No extra sign-in or administrator prompt is added beyond the installer itself.
Do not delete the state folder or stop the unrelated process.

### A coding session stops while idle on Windows

Update Nessie Computer if a Claude Code or Codex session becomes interrupted
after a minute without tool calls. The built-in connection now stays open while
the computer's team connection is running; leaving a conversation idle does not
close it. No additional sign-in or permission is needed.

An app update or a stopped team connection can still interrupt Windows sessions.
Their history remains available. Do not replay a previous command whose result
is unknown.
