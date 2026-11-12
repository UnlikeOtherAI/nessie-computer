# iMessage

On a Mac, Nessie Computer can bring the iMessages that reach Messages into
Nessie, and your Personal Assistant can send iMessages as you. Windows and
Linux computers do not offer it.

## Turn it on

1. In Nessie, open the Mac's page under **Computers** and switch on
   **iMessage** in its **Overview**. Only the person who added the Mac sees
   the switch, and only while the Mac is shared with nobody else.
2. On the Mac, open **System Settings › Privacy & Security › Full Disk
   Access** and turn on Nessie Computer. It needs this to read Messages.
3. The first time an agent sends, macOS asks whether Nessie Computer may
   control Messages. Choose **Allow**. You can change it later under **System
   Settings › Privacy & Security › Automation**.
4. Messages on the Mac must be signed in to iMessage.
5. Choose which of your iMessage addresses to use (your phone number unless you
   pick an email) and where messages go: **Clients and my Personal Assistant**
   or **Only my Personal Assistant**. If Messages starts new conversations from
   another address, change **Start new conversations from** in Messages ›
   Settings › iMessage, or choose that address in Nessie. Nessie sends nothing
   it cannot confirm will come from your chosen address: until Messages has
   started a conversation from it on this Mac, start one there yourself.

The Overview says which of these is still missing.

## What happens

- iMessages that arrive after you switch it on appear in Nessie: in Clients, a
  channel only you can see whose conversations mirror your chats (what you send
  from your iPhone included), or in your Personal Assistant. Earlier history
  stays on the Mac.
- You reply from Clients. Nessie Computer sends it through Messages on the Mac.
- Photos and files show as a placeholder with the file name. The files stay on
  the Mac.
- Texts relayed from an iPhone (SMS and RCS) are not brought in.
- While the Mac is off, asleep or paused, new messages wait on the Mac and come
  in when it is back, up to seven days later.
- Only your Personal Assistant reads and sends your iMessages; no other agent
  assigned to the Mac can, whoever asks. It sends only when you ask it in your
  own conversation, while it is added to the Mac on the Mac's **Agents** tab in
  Nessie. The first message to somebody who has not written to you waits for
  your approval. If the Mac is off, asleep or paused, sending fails at once.

## Turn it off

Switch off **iMessage** on the Mac's page in Nessie. Nessie Computer stops
reading Messages within a second. Removing Full Disk Access or the Automation
permission on the Mac also stops it, and Nessie shows what is missing.

Full Disk Access applies to everything Nessie Computer runs on the Mac,
including programs agents start there under your Access rules. If you share
the Mac later, iMessage pauses, but macOS keeps the permission: while other
people use the Mac through Nessie, turn off Full Disk Access for Nessie
Computer, so nothing run for them can read your messages.
