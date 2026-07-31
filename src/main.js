#!/usr/bin/env node
import { createLocalModel } from "./llm.js";
import { createExecutor } from "./sandbox.js";
import { loadSkills } from "./skills.js";
import { AgentPool } from "./agent.js";
import { SlackBot } from "./slack.js";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required environment variable: ${name}`);
		process.exit(1);
	}
	return value;
}

const appToken = requireEnv("DAD_SLACK_APP_TOKEN");
const botToken = requireEnv("DAD_SLACK_BOT_TOKEN");
const workspaceDir = process.argv[2] || "./workspace";
const sandboxSpec = process.env.DAD_SANDBOX || "host";

const executor = createExecutor(sandboxSpec, workspaceDir);
const skills = loadSkills(workspaceDir);

const { models, model } = createLocalModel({
	baseUrl: process.env.DAD_LLM_BASE_URL || "http://localhost:1234",
	modelId: process.env.DAD_MODEL || "gemma4",
	contextWindow: Number(process.env.DAD_CONTEXT_WINDOW || 64000),
	maxTokens: Number(process.env.DAD_MAX_TOKENS || 8192),
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
		`sandbox: ${sandboxSpec}, workspace: ${executor.workspacePath}, skills: ${skills.map((s) => s.name).join(", ") || "none"})`,
);

process.on("SIGINT", async () => {
	console.log("Shutting down…");
	await bot.stop();
	process.exit(0);
});
