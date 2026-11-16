# Debug control plane

`pnpm debug:nessie` runs a stand-in for Nessie on this machine. A real Nessie
Computer pairs with it and connects to it, and you drive that computer from a
terminal: claim its pairing code, send it commands, start a Claude Code or Codex
session, type into it and read its screen. Nothing is deployed and no Nessie
account is involved.

Use it before any change to pairing, the daemon or coding sessions is called
done. Hosted Nessie reduces every session failure to
`EXECUTOR_CODING_SESSION_CALL_REFUSED` or `EXECUTOR_CODING_SESSION_RESULT_WITHHELD`;
the control plane returns the computer's own answer beside the word production
would have used, and a computer in debug mode prints the failure's stack.

## Five-minute run

```sh
# Terminal 1: the stand-in for Nessie
pnpm debug:nessie serve

# Terminal 2: a computer from this checkout, in debug mode
export NESSIE_EXECUTOR_ALLOW_LOCAL_API=1 NESSIE_API_PORT=5454 NESSIE_COMPUTER_DEBUG=1
mkdir -p ~/.nessie-debug/workspace
pnpm exec tsx src/index.ts pairing-start --cli --api http://127.0.0.1:5454 --state-dir ~/.nessie-debug/teams/source --workspace ~/.nessie-debug/workspace --json
pnpm debug:nessie claim <the code it printed> --team "Source build"
pnpm exec tsx src/index.ts pairing-status --state-dir ~/.nessie-debug/teams/source --json
pnpm exec tsx src/index.ts serve --state-dir ~/.nessie-debug/teams/source

# Terminal 3: be the agent
pnpm debug:nessie status
pnpm debug:nessie session start "" --agent terminal --command claude --cwd ~/.nessie-debug/workspace
pnpm debug:nessie session send "" --id <sessionId> --data "What is 391 + 9?"
pnpm debug:nessie session send "" --id <sessionId> --key Enter
pnpm debug:nessie session read "" --id <sessionId>
pnpm debug:nessie session close "" --id <sessionId>
```

`""` names the only connected computer; otherwise give its id, the start of its
id or its name. `pnpm debug:nessie help` lists every command. `call` sends any
operation (`call "" file.list '{"path":"workspace"}'`) and `tools` lists what a
local app offers.

A terminal session starts only a program the computer's command rules allow.
Anything else waits for the owner's answer in the app and then returns
`EXECUTOR_COMMAND_DENIED` with `owner_did_not_answer`, which production shows as
`RESULT_WITHHELD`.

## What an answer tells you

```json
{ "ms": 2514, "authorityChecks": 3, "production": "delivered to the agent", "result": { ... } }
```

- `production` is what hosted Nessie would hand the agent for this result. It
  applies the same checks in the same order as Nessie's result authority.
- `authorityChecks` counts the signed `session-authority` requests the command
  made. Hosted Nessie checks the person's sign-in afresh on each one, so this
  number times the server's response time is what the agent waits.
- `result` is the computer's whole answer.

## Make it behave like production

Hosted Nessie is slower than a loopback server and its clock is not this
computer's. Both have broken sessions that passed every local test, so check
both before a release:

```sh
pnpm debug:nessie options --latency 2500     # every answer takes 2.5 s
pnpm debug:nessie options --clock-skew 300   # the server's clock is 300 ms ahead
pnpm debug:nessie options --latency 0 --clock-skew 0
```

A session start must succeed at 2,500 ms and at ±300 ms. Other switches:
`--sessions unbound_local` stands in for a self-hosted Nessie with no identity
provider, and `--concurrent on` accepts the concurrent command poll that hosted
Nessie refuses today.

The serving terminal logs every pairing and daemon request, refusals included,
and names any route the computer asked for that the stand-in does not serve.

## Debug mode on the computer

`NESSIE_COMPUTER_DEBUG=1` together with `NESSIE_EXECUTOR_ALLOW_LOCAL_API=1`
makes the session bridge print the full error behind a refusal to the daemon's
own terminal, for example:

```
[coding-sessions] debug: session_start failed: Error: Original session effect authority is unavailable; ...
    at SessionEffectAuthority.consume (src/coding-session/session-effect-authority.ts)
    at start (src/coding-session/managed-bridge.ts)
```

Every session process says why it refused an effect, in its own log
(`coding-sessions/sessions/<id>/host.log` under the state folder):

```
[session-effect] debug: refused: Error: Original session authority changed (answer_slower_than_5s; 5210 ms)
[session-effect] debug: refused: the route's reference ran out while it answered
```

Nothing is added to a result, and the mode cannot be on in a released app: the
Mac app, the Windows app and the Windows managed launcher remove
`NESSIE_EXECUTOR_ALLOW_LOCAL_API` before they start a runtime, and that same
variable is what limits a runtime to a loopback address.

## An installed build

The installed runtime pairs with the stand-in too, which is how a signed build
is checked before it is released.

- **macOS:** run `nessie-computer` with the three variables above and a
  `--state-dir` of its own.
- **Windows:** `nessie-computer.cmd` is the managed launcher and removes the
  variable. Start the installed runtime directly, in the signed-in desktop
  session and not elevated:

  ```powershell
  $env:NESSIE_EXECUTOR_ALLOW_LOCAL_API = '1'; $env:NESSIE_API_PORT = '5461'
  $env:NESSIE_EXECUTOR_PACKAGED_CLI = '1'; $env:NESSIE_COMPUTER_DEBUG = '1'
  & "$env:ProgramFiles\Nessie Executor\nessie-executor-runtime.exe" "$env:ProgramFiles\Nessie Executor\nessie-executor.cjs" serve --state-dir "$env:USERPROFILE\.nessie-debug\teams\debug"
  ```

- **Another machine:** the stand-in listens on loopback only. Forward a port to
  it (`ssh -R 5461:127.0.0.1:5454 user@machine`) and pair that machine with
  `http://127.0.0.1:5461`.

Use a state folder of its own, never a team the app runs: a connection belongs
to the server it was paired with.

## What it is and is not

The stand-in speaks the computer's protocol under `/api/executor-pairing/` and
`/api/executor-daemon/` with the real request schemas, signatures, freshness
window and refusals, and is driven through `/debug/`. It keeps its computers in
`~/.nessie-debug/control-plane-<port>.json`, because a computer's connection
epoch and policy revision may only move forwards.

It has no people, teams, permissions or agents. `claim` plays the person in the
Add a computer dialog, and every command is stamped with one fixed debug agent
and person. It proves the computer's side; the dialog, team access and the
agent's own tools are still checked against Nessie.

Source: `src/debug-nessie/`. Focused gate: `test:debug-nessie`.
