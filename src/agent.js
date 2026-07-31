// Originally based on pi-mom's src/agent.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad and rewired to the current pi agent core:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import { Agent } from "@earendil-works/pi-agent-core";
import { createTools } from "./tools.js";
import { formatSkillsPrompt, skillVisibleIn } from "./skills.js";

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a team, reachable via Slack.
Answer concisely. Format responses as Slack mrkdwn: *bold*, _italic_, \`code\`,
bullet lists with "-". Do not use Markdown headings, tables or [text](url) links.`;

// Cap on per-channel in-memory history (user/assistant/tool messages).
const MAX_HISTORY = 60;

export class AgentPool {
	constructor({ models, model, executor, skills, systemPrompt }) {
		this.models = models;
		this.model = model;
		this.executor = executor;
		this.skills = skills;
		this.basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
		this.channels = new Map(); // channelId -> { agent, env, hooks }
	}

	buildSystemPrompt(ctx) {
		const sandboxNote =
			this.executor.constructor.name === "DockerExecutor"
				? `Commands run inside a Docker sandbox; the workspace is mounted at ${this.executor.workspacePath} (the working directory).`
				: `Commands run on the host; the workspace and working directory is ${this.executor.workspacePath}.`;
		return [
			this.basePrompt,
			`## Environment

Today is ${new Date().toISOString().slice(0, 10)}.
You can run shell commands with the bash tool. ${sandboxNote}
The environment variables DAD_CHANNEL_ID, DAD_CHANNEL_NAME, DAD_USER_ID and DAD_USER_NAME
(and legacy MOM_* equivalents) identify the current Slack channel and user.`,
			formatSkillsPrompt(
				this.skills.filter((skill) => skillVisibleIn(skill, ctx)),
				this.executor.workspacePath,
			),
		]
			.filter(Boolean)
			.join("\n\n");
	}

	channel(ctx) {
		const channelId = ctx.channelId;
		let state = this.channels.get(channelId);
		if (!state) {
			state = { env: {}, hooks: null };
			state.agent = new Agent({
				initialState: {
					systemPrompt: this.buildSystemPrompt(ctx),
					model: this.model,
					thinkingLevel: "off",
					tools: createTools(this.executor, () => state.env),
				},
				streamFn: (model, context, options) => this.models.streamSimple(model, context, options),
			});
			state.agent.subscribe(async (event) => {
				if (event.type === "tool_execution_start") {
					await state.hooks?.onToolStart?.(event.toolName, event.args);
				} else if (event.type === "tool_execution_end") {
					const detail = event.isError
						? String(event.result?.content?.[0]?.text ?? event.result ?? "error")
						: (event.result?.content?.[0]?.text ?? "");
					await state.hooks?.onToolEnd?.(event.toolName, detail, event.isError);
				}
			});
			this.channels.set(channelId, state);
		}
		return state;
	}

	trimHistory(agent) {
		const messages = agent.state.messages;
		if (messages.length <= MAX_HISTORY) return;
		let start = messages.length - MAX_HISTORY;
		// Never start the transcript on a non-user message: a tool result or
		// assistant turn without its predecessors breaks the provider request.
		while (start < messages.length && messages[start].role !== "user") start++;
		agent.state.messages = messages.slice(start);
	}

	/**
	 * @param ctx { channelId, channelName, userId, userName, text }
	 * @param hooks { onToolStart(name, args), onToolEnd(name, detail, isError) }
	 */
	async run(ctx, hooks) {
		const state = this.channel(ctx);
		state.env = {
			DAD_CHANNEL_ID: ctx.channelId,
			DAD_CHANNEL_NAME: ctx.channelName,
			DAD_USER_ID: ctx.userId,
			DAD_USER_NAME: ctx.userName,
			// Legacy names so pi-mom-era skills keep working unchanged.
			MOM_CHANNEL_ID: ctx.channelId,
			MOM_CHANNEL_NAME: ctx.channelName,
			MOM_USER_ID: ctx.userId,
			MOM_USER_NAME: ctx.userName,
		};
		state.hooks = hooks;
		state.agent.state.systemPrompt = this.buildSystemPrompt(ctx);
		this.trimHistory(state.agent);

		try {
			await state.agent.prompt(`[${ctx.userName}]: ${ctx.text}`);
		} finally {
			state.hooks = null;
		}

		if (state.agent.state.errorMessage) {
			throw new Error(state.agent.state.errorMessage);
		}
		const messages = state.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "assistant") continue;
			const reply = (messages[i].content || [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (reply) return reply;
		}
		return "";
	}
}
