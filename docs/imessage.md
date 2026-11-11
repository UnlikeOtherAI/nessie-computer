# iMessage on a Mac

The daemon's half of iMessage. Nessie's standard (`docs/standards/imessage.md`
in the private repository) owns who may switch it on, where messages land and
who may send; this file owns what the Mac does. User guide:
[iMessage](wiki/iMessage.md).

## Wire

`packages/protocol/src/executor-imessage.ts`:

- **Heartbeat request `imessage`** — `{ state, lastDeliveredAt? }`, sent only by
  a macOS daemon and only after a heartbeat answer carried `imessage`, so an
  older Nessie (strict parsing) never sees it. It joins the signed heartbeat
  payload exactly when present.
- **Heartbeat answer `imessage`** — `{ enabled, since }`, present for a Mac.
  Nessie rings the `heartbeat` doorbell topic when the switch changes.
- **`POST /api/executor-daemon/imessage/messages`** — up to 50 received
  messages, signed by the machine key over the body without `signature` under
  `nessie.executor.daemon.imessage.v1`, admitted like a command poll. The
  answer lists the GUIDs Nessie holds and the switch as it stands.
- **`imessage.send`** — `{ to, text }`; result `{ sent, to, messageGuid }` or a
  refusal code naming its remedy (`IMESSAGE_OFF`,
  `IMESSAGE_NEEDS_FULL_DISK_ACCESS`, `IMESSAGE_NEEDS_AUTOMATION`,
  `IMESSAGE_NOT_SIGNED_IN`, `IMESSAGE_SEND_FAILED`).

- **The report** also carries the account's `addresses` (phone numbers first),
  read from `com.apple.madrid` › `IMD-IDS-Aliases` with `plutil`
  (`imessage/imessage-addresses.ts`), and `newConversationsFrom`: the address
  of the first message of the newest one-to-one chat the owner began, because
  Messages keeps "Start new conversations from" nowhere readable.
- **The switch** carries the owner's chosen `address` and the `mode`:
  `clients` delivers the owner's own messages too (`fromMe`), so a Clients
  thread mirrors the chat; `assistant` delivers only other people's.
- **`imessageOutbox`** in the heartbeat answer: Clients replies the owner
  pressed Send on, each handed over once. The bridge sends each with the same
  send `imessage.send` uses and reports at
  `POST /api/executor-daemon/imessage/sent` (domain `imessage_sent`) until
  Nessie settles it. A person's Send has no agent run, which every executor
  command needs.

States: `off`, `ready`, `needs_full_disk_access`, `needs_automation`,
`messages_not_signed_in`, `sends_from_other_address` (Messages starts new
conversations from another address than the chosen one). A send Messages would
make from another address — the chat's own for an existing chat, the
new-conversation address otherwise — is refused before anything is sent
(`IMESSAGE_SENDS_FROM_OTHER_ADDRESS`); a sent message reports the address
`chat.db` recorded (`destination_caller_id`). The daemon never reports `ready` without having
opened `chat.db` and heard Messages name an enabled iMessage account.

## Only a Mac

`imessage/imessage-operation.ts` keeps `imessage.send` in a macOS descriptor
and out of every other (`configuredOperationKeys` applies it; a Mac paired
before this version gains it under one new revision before its claim).
Offering it grants nothing: the Mac still refuses until the switch is on and
macOS granted the permissions. Off a Mac, `imessage-daemon.ts` builds no
bridge, reports nothing and refuses every send.

## Reading

`imessage/chat-database.ts` opens `~/Library/Messages/chat.db` read-only with
`node:sqlite`; every value from a caller is a bound parameter. Without Full
Disk Access macOS refuses even a `stat` of the file (`EPERM`), which is how
`needs_full_disk_access` is told apart from a Mac where Messages never ran
(`ENOENT`, reported as `messages_not_signed_in`).

Only rows another person wrote over iMessage are delivered: not the owner's
own, not SMS or RCS relayed from an iPhone, not tapbacks or group events. The
text is `message.text`, or the plain text inside the archived
`attributedBody` (`imessage/attributed-body.ts`) when that is empty.
Attachments travel as placeholders (`photo`, `video`, `audio`, `file` and the
file's name); their bytes never leave the Mac.

## Delivery and the cursor

`imessage/imessage-bridge.ts` keeps `{ since, rowId }` in the team's owner-only
folder (`imessage.json`). A new `since` starts at the newest row dated before
it, so switching on imports no history. Each pass reads 50 rows at a time, up
to 40 pages, delivers what is due (on or after `since`, and at most seven days
old), and moves the cursor only past a batch Nessie stored in full. A pass
runs when the Messages folder changes, every 30 seconds, when the switch turns
on and when the owner resumes a paused team. A paused team reads nothing.

## Sending

`imessage/messages-script.ts` runs `/usr/bin/osascript` with the address and
the text as `argv` — never inside the script's source — within 20 seconds.
Error `-1743`/`-1744` is a refused Automation permission; `-1728` naming the
account is a Messages without an enabled iMessage account. After the script
returns, the bridge looks for the owner's new message to that address in
`chat.db` for up to five seconds and returns its GUID, or null when it did not
appear in time. Messages' own failure code on that row is a refusal.

## Checks

`node scripts/run-tests.mjs --test-concurrency=1 test/imessage-chat-database.test.ts test/imessage-bridge.test.ts`
runs on any OS: the reader uses a fixture with Messages' own table and column
names. The real Messages database, AppleScript and the macOS permission
prompts are verified only on a Mac signed in to iMessage, by a person who can
answer those prompts.
