# Parallel inference sources and fast streaming

Status: the computer's side is built (11 November 2026, this change). Nessie's
side is two small parts: the turn limits below, and concurrent command
dispatch, which is designed here and not built.

Rulings (Ondrej, 11 Nov): one computer serves a ChatGPT plan and agent-run
programs at once; several inference sources answer at the same time; streaming
is as fast as it can be made without new machinery.

## 1. What a source is

A source is one thing that answers a model request from this computer: one
ChatGPT plan, one Claude Code or Codex account, or the computer's model
servers. Each source is one host with one outbound WebSocket to Nessie and one
pool of turns of its own. Sources share nothing: a turn on one never waits for
a turn on another.

| Source | Pool | Turns at once | Why that number |
|---|---|---|---|
| ChatGPT plan | one per plan | 2 | The plan's receipt store holds four unsettled turns; two running and two reporting is its ceiling. |
| Claude Code, Codex | one per account | 4 | Each turn is its own CLI process in its own folder. |
| Model servers on this computer | one, shared | 1, owner-set up to 16 | One GPU. The owner raises it in Nessie for a server that batches. |

The number is the pool's `capacity`, which Nessie holds and the host applies
(`LocalInferenceCoordinator`). Nothing else rations turns: the host claims work
the moment Nessie pushes `attempt_available` and keeps claiming until every
slot is busy (`LocalInferenceClaimScheduler`).

## 2. What a turn costs

A turn is one model request. Everything else around it was overhead, and is
now paid once and shared.

| Before | Now |
|---|---|
| ChatGPT: three owner/team checks with Nessie per turn, two HTTPS requests each | The host's five-second check is reused by every lease under ten seconds old |
| ChatGPT: the provider's model list read three times per turn | Read once a minute per plan; a failed request reads it again |
| ChatGPT: no prompt cache key | One key per agent, so its instructions and tools are cached between turns |
| Claude Code, Codex: the CLI started two or three times to look at it, before and after every turn | One look a minute; a failed turn looks again |

Revocation is no slower: the five-second check still stops the host when the
owner, team or pairing changes, and that stops every lease taken from it.

## 3. Streaming

The path is already a push in both directions and stores nothing per token:
model → host → one signed WebSocket message → the API replica holding that
socket → the worker's own WebSocket → the run. No database write, no poll, no
second hop. The receipt, not the frames, is the record, so a dropped frame
costs nothing but smoothness.

Two changes make it as fast as that path allows:

- **The first words travel at once.** A stream's first delta is sent the
  moment it arrives instead of waiting for a window to close.
- **The window is 40 ms, not 150 ms.** At most 25 frames a second per stream.
  Sixteen streams side by side cost the server about 400 signature checks a
  second, under a tenth of one core.

Deliberately not done: a binary frame format, compression, one multiplexed
socket for all sources, or unsigned frames. Each would save less than the
window change did and add a second protocol to keep correct.

## 4. A plan and programs together

A signed-in plan no longer keeps terminals, coding tools and local apps off the
computer, and none of them keeps a plan from signing in
([security boundaries](../../SECURITY.md)). On macOS and Linux this also ends
the state the fence could never leave: a program's stop cannot be proved
there, so every local app that had ever run blocked sign-in until the runtime
restarted.

## 5. Not built: several commands at once

The computer runs commands side by side and has since sessions shipped
([sessions and concurrency](../sessions-and-concurrency.md)). Nessie refuses
that mode on purpose (`api/src/contracts/executors.ts` omits the concurrent
poll fields) and hands each computer one command at a time, so a slow local
app call or a long terminal step holds every other agent's work on that
computer. This, not inference, is what serialises guided Claude Code and
Codex sessions today.

The server change, in one place (`@nessie/executor-manage`, the poll):

1. Accept the concurrent poll and verify its signature over every field sent.
2. Answer `commands`: every leased, deliverable command of this computer that
   the poll's `activeCommands` does not already name, oldest first, each
   prepared and bound exactly as the single command is today. The computer
   queues what exceeds its own capacity, so the server needs no notion of
   command kinds.
3. Answer `cancellations` for the active commands whose cancellation was
   requested, and `sessionClose` as an empty list until Nessie models sessions.
4. Keep the one-command answer for a computer that sends no `concurrency`.

Receipts, results and fences are already per command. The risk is in step 2's
authority preparation running for several commands in one poll, which is why
it gets its own change with database-backed tests rather than riding this one.
