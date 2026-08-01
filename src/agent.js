// Originally based on pi-mom's src/agent.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad and rewired to the current pi agent core:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createTools } from "./tools.js";
import { formatSkillsPrompt, skillVisibleIn } from "./skills.js";

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a team, reachable via Slack.
Answer concisely. Format responses as Slack mrkdwn: *bold*, _italic_, \`code\`,
bullet lists with "-". Do not use Markdown headings, tables or [text](url) links.`;

// Cap on per-channel in-memory history (user/assistant/tool messages).
const MAX_HISTORY = 60;

const assistantText = (message) =>
	(message.content || [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

export class AgentPool {
	constructor({ models, model, executor, skills, loadSkills, systemPrompt, onLlmCall }) {
		this.models = models;
		this.model = model;
		this.executor = executor;
		this.skills = skills;
		this.loadSkills = loadSkills; // optional; refreshes this.skills before each run
		this.onLlmCall = onLlmCall; // optional; receives one metrics record per LLM call
		this.basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
		this.channels = new Map(); // channelId -> { agent, env, hooks }
	}

	buildSystemPrompt(ctx) {
		const sandboxNote = this.executor.sandboxed
			? `Commands run inside a Docker sandbox; the workspace is mounted at ${this.executor.workspacePath} (the working directory).`
			: `Commands run on the host; the workspace and working directory is ${this.executor.workspacePath}.`;
		return [
			this.basePrompt,
			`## Environment

Today is ${new Date().toLocaleDateString("en-CA")}.
You can run shell commands with the bash tool. ${sandboxNote}
The environment variables DAD_CHANNEL_ID, DAD_CHANNEL_NAME, DAD_USER_ID and DAD_USER_NAME
identify the current Slack channel and user.`,
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
					// Untested with thinking on: the local provider registers its model
					// with reasoning: false (llm.js), and nothing here surfaces thinking
					// blocks — assistantText() and forwardEvent() read only text blocks,
					// so the thinking would be paid for and dropped. pi-mom posted it to
					// Slack italicised; do that in forwardEvent if this ever changes.
					thinkingLevel: "off",
					tools: createTools(this.executor, () => state.env),
				},
				streamFn: (model, context, options) => this.measure(state, model, this.models.streamSimple(model, context, options)),
			});
			state.agent.subscribe((event) => this.forwardEvent(state, event));
			this.channels.set(channelId, state);
		}
		return state;
	}

	/** Forwards agent events to the current run's Slack hooks. */
	async forwardEvent(state, event) {
		if (event.type === "tool_execution_start") {
			await state.hooks?.onToolStart?.(event.toolName, event.args);
		} else if (event.type === "tool_execution_end") {
			const detail = event.isError
				? String(event.result?.content?.[0]?.text ?? event.result ?? "error")
				: (event.result?.content?.[0]?.text ?? "");
			await state.hooks?.onToolEnd?.(event.toolName, detail, event.isError);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			// Narration between tool calls would otherwise never reach Slack, as
			// run() only returns the last turn's text (pi-mom posted every turn).
			const text = assistantText(event.message);
			if (text) await state.hooks?.onText?.(text);
		}
	}

	/**
	 * Relays an LLM response stream unchanged while timing it for the metrics
	 * hook (one record per call). Measuring each call, rather than around
	 * run(), keeps tool execution out of the numbers and works for any
	 * backend: TTFT is the first content event — "start" only opens the
	 * response — and generation runs from that first event to the last.
	 */
	measure(state, model, inner) {
		if (!this.onLlmCall) return inner;
		const outer = createAssistantMessageEventStream();
		const ts = new Date().toISOString();
		const t0 = performance.now();
		let tFirst = null;
		(async () => {
			let message = null;
			try {
				for await (const event of inner) {
					if (event.type === "done") message = event.message;
					else if (event.type === "error") message = event.error;
					else if (tFirst === null && event.type !== "start") tFirst = performance.now();
					outer.push(event);
				}
			} finally {
				// Pushing done/error already settled outer; this covers an inner
				// stream that ended without either.
				outer.end(message ?? undefined);
			}
			const genMs = tFirst === null ? null : Math.round(performance.now() - tFirst);
			const usage = message?.usage;
			await this.onLlmCall({
				ts,
				runId: state.run?.runId,
				channel: state.run?.channel,
				provider: model.provider,
				model: model.id,
				ttftMs: tFirst === null ? null : Math.round(tFirst - t0),
				genMs,
				tokensPerSec: genMs > 0 && usage?.output ? Math.round((usage.output * 10000) / genMs) / 10 : null,
				input: usage?.input,
				output: usage?.output,
				cacheRead: usage?.cacheRead,
				cacheWrite: usage?.cacheWrite,
				stopReason: message?.stopReason,
			});
		})().catch((error) => console.warn(`metrics: ${error.message}`));
		return outer;
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
	 * @param ctx { channelId, channelName, userId, userName, text, runId }
	 * @param hooks { onToolStart(name, args), onToolEnd(name, detail, isError), onText(text) }
	 */
	async run(ctx, hooks) {
		// Re-read skills so ones added or edited since startup — possibly by the
		// agent itself — take effect without a restart, as they did in pi-mom.
		if (this.loadSkills) this.skills = await this.loadSkills();
		const state = this.channel(ctx);
		state.env = {
			DAD_CHANNEL_ID: ctx.channelId,
			DAD_CHANNEL_NAME: ctx.channelName,
			DAD_USER_ID: ctx.userId,
			DAD_USER_NAME: ctx.userName,
		};
		state.run = { runId: ctx.runId, channel: ctx.channelName }; // stamps this run's metrics records
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
			const reply = assistantText(messages[i]);
			if (reply) return reply;
		}
		return "";
	}
}
