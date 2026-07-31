#!/usr/bin/env node
// Originally based on pi-mom's src/main.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/main.ts

import { parseArgs } from "node:util";
import { createLocalModel } from "./llm.js";
import { createExecutor } from "./sandbox.js";
import { loadSkills } from "./skills.js";
import { AgentPool } from "./agent.js";
import { SlackBot } from "./slack.js";

const USAGE = `pi-dad — a minimal Slack agent harness

Usage: pi-dad [options] [workspace-directory]

Options:
  --sandbox=<spec>          host, or docker:<container> (default: host)
  --model=<id>              model id, exactly as the server names it
  --base-url=<url>          Anthropic-compatible endpoint (default: http://localhost:1234)
  --context-window=<n>      context window to declare (default: 64000)
  --max-tokens=<n>          max output tokens per reply (default: 8192)
  -h, --help                show this help

The workspace directory defaults to ./workspace.

Two settings are environment-only, because neither belongs on a command line —
credentials would show up in the process list, and a system prompt is too long:

  DAD_SLACK_APP_TOKEN       Slack app-level token (xapp-…), required
  DAD_SLACK_BOT_TOKEN       Slack bot token (xoxb-…), required
  DAD_SYSTEM_PROMPT         replaces the built-in base prompt, optional`;

let args;
try {
	args = parseArgs({
		options: {
			sandbox: { type: "string" },
			model: { type: "string" },
			"base-url": { type: "string" },
			"context-window": { type: "string" },
			"max-tokens": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
	});
} catch (error) {
	console.error(`${error.message}\n\n${USAGE}`);
	process.exit(1);
}

if (args.values.help) {
	console.log(USAGE);
	process.exit(0);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required environment variable: ${name}\n\n${USAGE}`);
		process.exit(1);
	}
	return value;
}

const appToken = requireEnv("DAD_SLACK_APP_TOKEN");
const botToken = requireEnv("DAD_SLACK_BOT_TOKEN");
const workspaceDir = args.positionals[0] || "./workspace";
const sandboxSpec = args.values.sandbox ?? "host";

let executor;
try {
	executor = createExecutor(sandboxSpec, workspaceDir);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

if (sandboxSpec === "host") {
	console.warn(
		"\n" +
			"  WARNING: running without a sandbox.\n" +
			"  The agent's bash, read, write and edit tools run directly on this machine,\n" +
			"  as this user, over every file it can reach — including anything outside the\n" +
			`  workspace (${executor.workspacePath}).\n` +
			"  Use --sandbox=docker:<container> to confine them.\n",
	);
}

const skills = await loadSkills(workspaceDir);

const { models, model } = createLocalModel({
	baseUrl: args.values["base-url"] ?? "http://localhost:1234",
	modelId: args.values.model ?? "gemma4",
	contextWindow: Number(args.values["context-window"] ?? 64000),
	maxTokens: Number(args.values["max-tokens"] ?? 8192),
});

const pool = new AgentPool({
	models,
	model,
	executor,
	skills,
	systemPrompt: process.env.DAD_SYSTEM_PROMPT,
});

const bot = new SlackBot({
	appToken,
	botToken,
	onMessage: (ctx) =>
		pool.run(ctx, {
			onToolStart: (name, args) => {
				const snippet = args?.command || args?.path || "";
				return ctx.postDetail(`:hammer_and_wrench: *${name}* \`${String(snippet).slice(0, 200)}\``);
			},
			onToolEnd: (name, detail, isError) => {
				if (isError) return ctx.postDetail(`:warning: *${name}* failed:\n\`\`\`${detail}\`\`\``);
				return detail ? ctx.postDetail(`\`\`\`${detail}\`\`\``) : undefined;
			},
		}),
});

const auth = await bot.start();
console.log(
	`pi-dad connected to Slack as @${auth.user} (model: ${model.id} at ${model.baseUrl}, ` +
		`sandbox: ${sandboxSpec}, workspace: ${executor.workspacePath}, skills: ${
			skills.map((s) => (s.channels ? `${s.name} [${s.channels.join(", ")}]` : s.name)).join(", ") || "none"
		})`,
);

process.on("SIGINT", async () => {
	console.log("Shutting down…");
	await bot.stop();
	process.exit(0);
});
