# pi-dad

A minimal Slack agent harness built on the [pi](https://github.com/earendil-works/pi) AI libraries. Successor-in-spirit to [pi-mom](https://github.com/earendil-works/pi/tree/v0.70.6/packages/mom), which was removed from the pi monorepo in April 2026.

pi-dad connects to Slack over Socket Mode, forwards mentions and DMs to an LLM (designed for local, Anthropic-compatible servers like [LM Studio](https://lmstudio.ai/)), and posts the reply. That's it — deliberately.

**Status: early development.** Current scope: Slack in, LLM out. Per-channel conversation history is kept in process memory only. No tools, no skills, no persistence, no scheduler yet.

## Requirements

- Node.js >= 22
- A Slack app with Socket Mode enabled, an app-level token (`connections:write`) and a bot token with `app_mentions:read`, `chat:write`, `im:history` scopes, subscribed to the `app_mention` and `message.im` events
- An Anthropic-messages-compatible LLM endpoint (e.g. `lms server start` with LM Studio)

## Configuration

Environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAD_SLACK_APP_TOKEN` | yes | — | Slack app-level token (`xapp-…`) |
| `DAD_SLACK_BOT_TOKEN` | yes | — | Slack bot token (`xoxb-…`) |
| `DAD_LLM_BASE_URL` | no | `http://localhost:1234` | Base URL of the Anthropic-compatible endpoint |
| `DAD_MODEL` | no | `gemma4` | Model id to request — must match the server's exact id (e.g. `google/gemma-4-26b-a4b` in LM Studio; check `curl localhost:1234/v1/models`) |
| `DAD_CONTEXT_WINDOW` | no | `64000` | Context window declared to the client |
| `DAD_MAX_TOKENS` | no | `8192` | Max output tokens per reply |
| `DAD_SYSTEM_PROMPT` | no | built-in | Override the system prompt |

## Run

```sh
npm install
DAD_SLACK_APP_TOKEN=xapp-… DAD_SLACK_BOT_TOKEN=xoxb-… node src/main.js
```

The bot answers when @mentioned in a channel it's a member of, and to direct messages. Replies go to the same thread when the mention came from one.

## Design notes

- Built on [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (pinned exact) for the provider/LLM layer; `@slack/socket-mode` + `@slack/web-api` for transport. No Bolt.
- The local provider is registered programmatically via `createProvider()` — no `models.json` needed.
- One reply pipeline per channel, serialized, so concurrent mentions don't interleave.
- Patterns informed by pi-mom (MIT, © Mario Zechner); this codebase is written fresh.

## License

[MIT](LICENSE) © Fundación Ciudadana Civio
