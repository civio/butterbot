# Butterbot

A minimal Slack agent harness built on the [pi](https://github.com/earendil-works/pi) AI libraries. Successor-in-spirit to [pi-mom](https://github.com/earendil-works/pi/tree/v0.70.6/packages/mom), which was removed from the pi monorepo in April 2026.

Butterbot connects to Slack over Socket Mode, forwards mentions and DMs to an LLM, and posts the reply. It is built for local, Anthropic-compatible servers (LM Studio, oMLX, …), and works with cloud providers too. The agent can run shell commands and read/write files in a workspace — directly on the host or inside a Docker sandbox — and discovers **skills** (workflow instructions + scripts) from the workspace.

**Status: early development.**

## Features

- **Slack**: answers @mentions in channels it's a member of, and DMs. The reply is a message of the bot's own, and everything it took — commands run, results — goes in a thread under it, so the channel stays readable and the internal working is one click away. See [Threads](#threads).
- **One conversation per thread**: each thread has its own agent and its own history, so two questions asked in the same channel can't answer each other. Mentioned in a thread it hasn't seen, it reads what was said there earlier to catch up — see [Threads](#threads).
- **Markdown → Slack**: the model writes ordinary Markdown and the harness converts it to Slack's mrkdwn before posting — bold, italic, links, headings, bullets, strikethrough — leaving code spans and fenced blocks untouched. Asking for Slack's dialect in the prompt worked only as often as the model felt like obeying; see [Formatting](#formatting).
- **Agent loop**: `@earendil-works/pi-agent-core`'s `Agent` with four tools — `bash`, `read`, `write`, `edit` — all routed through the sandbox executor.
- **Sandbox**: `--sandbox=host` runs commands on the host with the workspace as working directory; `--sandbox=docker:<container>` runs them inside a long-lived container with the workspace mounted at `/workspace` (pi-mom's convention — see [Setup](#3-create-the-sandbox-container)).
- **Skills**: every `<workspace>/skills/<name>/SKILL.md` (frontmatter `name:`/`description:`) is listed in the system prompt; the model reads the full instructions on demand and runs the skill's scripts via bash. An optional `channels:` field limits which channels a skill is listed in — see [Skill visibility](#skill-visibility). Skills are re-read on every message, so adding or editing one doesn't need a restart. A message starting with a skill's name — `!whoami` — invokes it directly: the model is told which skill to follow, rather than left to match the request against the list, and the rest of the message is passed as input. Only skills visible in the channel can be invoked; anything else starting with `!` is treated as ordinary text.
- **Memory**: Markdown files under `<workspace>/memory/` are injected into the system prompt, so facts and conventions survive between conversations — `MEMORY.md` everywhere, plus one file per channel or DM. The model is told it may edit them, and they are re-read on every message. See [Memory](#memory).
- **Context env vars**: each command runs with `BUTTERBOT_CHANNEL_ID`, `BUTTERBOT_CHANNEL_NAME`, `BUTTERBOT_USER_ID` and `BUTTERBOT_USER_NAME` set, so a skill script knows who is asking and where.
- **Per-user secrets**: API tokens are kept outside the workspace. The asking user's secrets file, combined with a shared one, gets injected into the environment of Bash commands. See [Secrets](#secrets).
- **Performance metrics**: every LLM call appends one JSON line to `logs/metrics.jsonl` — time to first token, generation time, tokens/second, token usage — measured in the harness, so inference backends (LM Studio, oMLX, a cloud provider) can be compared on equal terms. The log holds numbers only, no message text, and lives outside the workspace so the sandboxed agent can't read harness logs.
- **Setup wizard**: `npm run setup` is a terminal UI (built on `@earendil-works/pi-tui`) that creates the Slack app from the shipped manifest, verifies both tokens against Slack, lists the models a local server has loaded, and writes `.env`. See [Setup](#setup).
- **Interaction log**: every exchange appends one JSON line to `logs/interactions.jsonl` — who asked what in which channel, the reply, and the tool-call trace of how it got there — the raw material for QA and for evaluating one model against another. It shares a `runId` with the metrics lines of the same run, carries the `conversation` the exchange belongs to so a thread can be followed end to end. It stores full text, and stays outside the workspace like the metrics.

## Requirements

- Node.js >= 22.19 — pi's libraries require it
- A Slack app (setup below)
- A local Anthropic-messages-compatible LLM endpoint, or an API key for a cloud provider
- Docker, if using the Docker sandbox

## Setup

```sh
npm run setup
```

The setup wizard will install dependencies and walk you through the whole process: it asks what the bot should be called and opens Slack's create-app form prefilled with [`src/setup/slack-manifest.yaml`](src/setup/slack-manifest.yaml) under that name, asks for the two tokens and checks each against Slack before accepting them, asks your local LLM server which models it can answer with so the id is picked rather than typed, writes `.env`, and offers to start the bot. It ends on a summary of what was chosen and how to invite the bot into a channel.

The wizard will launch the bot without a Docker sandbox, so the bot runs the agent's shell commands directly on this machine. That is fine for a first look but not for much else — see [Create the sandbox container](#3-create-the-sandbox-container).

The rest of this section is the same setup done by hand, and is worth reading either way: it says what each scope buys.

### 1. Create the Slack app

Adapted from pi-mom's setup guide; Butterbot needs a smaller set of scopes.

1. Create a new Slack app at https://api.slack.com/apps. Choosing **From a manifest** and pasting [`src/setup/slack-manifest.yaml`](src/setup/slack-manifest.yaml) does steps 2, 4, 5 and 6 below in one go. Select **From scratch** to do them by hand.
2. Enable **Socket Mode** (Settings → Socket Mode → Enable). This is what lets the bot run behind a firewall with no public URL — nothing needs to be reachable from the internet.
3. Generate an **App-Level Token** with the `connections:write` scope. This is `BUTTERBOT_SLACK_APP_TOKEN` (starts with `xapp-`).
4. Add **Bot Token Scopes** (Features → OAuth & Permissions):

   | Scope | Why |
   |---|---|
   | `app_mentions:read` | receive @mentions |
   | `chat:write` | post and edit replies |
   | `im:history` | receive direct messages |
   | `im:read` | resolve DM conversations |
   | `channels:read` | resolve public channel names |
   | `groups:read` | resolve private channel names |
   | `users:read` | resolve the display name of whoever is asking |
   | `channels:history` | read a public thread it is mentioned in |
   | `groups:history` | the same, in private channels |

   The three `*:read` resolution scopes matter more than they look: the channel and user names they return are passed to skill scripts as `BUTTERBOT_CHANNEL_NAME` / `BUTTERBOT_USER_NAME`. Without them the lookups fail, the names fall back to `unknown`, and any script that gates on the channel or loads per-user credentials will refuse to run.

   The two `*:history` scopes are what let it catch up on a thread it gets pulled into — see [Threads](#threads). They grant reading, not receiving: Butterbot still gets no events for messages it isn't addressed in, and it calls `conversations.replies` only when pulled into a thread by a mention. Leave them out and everything else still works; it just answers a mid-thread question without knowing what came before, with a line in the log saying so.

   `im:write` is *not* needed, unlike pi-mom's setup: it grants starting DMs (`conversations.open`), and Butterbot only ever replies inside a conversation someone else opened, using the channel id from the event — `chat:write` covers that. Add `im:write` if the bot ever needs to message someone first, e.g. for scheduled notifications.

5. **Subscribe to Bot Events** (Features → Event Subscriptions → Subscribe to bot events):
   - `app_mention`
   - `message.im`

   Note what is *not* here: Butterbot does not subscribe to `message.channels` or `message.groups`, so it is not listening — no event reaches it for a message that doesn't mention it. The only thing it reads without being sent it is the thread of a mention, so that being tagged halfway through a conversation isn't useless. None of it is stored: the logs hold the message addressed to it and its own reply, not what anyone else wrote. See [Threads](#threads).

6. **Enable direct messages** (Features → App Home → Show Tabs): turn on the **Messages Tab** and check *Allow users to send Slash commands and messages from the messages tab*.

7. Install the app to your workspace: Settings → Install App → **Install to** (or **Reinstall to**) your workspace → Allow. Then copy the **Bot User OAuth Token** from the *OAuth Tokens* box. This is `BUTTERBOT_SLACK_BOT_TOKEN` (starts with `xoxb-`).

   Press the button even when a token is already shown there. That page keeps the token from a previous install, and one issued before the scopes above were added authenticates perfectly, connects, and then answers nothing — the events it needs were never granted. Reinstalling is what reissues it. `npm run setup` catches this by comparing the token's granted scopes against the manifest; by hand, there is nothing to warn you.

8. Invite the bot to the channels where it should work (`/invite @your-bot`). It only sees channels it has been added to.

### 2. Choose a model

`--provider=local` expects a server exposing an Anthropic-messages endpoint at `--base-url` (default `http://localhost:1234`) — [LM Studio](https://lmstudio.ai/) and oMLX both do, among others. Pass the model id exactly as that server names it: check `curl localhost:1234/v1/models`, and note that ids like `google/gemma-4-26b-a4b` must be given in full.

The id is verified at startup against the server's own `/v1/models` list, when it offers one, because some servers don't reject an unknown id — they quietly answer with whatever model is loaded, and every reply is subtly wrong. For the same reason, each `metrics.jsonl` line carries a `responseModel` field with the model the server claims actually answered — for providers that report it. pi-ai 0.83's Anthropic-messages parser doesn't yet, so for local servers the field is absent and the startup check is the guard that counts.

A cloud model works as well: `--provider=anthropic --model=claude-opus-5`, with `ANTHROPIC_API_KEY` in the environment. Credentials are checked at startup rather than on someone's first question.

Which one you run is a data-residency decision as much as a quality one. Everything the agent reads — including whatever a skill's script returns — goes to the model, so a workspace holding sensitive data should be paired with a local one.

### 3. Create the sandbox container

Recommended, so the agent's shell commands can't touch the host. Any long-lived container with the workspace bind-mounted at `/workspace` will do:

```sh
docker run -d \
  --name butterbot-sandbox \
  -v $(pwd)/workspace-example:/workspace \
  alpine:latest \
  tail -f /dev/null
```

Install whatever the skills need inside it (Node, `jq`, …), or use an image that already has them. Then run Butterbot with `--sandbox=docker:butterbot-sandbox`.

The container is meant to be long-lived: recreating it loses everything installed inside. After a reboot, `docker start` it — which `npm start` does for you — rather than `docker run` a new one. It's recommended to keep a note in the workspace of what you install in it, as the rebuild recipe in case it does have to be recreated.

### 4. Give people their credentials

Only needed once a skill's scripts call an external API. Create a directory *outside* the workspace — `./secrets` by default, so nothing is mounted into the container — holding `shared.env` for what everyone may use and one `<slack-handle>.env` per person for anything stronger:

```sh
mkdir -p secrets && chmod 700 secrets
printf 'CRM_API_TOKEN=%s\n' "$READ_ONLY_TOKEN" > secrets/shared.env
printf 'CRM_API_TOKEN=%s\n' "$READ_WRITE_TOKEN" > secrets/alice.env
```

With no `shared.env`, whoever has no file of their own has no credentials, and the skills needing them fail for that person. See [Secrets](#secrets) for how each message's environment is put together.

## Run

```sh
npm install

# Copy the example env file and fill in the Slack tokens, sandbox container, workspace and model.
# If you've created your bot via the setup wizard, the `.env` is already set up for you.
cp .env.example .env

npm start
```

`npm start` sources `./.env`, starts the sandbox container — a no-op when it is already running — and expands three of the variables into the flags below: `--sandbox=docker:$BUTTERBOT_SANDBOX_CONTAINER`, `--model=$BUTTERBOT_MODEL`, and the workspace positional from `$BUTTERBOT_WORKSPACE`. Any of them unset stops the start. Two more are optional: `$BUTTERBOT_PROVIDER` and `$BUTTERBOT_BASE_URL` become `--provider` and `--base-url` when set, and are left off the command line entirely when not, so Butterbot's own defaults apply.

`npm run start:host` is the same minus Docker: it passes `--sandbox=host`, needs no container variable, and starts with the warning that commands run unconfined on this machine.

Anything else (a cloud provider, one-off flags...) is `node src/main.js` directly:

```sh
source .env
node src/main.js --sandbox=host --provider=anthropic --model=claude-opus-5 ./workspace-example
```

The positional argument is the workspace directory (default `./workspace`). With the Docker sandbox, the container must have that same directory mounted at `/workspace`.

[`workspace-example/`](workspace-example/) ships with the repo — one `whoami` skill that reports the context variables, and a sample `memory/MEMORY.md` — so a fresh clone has a working skill and a remembered fact to test with before you write a workspace of your own.

The workspace doesn't have to live in this repository. The intended production shape is a repo of its own — skills and memory under version control there — with Butterbot started from this checkout, pointed at it: `BUTTERBOT_WORKSPACE=../my-skills-repo/workspace`. Deployment state stays here, gitignored: `.env`, and the `./logs` and `./secrets` defaults, which land outside the workspace with no extra flags precisely because the working directory is this checkout. Upgrading the harness is then `git pull` plus a restart.

On startup Butterbot prints the identity it connected as, the model and endpoint in use, the sandbox, and the skills it found — worth reading once to confirm the setup took effect:

```
Butterbot connected to Slack as @your-bot (model: local/google/gemma-4-26b-a4b at http://localhost:1234,
sandbox: docker:butterbot-sandbox, workspace: /workspace, logs: /home/you/butterbot/logs,
secrets: /home/you/butterbot/secrets, skills: donor-support [donor-admin, dev-team])
```

Skills restricted to particular channels are shown with them in brackets. `skills: none` from a workspace that does have skills means the path Butterbot was given is wrong.

To keep it running after you log out, use tmux (`tmux new -s butterbot`, then `Ctrl+B` `D` to detach, `tmux attach -t butterbot` to return). `Ctrl+C` there — or a SIGTERM from anywhere — shuts it down cleanly; the sandbox container is left running, so `docker stop` it separately when you want it down too.

## Configuration

Settings are flags. Run `butterbot --help` for the same list.

| Flag | Default | Description |
|---|---|---|
| `--sandbox=<spec>` | `host` | `host` or `docker:<container>` |
| `--provider=<id>` | `local` | `local`, or any provider in pi-ai's catalog: `anthropic`, `openai`, `google`, … |
| `--model=<id>` | — | **Required.** For `local`, the server's exact id (e.g. `google/gemma-4-26b-a4b`; check `curl localhost:1234/v1/models`). Otherwise a catalog id such as `claude-opus-4-5` — an unknown one lists what's available |
| `--log-dir=<dir>` | `./logs` | Where harness logs (`metrics.jsonl`, `interactions.jsonl`) are written. Rejected if inside the workspace, which the sandboxed agent can read |
| `--secrets-dir=<dir>` | `./secrets` | Where credentials live: `shared.env` plus one `<slack-handle>.env` per person. Rejected if inside the workspace, for the same reason. See [Secrets](#secrets) |

These three apply to `--provider=local` only, since a cloud model's own catalog supplies them, and are rejected otherwise:

| Flag | Default | Description |
|---|---|---|
| `--base-url=<url>` | `http://localhost:1234` | Anthropic-compatible endpoint |
| `--context-window=<n>` | `64000` | Context window declared to the client |
| `--max-tokens=<n>` | `8192` | Max output tokens per reply |

Unknown flags are rejected, which an environment variable can't do: a typo in a variable name would silently leave the agent unsandboxed. Running without a sandbox also prints a warning at startup.

The rest are environment variables instead, because none of them belongs on a command line — credentials would appear in the process list, and a system prompt is too long:

| Variable | Required | Description |
|---|---|---|
| `BUTTERBOT_SLACK_APP_TOKEN` | yes | Slack app-level token (`xapp-…`) |
| `BUTTERBOT_SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-…`) |
| `BUTTERBOT_SYSTEM_PROMPT` | no | Replaces the built-in base prompt (environment and skills sections are still appended) |
| `BUTTERBOT_LOCAL_API_KEY` | no | Key for a local server configured to require one |

Most local servers ignore the API key, so `--provider=local` sends a placeholder to satisfy the transport. Some can be configured to require a real one; a `401 Invalid API key` on the first reply is the sign, and `BUTTERBOT_LOCAL_API_KEY` is the answer.

## Tests

```sh
npm test
```

Uses Node's built-in test runner, so there is nothing to install. The suite covers what can be checked without a Slack workspace or a model: skill loading and channel visibility, memory (file naming per channel and DM, loading against a temp workspace, the prompt section), secrets (per-user lookup over the shared file, the accepted file format, and the environment composed for a message), the sandbox executors, the four tools against a real temp workspace, model resolution for local and cloud providers, the `.env` the setup wizard writes (values filled into the example's comments, quoting, a second run over the file the first one wrote), the system prompt the agent builds for a given channel, `!skill` invocations and their fall-through to ordinary text, mention resolution, the reply flow (progress, final reply) against a stubbed Slack client, and the logging pipeline (per-call timing against a fake response stream, interaction records with their tool-call trace, the JSONL writer). The Socket Mode transport itself is not covered.

## Design notes

### Differences from pi-mom

Butterbot is not an exact clone of pi-mom:

- **Only what is addressed to it reaches it.** pi-mom subscribed to channel messages, which is what gave it the context to persist a conversation and replay it on startup; Butterbot subscribes to @mentions and DMs only, so ordinary channel talk never reaches it.
- **A conversation is a thread, not a channel.** pi-mom kept one agent and one history per channel, and expected to be addressed only in the channel itself, not in a thread. Butterbot maintains a separate state per thread instead, so follow-ups and mentions in threads have the correct context. See [Threads](#threads).
- **Conversations don't survive a restart.** History is in memory only. pi-mom persisted the whole channel history and replayed it on startup.
- **Long conversations lose their oldest turns** rather than being summarised. pi-mom filled the model context windown and compacted automatically: it held far more history but was costly for local models and could leave the agent reasoning from a stale summary or unrelated topics.
- **Its logs are instrumentation, not a transcript.** Two JSONL files outside the workspace: `metrics.jsonl`, with timings and token usage per LLM call, and `interactions.jsonl`, with questions, answers and tool calls in between. These enable comparing backend performance and grading answers. What pi-mom kept was the channel transcript, inside the workspace.
- **Local models are first-class.** `--provider=local` is the default and needs no `models.json` or `auth.json`; cloud providers come from pi-ai's catalog when you want one. pi-mom defaulted to Anthropic, and reaching a local server meant maintaining config files by hand.
- **No scheduled events or wake-ups.** pi-mom could wake itself on a schedule or a one-shot event.
- **Under the hood**, it's plain JavaScript (vs pi-mom's TypeScript), and it sits on top of `@earendil-works/pi-agent-core`'s `Agent` instead of the heavier `AgentSession` from `pi-coding-agent`. For Slack transport, `@slack/socket-mode` + `@slack/web-api`, no Bolt.

### Threads

Mentioned in a channel, Butterbot answers with a message of its own and the exchange continues in the thread under it; mentioned inside a thread, it joins that thread. Each has its own agent and its own history, so asking about a topic A in one thread and about topic B in another no longer produces answers that have read each other. A DM is the exception — it has no thread worth the name, so the channel itself is the conversation.

Which makes Butterbot amnesiac in a channel, deliberately. Each question asked there opens a conversation with an empty history: nothing from the thread beside it, nothing from an hour ago, nothing from before the last restart. Inside a thread it keeps a fixed number of messages (currently 60). The cost is rediscovery, e.g. it may need to read a skill again. But the gain is that the context is much smaller and more directly related to the current interaction (an answer is not coloursed by previous unrelated conversations), both things critical when using local models.

The conversation is named after the reply that roots its thread, not after the question. Threading the reply onto the question reads better, but Slack subscribes you to any thread you started, so every line of tool activity below the answer would ping whoever asked. Hanging the exchange off the bot's own message puts it in a thread nobody is subscribed to, and the answer itself arrives as an edit to a message already posted, for everyone in the channel to see.

If Butterbot is pulled into a thread that was already running, it receives no events for messages it isn't mentioned in, so it fetches `conversations.replies` and puts what people said into that turn's prompt, marked as earlier messages. After that it keeps its own history, which has everything said since. This is why the `*:history` scopes are in the setup list, and why nothing breaks without them.

What it reads this way it does not keep. The catch-up goes into that one prompt and nowhere else: `interactions.jsonl` records the message addressed to Butterbot and the answer it gave, never the surrounding conversation. Sharing a channel with it means it can see a thread you tag it into, which is the same deal as any colleague; it does not mean your messages end up in its logs. The cost is that a logged exchange isn't a complete record of what the model was shown — a deliberate trade, made in that direction on purpose.

Two consequences worth knowing. **You have to @mention it every time, in a thread as much as in a channel**: hearing an un-addressed follow-up would mean subscribing to every message in every channel, which Butterbot doesn't do. And **replies are still serialised per channel**, not per thread: two threads in the same channel take turns. A local model answers one request at a time anyway, so there is little to win by letting them overlap and a shared-state race to lose.

### Formatting

Slack's mrkdwn is not Markdown: bold is `*one asterisk*`, italic is `_underscores_`, links are `<url|label>`, and there are no headings and no tables. The system prompt used to spell this out, and the model — a small local one especially — would drift back to standard Markdown within a few turns, so replies arrived littered with `**` and raw `[text](url)`.

`src/mrkdwn.js` converts instead at the edge where a reply is posted. The prompt now just asks for plain Markdown, which is what models are trained to write, and the transport's markup stops being the model's problem. Both the final reply and the narration streamed while it works go through it.

What is converted: `**bold**` and `__bold__`, `*italic*`, `***both***`, `[text](url)` and images, `# headings` (bolded, since Slack has none), `*`/`+` bullets, `~~strikethrough~~` and horizontal rules. Inline code and fenced blocks are copied through verbatim — a `**` someone asked to see stays a `**` — except for the language tag on a fence, which Slack would render as the first line of code.

Tables are the one thing no conversion can fix, so the prompt still asks the model to avoid them. Text that only looks like markup (`3 * 4`, `snake_case_name`) is left alone.

### Skill visibility

A skill can limit which channels it is offered in, with a `channels:` field in its frontmatter:

```yaml
---
name: donor-support
description: Donor administration tasks using the CRM, Stripe and Mailchimp.
channels: [donor-admin, dev-team]
---
```

Entries match either a channel name or a channel id, so `C01ABC…` also works and survives a rename. A skill with no `channels:` field is offered everywhere, which is the right default for low-risk skills like searching public content. Restricted skills are not listed in direct messages, since a DM has no channel name to match.

Write the names without the leading `#`, as above. Unquoted, `channels: #donantes` is a YAML comment: the field parses as absent, and absent means offered everywhere — the opposite of what was meant, and nothing warns about it. Quoting works (`channels: "#donantes"` has the `#` stripped) and `channels: [#donantes]` is rejected as invalid frontmatter, but the bare name is the form to use.

**On its own this is a visibility control, not a security boundary.** It governs what the model is told about, which is enough to stop it reaching for a sensitive workflow in the wrong place, and it keeps that work in channels where colleagues can see it. The skill files themselves are still in the workspace, an `ls` away, and the agent has a shell.

### Memory

Conversations are deliberately short-lived — a thread's history dies with it, and nothing survives a restart — so anything worth keeping longer goes in `<workspace>/memory/`, plain Markdown injected into the system prompt:

```
memory/
  MEMORY.md        read everywhere: team facts, conventions, preferences
  support.md       read only in #support
  dm-alice.md      read only in Alice's DM
```

Every message is prompted with the global file plus the channel's own. The prompt tells the model to update these files when it learns something worth keeping or is asked to remember or forget something, and the contents go into the prompt inline — asking the model to read them would be a tool call a small model skips. They are re-read on every message, so an edit — the model's own, or yours in an editor — takes effect immediately. The section is present even when nothing has been remembered yet; it is what tells the model it can remember at all.

Two things follow from memory being ordinary files in the workspace. Anyone (and any conversation) can read everything, including another channel's file — like `channels:` on a skill, the per-channel split is scoping, not a security boundary.

### Secrets

The API tokens skill scripts need live outside the workspace, in a shared file plus one per person, named after their Slack handle:

```
secrets/
  shared.env     CRM_API_TOKEN_DONOR_SUPPORT=…   (read-only, everyone)
  alice.env      CRM_API_TOKEN_DONOR_SUPPORT=…   (read-write, overrides the above)
                 STRIPE_API_KEY=…                (only his)
  bob.env        MAILCHIMP_API_KEY=…
```

Before each message, Butterbot reads `shared.env`, lays the file belonging to whoever is asking over it, and puts the result in the environment of every command that message runs. So the baseline access most questions need is written once, a personal file adds what only that person has, and a repeated key means the personal value wins — read-write where everyone else has read-only. Someone with no file of their own still gets the shared one.

The handle comes off the Slack event, so it isn't something the model can be talked into changing: a request carries the credentials of the person who made it and nobody else's. Both files are read per message, so granting someone a token of their own is writing a file, not restarting the bot.

The files are ordinary `.env`, parsed with [dotenv](https://github.com/motdotla/dotenv), so its rules apply: `export` prefixes are fine, and outside quotes a `#` starts a comment — quote any value that contains one.

Nothing is filtered — plain `bash` gets the same keys the scripts do, which is the point. Most useful work with an API is one-off, and an agent that can only run prewritten scripts can't do it.

This replaces the arrangement it grew out of, where each person's `.env` sat in the workspace and the scripts loaded it themselves. Anything with a shell could read anyone's file, and eventually did: a colleague with no credentials of her own asked about a donor, and the agent solved its missing-token problem by helping itself to someone else's keys. No amount of instruction fixes that; moving the file does.

**What this does and does not buy.** It stops one person's credentials answering another person's question, which was the actual incident. It does not defend against the model itself: the keys are in the environment of a shell the model drives, and a shell can read its own environment. Nor does it restrict *where* credentials work — a skill's `channels:` list still governs only what the model is told about, so a determined question in a DM can still reach an API. Both limitations are known.

## Roadmap

Roughly in priority order. Nothing here is scheduled.

- **Confirmation for write operations**, held by the harness — a button in Slack rather than an instruction in the prompt.
- **Stop command.** to interrupt a running turn.

## Credits

Butterbot exists because of [Mario Zechner](https://github.com/badlogic)'s work. It is built on his [pi](https://github.com/earendil-works/pi) libraries (`pi-ai`, `pi-agent-core` and `pi-tui`, MIT), and it follows the design of his **pi-mom** Slack bot (MIT, © Mario Zechner), which Civio ran in production for months before it was removed from the pi monorepo in April 2026.

Conventions taken from pi-mom: the `/workspace` bind-mount and `docker exec` sandbox model, the shape of the tool set (`bash`, `read`, `write`, `edit` routed through an executor), channel-scoped agents, answering in the channel while tool detail goes to the thread, and the context variables passed to every command — renamed here from `MOM_*` to `BUTTERBOT_*`.

Butterbot began as a port: Civio directed Claude Code to port the core of pi-mom's essential functionality against the current pi libraries, moving TypeScript to JavaScript along the way, and the result was reworked from there. Each file in `src/` carries a header naming the pi-mom file it descends from, linked at tag `v0.70.6` — the last release that still contained the package.

## License

[MIT](LICENSE) © Fundación Ciudadana Civio
