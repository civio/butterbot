#!/usr/bin/env node
// Originally based on pi-mom's src/main.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/main.ts

import crypto from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { createModel, localModelError } from "./llm.js";
import { JsonlLog } from "./log.js";
import { loadMemory } from "./memory.js";
import { createExecutor } from "./sandbox.js";
import { loadSecrets } from "./secrets.js";
import { loadSkills } from "./skills.js";
import { AgentPool } from "./agent.js";
import { SlackBot, slackHooks } from "./slack.js";

const USAGE = `pi-dad — a minimal Slack agent harness

Usage: pi-dad [options] [workspace-directory]

Options:
  --sandbox=<spec>          host, or docker:<container> (default: host)
  --provider=<id>           local, anthropic, openai, … (default: local)
  --model=<id>              required; for a local server, exactly as it names
                            the model, e.g. google/gemma-4-26b-a4b
  --log-dir=<dir>           harness logs (metrics.jsonl, interactions.jsonl);
                            must be outside the workspace (default: ./logs)
  --secrets-dir=<dir>       per-user credentials, one <slack-handle>.env per
                            person; must be outside the workspace
                            (default: ./secrets)

Local providers only, since a cloud model's own catalog supplies these:
  --base-url=<url>          endpoint (default: http://localhost:1234)
  --context-window=<n>      context window to declare (default: 64000)
  --max-tokens=<n>          max output tokens per reply (default: 8192)

  -h, --help                show this help

The workspace directory defaults to ./workspace. A cloud provider reads its
credentials from the environment in the usual way, e.g. ANTHROPIC_API_KEY.

Two settings are environment-only, because neither belongs on a command line —
credentials would show up in the process list, and a system prompt is too long:

  DAD_SLACK_APP_TOKEN       Slack app-level token (xapp-…), required
  DAD_SLACK_BOT_TOKEN       Slack bot token (xoxb-…), required
  DAD_SYSTEM_PROMPT         replaces the built-in base prompt, optional
  DAD_LOCAL_API_KEY         key for a local server that checks one, optional`;

let args;
try {
	args = parseArgs({
		options: {
			sandbox: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			"log-dir": { type: "string" },
			"secrets-dir": { type: "string" },
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

function usageError(message) {
	console.error(`${message}\n\n${USAGE}`);
	process.exit(1);
}

// A garbage value deserves the same rejection as a garbage flag name:
// Number("abc") is NaN, and llm.js asserts these into the model unchecked.
function intFlag(name, fallback) {
	const raw = args.values[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		usageError(`--${name} must be a positive integer, got "${raw}".`);
	}
	return value;
}

const provider = args.values.provider ?? "local";
if (!args.values.model) usageError("--model is required.");
if (provider !== "local") {
	// Silently ignoring these would look like they had taken effect.
	const localOnly = ["base-url", "context-window", "max-tokens"].filter((flag) => args.values[flag] !== undefined);
	if (localOnly.length) {
		usageError(
			`${localOnly.map((f) => `--${f}`).join(", ")} only appl${localOnly.length > 1 ? "y" : "ies"} to ` +
				`--provider=local; "${provider}" supplies its own model metadata.`,
		);
	}
}

// The workspace is mounted into the sandbox, so everything in it is readable
// by the model: neither what the harness records nor what it holds on people's
// behalf may live there.
const workspaceDir = args.positionals[0] || "./workspace";
const workspaceRoot = path.resolve(workspaceDir);
function dirOutsideWorkspace(flag, fallback) {
	const dir = path.resolve(args.values[flag] ?? fallback);
	if ((dir + path.sep).startsWith(workspaceRoot + path.sep)) {
		usageError(`--${flag} must be outside the workspace (${workspaceRoot}).`);
	}
	return dir;
}

const logDir = dirOutsideWorkspace("log-dir", "./logs");
const secretsDir = dirOutsideWorkspace("secrets-dir", "./secrets");
const metricsLog = new JsonlLog(path.join(logDir, "metrics.jsonl"));
const interactionsLog = new JsonlLog(path.join(logDir, "interactions.jsonl"));

// Everything fatal is resolved before anything is reported, so a real error is
// never buried under the sandbox warning.
const sandboxSpec = args.values.sandbox ?? "host";
let models;
let model;
let executor;
try {
	({ models, model } = createModel({
		provider,
		modelId: args.values.model,
		baseUrl: args.values["base-url"] ?? "http://localhost:1234",
		contextWindow: intFlag("context-window", 64000),
		maxTokens: intFlag("max-tokens", 8192),
		apiKey: process.env.DAD_LOCAL_API_KEY,
	}));
	executor = createExecutor(sandboxSpec, workspaceDir);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

// Fail at startup rather than on someone's first question.
if (provider !== "local" && !(await models.getAuth(model))) {
	console.error(`No credentials found for provider "${provider}". Set its API key in the environment.`);
	process.exit(1);
}
if (provider === "local") {
	const problem = await localModelError(model);
	if (problem) {
		console.error(problem);
		process.exit(1);
	}
}

if (!executor.sandboxed) {
	console.warn(
		"\n" +
			"  WARNING: running without a sandbox.\n" +
			"  The agent's bash, read, write and edit tools run directly on this machine,\n" +
			"  as this user, over every file it can reach — including anything outside the\n" +
			`  workspace (${executor.workspacePath}).\n` +
			"  Use --sandbox=docker:<container> to confine them.\n",
	);
}

// Wiring: the pool answers through the bot, reads skills and secrets from here
// so it needs no paths of its own, and the two JSONL logs hang off its hooks.
const pool = new AgentPool({
	models,
	model,
	executor,
	loadSkills: () => loadSkills(workspaceDir),
	loadMemory: (ctx) => loadMemory(workspaceDir, ctx),
	loadSecrets: (userName) => loadSecrets(secretsDir, userName),
	systemPrompt: process.env.DAD_SYSTEM_PROMPT,
	onLlmCall: (record) => metricsLog.append(record),
	onInteraction: (record) => interactionsLog.append(record),
});

const appToken = requireEnv("DAD_SLACK_APP_TOKEN");
const botToken = requireEnv("DAD_SLACK_BOT_TOKEN");
const bot = new SlackBot({
	appToken,
	botToken,
	// The runId ties together every log line (metrics and interactoins) a run produces
	onMessage: (ctx) => pool.run({ ...ctx, runId: `r_${crypto.randomBytes(4).toString("hex")}` }, slackHooks(ctx)),
});

const auth = await bot.start();
const skills = await loadSkills(workspaceDir);
console.log(
	`pi-dad connected to Slack as @${auth.user} (model: ${provider}/${model.id}${provider === "local" ? ` at ${model.baseUrl}` : ""}, ` +
		`sandbox: ${sandboxSpec}, workspace: ${executor.workspacePath}, logs: ${logDir}, secrets: ${secretsDir}, skills: ${
			skills.map((s) => (s.channels ? `${s.name} [${s.channels.join(", ")}]` : s.name)).join(", ") || "none"
		})`,
);

const shutdown = async () => {
	console.log("Shutting down…");
	await bot.stop();
	process.exit(0);
};
process.on("SIGINT", shutdown); // Ctrl+C in tmux
process.on("SIGTERM", shutdown); // kill, docker stop, systemd
