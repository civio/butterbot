# pi-dad

A minimal Slack agent harness built on the [pi](https://github.com/earendil-works/pi) AI libraries. Successor-in-spirit to [pi-mom](https://github.com/earendil-works/pi/tree/v0.70.6/packages/mom), which was removed from the pi monorepo in April 2026.

pi-dad connects to Slack over Socket Mode, forwards mentions and DMs to an LLM, and posts the reply. It is built for local, Anthropic-compatible servers (LM Studio, oMLX, …), and works with cloud providers too. The agent can run shell commands and read/write files in a workspace — directly on the host or inside a Docker sandbox — and discovers **skills** (workflow instructions + scripts) from the workspace.

**Status: early development.** Per-channel conversation history is kept in process memory only. No persistence, no scheduler, no memory files yet.

## Features

- **Slack**: answers @mentions in channels it's a member of, and DMs. Replies in-thread when mentioned inside a thread. Tool activity (commands run, results) is posted to the thread under each reply, so the channel stays readable but everything is auditable. While the agent works, its commentary between tool calls streams into the reply message as progress — the final reply replaces it, and the thread keeps a permanent copy.
- **Agent loop**: `@earendil-works/pi-agent-core`'s `Agent` with four tools — `bash`, `read`, `write`, `edit` — all routed through the sandbox executor.
- **Sandbox**: `--sandbox=host` runs commands on the host with the workspace as working directory; `--sandbox=docker:<container>` runs them inside a long-lived container with the workspace mounted at `/workspace` (pi-mom's convention — see [Setup](#3-create-the-sandbox-container)).
- **Skills**: every `<workspace>/skills/<name>/SKILL.md` (frontmatter `name:`/`description:`) is listed in the system prompt; the model reads the full instructions on demand and runs the skill's scripts via bash. An optional `channels:` field limits which channels a skill is listed in — see [Skill visibility](#skill-visibility). Skills are re-read on every message, so adding or editing one doesn't need a restart.
- **Context env vars**: each command runs with `DAD_CHANNEL_ID`, `DAD_CHANNEL_NAME`, `DAD_USER_ID` and `DAD_USER_NAME` set, so a skill script knows who is asking and where.
- **Performance metrics**: every LLM call appends one JSON line to `logs/metrics.jsonl` — time to first token, generation time, tokens/second, token usage — measured in the harness, so inference backends (LM Studio, oMLX, a cloud provider) can be compared on equal terms. The log holds numbers only, no message text, and lives outside the workspace so the sandboxed agent can't read harness logs.
- **Interaction log**: every exchange appends one JSON line to `logs/interactions.jsonl` — who asked what in which channel, the reply, and the tool-call trace of how it got there — the raw material for QA and for evaluating one model against another. It shares a `runId` with the metrics lines of the same run, stores full text, and stays outside the workspace like the metrics.

## Requirements

- Node.js >= 22
- A Slack app (setup below)
- A local Anthropic-messages-compatible LLM endpoint, or an API key for a cloud provider
- Docker, if using the Docker sandbox

## Setup

### 1. Create the Slack app

Adapted from pi-mom's setup guide; pi-dad needs a smaller set of scopes.

1. Create a new Slack app at https://api.slack.com/apps ("From scratch"), and pick your workspace.
2. Enable **Socket Mode** (Settings → Socket Mode → Enable). This is what lets the bot run behind a firewall with no public URL — nothing needs to be reachable from the internet.
3. Generate an **App-Level Token** with the `connections:write` scope. This is `DAD_SLACK_APP_TOKEN` (starts with `xapp-`).
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

   The three `*:read` resolution scopes matter more than they look: the channel and user names they return are passed to skill scripts as `DAD_CHANNEL_NAME` / `DAD_USER_NAME`. Without them the lookups fail, the names fall back to `unknown`, and any script that gates on the channel or loads per-user credentials will refuse to run.

   `im:write` is *not* needed, unlike pi-mom's setup: it grants starting DMs (`conversations.open`), and pi-dad only ever replies inside a conversation someone else opened, using the channel id from the event — `chat:write` covers that. Add `im:write` if the bot ever needs to message someone first, e.g. for scheduled notifications.

5. **Subscribe to Bot Events** (Features → Event Subscriptions → Subscribe to bot events):
   - `app_mention`
   - `message.im`

   Note what is *not* here: pi-dad does not subscribe to `message.channels` or `message.groups`, so it never receives — or stores — messages in channels that aren't addressed to it. It only ever sees @mentions and DMs.

6. **Enable direct messages** (Features → App Home → Show Tabs): turn on the **Messages Tab** and check *Allow users to send Slash commands and messages from the messages tab*.
7. Install the app to your workspace (Settings → Install App) and copy the **Bot User OAuth Token**. This is `DAD_SLACK_BOT_TOKEN` (starts with `xoxb-`).
8. Invite the bot to the channels where it should work (`/invite @your-bot`). It only sees channels it has been added to.

### 2. Choose a model

`--provider=local` expects a server exposing an Anthropic-messages endpoint at `--base-url` (default `http://localhost:1234`) — [LM Studio](https://lmstudio.ai/) and oMLX both do, among others. Pass the model id exactly as that server names it: check `curl localhost:1234/v1/models`, and note that ids like `google/gemma-4-26b-a4b` must be given in full.

The id is verified at startup against the server's own `/v1/models` list, when it offers one, because some servers don't reject an unknown id — they quietly answer with whatever model is loaded, and every reply is subtly wrong. For the same reason, each `metrics.jsonl` line carries a `responseModel` field with the model the server claims actually answered — for providers that report it. pi-ai 0.83's Anthropic-messages parser doesn't yet, so for local servers the field is absent and the startup check is the guard that counts.

A cloud model works as well: `--provider=anthropic --model=claude-opus-4-5`, with `ANTHROPIC_API_KEY` in the environment. Credentials are checked at startup rather than on someone's first question.

Which one you run is a data-residency decision as much as a quality one. Everything the agent reads — including whatever a skill's script returns — goes to the model, so a workspace holding sensitive data should be paired with a local one.

### 3. Create the sandbox container

Recommended, so the agent's shell commands can't touch the host. Any long-lived container with the workspace bind-mounted at `/workspace` will do:

```sh
docker run -d \
  --name pi-dad-sandbox \
  -v $(pwd)/workspace:/workspace \
  alpine:latest \
  tail -f /dev/null
```

Install whatever the skills need inside it (Node, `jq`, …), or use an image that already has them. Then run pi-dad with `--sandbox=docker:pi-dad-sandbox`.

## Configuration

Settings are flags. Run `pi-dad --help` for the same list.

| Flag | Default | Description |
|---|---|---|
| `--sandbox=<spec>` | `host` | `host` or `docker:<container>` |
| `--provider=<id>` | `local` | `local`, or any provider in pi-ai's catalog: `anthropic`, `openai`, `google`, … |
| `--model=<id>` | — | **Required.** For `local`, the server's exact id (e.g. `google/gemma-4-26b-a4b`; check `curl localhost:1234/v1/models`). Otherwise a catalog id such as `claude-opus-4-5` — an unknown one lists what's available |
| `--log-dir=<dir>` | `./logs` | Where harness logs (`metrics.jsonl`, `interactions.jsonl`) are written. Rejected if inside the workspace, which the sandboxed agent can read |

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
| `DAD_SLACK_APP_TOKEN` | yes | Slack app-level token (`xapp-…`) |
| `DAD_SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-…`) |
| `DAD_SYSTEM_PROMPT` | no | Replaces the built-in base prompt (environment and skills sections are still appended) |
| `DAD_LOCAL_API_KEY` | no | Key for a local server configured to require one |

Most local servers ignore the API key, so `--provider=local` sends a placeholder to satisfy the transport. Some can be configured to require a real one; a `401 Invalid API key` on the first reply is the sign, and `DAD_LOCAL_API_KEY` is the answer.

## Run

```sh
npm install
DAD_SLACK_APP_TOKEN=xapp-… DAD_SLACK_BOT_TOKEN=xoxb-… \
node src/main.js --sandbox=docker:pi-dad-sandbox --model=google/gemma-4-26b-a4b ./workspace
```

The positional argument is the workspace directory (default `./workspace`). With the Docker sandbox, the container must have that same directory mounted at `/workspace`.

On startup pi-dad prints the identity it connected as, the model and endpoint in use, the sandbox, and the skills it found — worth reading once to confirm the setup took effect:

```
pi-dad connected to Slack as @your-bot (model: local/google/gemma-4-26b-a4b at http://localhost:1234,
sandbox: docker:pi-dad-sandbox, workspace: /workspace, logs: /home/you/pi-dad/logs,
skills: donor-support [donantes, test-david])
```

Skills restricted to particular channels are shown with them in brackets.

To keep it running after you log out, use tmux (`tmux new -s pi-dad`, then `Ctrl+B` `D` to detach, `tmux attach -t pi-dad` to return).

## Tests

```sh
npm test
```

Uses Node's built-in test runner, so there is nothing to install. The suite covers what can be checked without a Slack workspace or a model: skill loading and channel visibility, the sandbox executors, the four tools against a real temp workspace, model resolution for local and cloud providers, the system prompt the agent builds for a given channel, mention resolution, the reply flow (progress, final reply) against a stubbed Slack client, and the logging pipeline (per-call timing against a fake response stream, interaction records with their tool-call trace, the JSONL writer). The Socket Mode transport itself is not covered.

## Design notes

### Differences from pi-mom

pi-dad is not an exact clone of pi-mom:

- **It only sees what's addressed to it.** pi-mom received every message in every channel it belonged to and logged them all; pi-dad gets @mentions and DMs, so ordinary channel conversation never reaches it or gets stored.
- **Conversations don't survive a restart.** History is per-channel and in memory only. pi-mom persisted it and replayed channel history on startup.
- **Long conversations lose their oldest turns** rather than being summarised. pi-mom compacted automatically, which holds far more context but can leave the model reasoning from a stale summary.
- **Local models are first-class.** `--provider=local` is the default and needs no `models.json` or `auth.json`; cloud providers come from pi-ai's catalog when you want one. pi-mom defaulted to Anthropic, and reaching a local server meant maintaining config files by hand.
- **No scheduled events or wake-ups.** pi-mom could wake itself on a schedule or a one-shot event.
- **Under the hood**, it's under 900 lines of plain JavaScript with no build step, against pi-mom's ~4,000 of TypeScript, and it sits directly on `@earendil-works/pi-agent-core`'s `Agent` instead of the heavier `AgentSession` from `pi-coding-agent`. For Slack transport, `@slack/socket-mode` + `@slack/web-api`, no Bolt.

### Skill visibility

A skill can limit which channels it is offered in, with a `channels:` field in its frontmatter:

```yaml
---
name: donor-support
description: Donor administration tasks using the CRM, Stripe and Mailchimp.
channels: [donantes, test-david]
---
```

Entries match either a channel name or a channel id, so `C01ABC…` also works and survives a rename. A skill with no `channels:` field is offered everywhere, which is the right default for low-risk skills like searching public content. Restricted skills are not listed in direct messages, since a DM has no channel name to match.

**This is a visibility control, not a security boundary.** It governs what the model is told about, which is enough to stop it reaching for a sensitive workflow in the wrong place, and it keeps that work in channels where colleagues can see it. It does not stop anything: the skill files are still in the workspace, an `ls` away, and the agent has a shell. Real enforcement — policy the model cannot reach, and credentials it cannot read — is on the [roadmap](#roadmap).

## Roadmap

Roughly in priority order. Nothing here is scheduled.

- **Authorization in the harness.** Today every channel the bot is in can use every tool, and a skill script that checks the channel itself can be talked around by the model, since the model writes the command line. Enforcement belongs in the harness: which channels and which people get tools, the harness building the command rather than the model, and credentials injected per invocation instead of read from the workspace.
- **Confirmation for write operations**, held by the harness — a button in Slack rather than an instruction in the prompt.
- **Memory.** A workspace-wide and a per-channel `MEMORY.md` injected into the prompt, as pi-mom had, so conventions and facts survive between conversations.
- **Thread context.** When mentioned inside an existing thread, read that thread instead of treating the mention as a fresh question.
- **Commands**, such as `!clear` to reset a channel's history or `!<skill>` to invoke a skill directly.

Smaller things still missing: a `stop` command to interrupt a running turn, and file attachments. And with the Docker sandbox, a timeout kills the `docker exec` client on the host but not the command inside the container (a limitation inherited from pi-mom).

## Credits

pi-dad exists because of [Mario Zechner](https://github.com/badlogic)'s work. It is built on his [pi](https://github.com/earendil-works/pi) libraries (`pi-ai` and `pi-agent-core`, MIT), and it follows the design of his **pi-mom** Slack bot (MIT, © Mario Zechner), which Civio ran in production for months before it was removed from the pi monorepo in April 2026.

Conventions taken from pi-mom: the `/workspace` bind-mount and `docker exec` sandbox model, the shape of the tool set (`bash`, `read`, `write`, `edit` routed through an executor), channel-scoped agents, answering in the channel while tool detail goes to the thread, and the context variables passed to every command — renamed here from `MOM_*` to `DAD_*`.

pi-dad began as a port: Civio directed Claude Code to port the core of pi-mom's essential functionality against the current pi libraries, moving TypeScript to JavaScript along the way, and the result was reworked from there. Each file in `src/` carries a header naming the pi-mom file it descends from, linked at tag `v0.70.6` — the last release that still contained the package.

## License

[MIT](LICENSE) © Fundación Ciudadana Civio
