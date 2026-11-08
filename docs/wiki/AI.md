# AI: Claude Code, Codex, ChatGPT plans and model servers

The **AI** tab connects AI that runs from this computer, so your agents can use
it instead of paying for Nessie's AI. Pick the team from the **Team** list first.

## Claude Code and Codex already on this computer

If Claude Code or Codex is installed and signed in here, the **On this
computer** section lists it with the account it's signed in to. Turn on
**Make available** and agents for this team can use it for their AI. They run
it the way T3 Code does: through the installed program and its own sign-in.
Nessie Computer never reads or copies that sign-in.

- Not installed: the row is greyed out and says **Not installed on this computer**.
- Installed but signed out: run `claude` (or `codex`) once in a terminal to sign in.
- Whether only you or your whole team can use it is set in Nessie.

## ChatGPT plans

Your agents can use your own ChatGPT plan, personal or company. Requests go
from this computer to OpenAI and count against that plan. Nessie adds no fee
for them.

### Add a plan

1. Choose **Add a ChatGPT plan**.
2. Keep the suggested name (*ChatGPT plan 1*) or type your own, such as
   *Work plan*.
3. Choose **Sign in with ChatGPT**. Your browser opens ChatGPT's own sign-in.
   Sign in with the account that has the plan.
4. Back in Nessie Computer the plan shows **Ready**.

Add as many plans as you have. Each one has its own name and sign-in.

On Windows the Nessie Computer background service keeps a plan's sign-in. The
first plan for a team therefore adds a **ChatGPT plan connection** for that
team: Windows asks you to allow it, then this computer shows one more code to
enter in Nessie under **Computers → Add a computer**.

### Before you sign in

While a ChatGPT plan is signed in, agents can't open terminals or coding tools
under your account on this computer. That keeps the plan's sign-in out of
their reach. Sign out to get them back. Nessie Computer asks you to tick a box
confirming this before you sign in, and asks you to stop any terminals or
coding tools agents are running first.

### Background work

Agents use a plan only while you are working with them, unless you choose
**Allow background work**. Even then, each automation in Nessie asks for your
permission before it uses the plan.

### Manage a plan

Choose **Manage** on the plan:

- **Rename** it.
- **Check again** if its status looks wrong.
- **Manage ChatGPT usage** opens your plan's usage page.
- **Disconnect** signs it out. Its sign-in is removed from this computer;
  *"Disconnecting…"* shows until that is finished.

Who pays: a plan pays for your own agents' work. Other people's agents use
their own funding.

## Model servers

A model server is an AI model running on this computer or on your local
network, such as Ollama or LM Studio, that speaks the same language as OpenAI's
API.

1. Choose **Add server**.
2. Give it a name and its address, for example `http://192.168.1.90:8080/v1`.
3. Say where it runs: **On this computer** or **On my local network**.
4. Add an API key if the server needs one. The key stays on this computer.
5. Choose **Save connection**. The list shows **Online** and the models it offers.

Only this computer needs Nessie Computer; the model server doesn't.
**Check connections** tests every server again.

## On the command line

```sh
nessie-computer ai local                       # Claude Code and Codex on this computer
nessie-computer ai local on codex --team "Sales · Acme"
```

```sh
nessie-computer ai plans list --team "Sales · Acme"
nessie-computer ai plans add "Work plan" --team "Sales · Acme"   # opens ChatGPT sign-in
nessie-computer ai servers add "Studio" http://192.168.1.90:8080/v1 --where network --team "Sales · Acme"
nessie-computer ai servers list --team "Sales · Acme"
```
