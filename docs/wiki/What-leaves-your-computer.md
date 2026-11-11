# What leaves your computer

Nessie Computer connects out to the Nessie server you connected it to. Nothing
on the internet can connect in. This page lists what it sends, and what stays.

## Sent to Nessie

| What | When | Why |
|---|---|---|
| The computer's name, system (for example macOS 26 on Apple silicon) and a public key | When you add a team | So Nessie can show which computer it is and recognise it later |
| A short "still here" signal, including **Paused** when you paused it | About every 20 seconds while running | So Nessie knows it is online |
| The *names* of shared folders, local apps and the kinds of work the team allows | When you change access | So Nessie only sends work the computer accepts |
| Readings such as CPU, memory, disk and the busiest program names | Only while someone with access has the computer's monitor open in Nessie | The computer monitor |
| Files an agent reads or produces | When an agent works on a task you allowed | The work itself |
| Your documents and changes to them | While Documents is on | Keeping both copies the same |
| iMessages you receive (sender, text and attachment names) | On a Mac, while you switched iMessage on in Nessie | They arrive in your Personal Assistant ([iMessage](iMessage)) |
| Which update it has and whether it is up to date | With the "still here" signal | Showing the version in Nessie |

## Stays on the computer

- Where your folders are (their full paths).
- How local apps start (commands, settings and any keys in them).
- Your programs list and blocked programs.
- ChatGPT sign-ins and model-server API keys.
- The computer's private key.
- Program requests and your answers.

## Sent elsewhere

- **ChatGPT plans:** requests go straight from this computer to OpenAI, under
  your plan.
- **Model servers:** requests go to the server address you entered.
- **Update checks** go to UnlikeOtherAI's update service. They carry no pairing
  details, team names or file information.

## Who can see what you send

Only people your team's settings in Nessie allow. A computer is yours alone
until you share it on its page in Nessie.
