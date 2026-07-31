#!/usr/bin/env node
import { LlmClient } from "./llm.js";
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

const llm = new LlmClient({
	baseUrl: process.env.DAD_LLM_BASE_URL || "http://localhost:1234",
	modelId: process.env.DAD_MODEL || "gemma4",
	contextWindow: Number(process.env.DAD_CONTEXT_WINDOW || 64000),
	maxTokens: Number(process.env.DAD_MAX_TOKENS || 8192),
	systemPrompt: process.env.DAD_SYSTEM_PROMPT,
});

const bot = new SlackBot({
	appToken,
	botToken,
	onMessage: (channelId, text) => llm.reply(channelId, text),
});

const auth = await bot.start();
console.log(`pi-dad connected to Slack as @${auth.user} (model: ${llm.model.id} at ${llm.model.baseUrl})`);

process.on("SIGINT", async () => {
	console.log("Shutting down…");
	await bot.stop();
	process.exit(0);
});
