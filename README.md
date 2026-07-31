# pi-dad

A minimal Slack agent harness built on the [pi](https://github.com/earendil-works/pi) AI libraries. Successor-in-spirit to [pi-mom](https://github.com/earendil-works/pi/tree/v0.70.6/packages/mom), which was removed from the pi monorepo in April 2026.

pi-dad connects to Slack over Socket Mode, forwards mentions and DMs to an LLM (designed for local, Anthropic-compatible servers like [LM Studio](https://lmstudio.ai/)), and posts the reply. The agent can run shell commands and read/write files in a workspace — directly on the host or inside a Docker sandbox — and discovers **skills** (workflow instructions + scripts) from the workspace.

**Status: early development.** Per-channel conversation history is kept in process memory only. No persistence, no scheduler, no memory files yet.

## Features

- **Slack**: answers @mentions in channels it's a member of, and DMs. Replies in-thread when mentioned inside a thread. Tool activity (commands run, results) is posted to the thread under each reply, so the channel stays readable but everything is auditable.
- **Agent loop**: `@earendil-works/pi-agent-core`'s `Agent` with four tools — `bash`, `read`, `write`, `edit` — all routed through the sandbox executor.
- **Sandbox**: `DAD_SANDBOX=host` runs commands on the host with the workspace as working directory; `DAD_SANDBOX=docker:<container>` runs them inside a long-lived container with the workspace mounted at `/workspace` (pi-mom's convention: any container with a bind mount works, e.g. `docker run -d --name sandbox -v $(pwd)/data:/workspace alpine tail -f /dev/null`).
- **Skills**: every `<workspace>/skills/<name>/SKILL.md` (frontmatter `name:`/`description:`) is listed in the system prompt; the model reads the full instructions on demand and runs the skill's scripts via bash.
- **Context env vars**: each command runs with `DAD_CHANNEL_ID`, `DAD_CHANNEL_NAME`, `DAD_USER_ID`, `DAD_USER_NAME` set (plus legacy `MOM_*` aliases, so pi-mom-era skill scripts work unchanged).

## Requirements

- Node.js >= 22
- A Slack app with Socket Mode enabled, an app-level token (`connections:write`) and a bot token with `app_mentions:read`, `chat:write`, `im:history` scopes, subscribed to the `app_mention` and `message.im` events
- An Anthropic-messages-compatible LLM endpoint (e.g. `lms server start` with LM Studio)
- Docker, if using the Docker sandbox

## Configuration

Environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAD_SLACK_APP_TOKEN` | yes | — | Slack app-level token (`xapp-…`) |
| `DAD_SLACK_BOT_TOKEN` | yes | — | Slack bot token (`xoxb-…`) |
| `DAD_SANDBOX` | no | `host` | `host` or `docker:<container>` |
| `DAD_LLM_BASE_URL` | no | `http://localhost:1234` | Base URL of the Anthropic-compatible endpoint |
| `DAD_MODEL` | no | `gemma4` | Model id to request — must match the server's exact id (e.g. `google/gemma-4-26b-a4b` in LM Studio; check `curl localhost:1234/v1/models`) |
| `DAD_CONTEXT_WINDOW` | no | `64000` | Context window declared to the client |
| `DAD_MAX_TOKENS` | no | `8192` | Max output tokens per reply |
| `DAD_SYSTEM_PROMPT` | no | built-in | Override the base system prompt (environment and skills sections are appended) |

## Run

```sh
npm install
DAD_SLACK_APP_TOKEN=xapp-… DAD_SLACK_BOT_TOKEN=xoxb-… \
DAD_SANDBOX=docker:sandbox \
node src/main.js ./workspace
```

The positional argument is the workspace directory (default `./workspace`). With the Docker sandbox, the container must have that same directory mounted at `/workspace`.

## Design notes

- Built on `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` (pinned exact) for the provider and agent layers; `@slack/socket-mode` + `@slack/web-api` for transport. No Bolt.
- The local provider is registered programmatically via `createProvider()` — no `models.json` needed.
- One agent per channel, replies serialized per channel, so concurrent mentions don't interleave.

## Credits

pi-dad exists because of [Mario Zechner](https://github.com/badlogic)'s work. It is built on his [pi](https://github.com/earendil-works/pi) libraries (`pi-ai` and `pi-agent-core`, MIT), and it follows the design of his **pi-mom** Slack bot (MIT, © Mario Zechner), which Civio ran in production for months before it was removed from the pi monorepo in April 2026.

Conventions taken from pi-mom: the `/workspace` bind-mount and `docker exec` sandbox model, the shape of the tool set (`bash`, `read`, `write`, `edit` routed through an executor), channel-scoped agents, answering in the channel while tool detail goes to the thread, and the `MOM_*` context variable names — kept here as aliases so skill scripts written for pi-mom keep working unchanged.

pi-dad began as a port: Civio directed Claude Code to port the core of pi-mom's essential functionality against the current pi libraries, moving TypeScript to JavaScript along the way, and the result was reworked from there. Each file in `src/` carries a header naming the pi-mom file it descends from, linked at tag `v0.70.6` — the last release that still contained the package.

## License

[MIT](LICENSE) © Fundación Ciudadana Civio
