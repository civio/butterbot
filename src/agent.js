// Originally based on pi-mom's src/agent.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad and rewired to the current pi agent core:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createTools } from "./tools.js";
import { formatSkillsPrompt, skillVisibleIn } from "./skills.js";

// The harness converts the reply to Slack's mrkdwn dialect, so the model
// only needs to write plain Markdown. But tables are not supported.
const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a team, reachable via Slack.
Answer concisely, in plain Markdown. Do not use tables: Slack cannot render them,
so use a short list instead.`;

// Cap on per-channel in-memory history (user/assistant/tool messages).
const MAX_HISTORY = 60;

/**
 * One long-lived agent per Slack channel, each with its own conversation
 * history (trimmed to MAX_HISTORY) and the environment identifying whoever is
 * currently talking to it. Also the seam where the two logs are written.
 */
export class AgentPool {
	constructor({ models, model, executor, loadSkills, loadSecrets, systemPrompt, onLlmCall, onInteraction }) {
		this.models = models;
		this.model = model;
		this.executor = executor;
		this.skills = []; // replaced by loadSkills() at the top of every run
		this.loadSkills = loadSkills; // optional; () => the skills to offer this message
		this.loadSecrets = loadSecrets; // optional; (userName) => KEY/value secrets on file for them
		this.onLlmCall = onLlmCall; // optional; receives one metrics record per LLM call
		this.onInteraction = onInteraction; // optional; receives one record per exchange
		this.basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
		this.channels = new Map(); // channelId -> { agent, env, hooks }
	}

	/**
	 * Answers one message on its channel's agent and returns the reply text,
	 * reporting progress through `hooks` as the turn runs. Appends one
	 * interaction record either way, then throws if the run errored.
	 *
	 * @param ctx { channelId, channelName, userId, userName, text, runId }
	 * @param hooks { onToolStart(name, args), onToolEnd(name, detail, isError), onText(text) }
	 */
	async run(ctx, hooks) {
		// Re-read skills so ones added or edited since startup — possibly by the
		// agent itself — take effect without a restart, as they did in pi-mom.
    if (this.loadSkills) this.skills = await this.loadSkills();

    // Collect channel state. Secrets go in first so that a file which happens
    // to define DAD_USER_NAME cannot dress this message up as someone else.
		const state = this.channelState(ctx);
		state.env = {
			...(await this.secretsFor(ctx)),
			DAD_CHANNEL_ID: ctx.channelId,
			DAD_CHANNEL_NAME: ctx.channelName,
			DAD_USER_ID: ctx.userId,
			DAD_USER_NAME: ctx.userName,
		};
		state.run = { runId: ctx.runId, channel: ctx.channelName }; // stamps this run's metrics records
		state.hooks = hooks;
		state.agent.state.systemPrompt = this.buildSystemPrompt(ctx);
		this.trimHistory(state.agent);

		// Run the agent prompt, collecting metrics
		const ts = new Date().toISOString();
		const before = state.agent.state.messages.length;
		const t0 = performance.now();
		try {
			await state.agent.prompt(`[${ctx.userName}]: ${ctx.text}`);
		} finally {
			state.hooks = null;
		}

		// Collect results. Only this run's messages: scanning the whole channel
		// history would answer with an earlier exchange's reply on a turn that
		// produced no text of its own.
		const error = state.agent.state.errorMessage;
		const answered = state.agent.state.messages.slice(before);
		const reply = this.latestReply(answered);

		// Log interaction
		if (this.onInteraction) {
			try {
				await this.onInteraction(
					this.interactionRecord(ctx, answered, ts, Math.round(performance.now() - t0), reply, error),
				);
			} catch (hookError) {
				// The reply must reach Slack even if logging it fails.
				console.warn(`interaction log: ${hookError.message}`);
			}
    }

		if (error) throw new Error(error);
		return reply;
	}

	/**
	 * This channel's { agent, env, hooks } bundle, building the agent — tools,
	 * event subscription and all — the first time the channel is seen. Kept
	 * from then on, so the conversation history survives between messages.
	 */
	channelState(ctx) {
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
					// blocks — extractText() and forwardEvent() read only text blocks,
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

	/**
	 * The secrets to place in this message's environment. The user name
	 * comes from the Slack event, so it is not something the model can talk
	 * its way around; someone with no file of their own simply runs without
	 * credentials, and the scripts that need them fail.
	 *
	 * Loaded per message rather than cached, so no restart needed if changed.
	 */
	async secretsFor(ctx) {
		if (!this.loadSecrets) return {};
		return this.loadSecrets(ctx.userName);
	}

	buildSystemPrompt(ctx) {
		const sandboxNote = this.executor.sandboxed
			? `Commands run inside a Docker sandbox; the workspace is mounted at ${this.executor.workspacePath} (the working directory).`
			: `Commands run on the host; the workspace and working directory is ${this.executor.workspacePath}.`;
		const secretsNote = this.loadSecrets
			? `\nCredentials belonging to whoever is asking are placed in the environment for you. They
are not kept in the workspace, so do not go looking for credential files and do not print a
credential's value. A script reporting a missing token means this person does not have that
credential: say so plainly instead of working around it.`
			: "";
		return [
			this.basePrompt,
			`## Environment

Today is ${new Date().toLocaleDateString("en-CA")}.
You can run shell commands with the bash tool. ${sandboxNote}
The environment variables DAD_CHANNEL_ID, DAD_CHANNEL_NAME, DAD_USER_ID and DAD_USER_NAME
identify the current Slack channel and user.${secretsNote}`,
			formatSkillsPrompt(
				this.skills.filter((skill) => skillVisibleIn(skill, ctx)),
				this.executor.workspacePath,
			),
		]
			.filter(Boolean)
			.join("\n\n");
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
			const text = extractText(event.message);
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
				// What the server claims actually answered; a mismatch with model
				// means it substituted something (e.g. for an id it doesn't have).
				// Absent when the API parser doesn't surface it — pi-ai 0.83's
				// anthropic-messages one doesn't, so local servers rely on the
				// startup check in main.js instead.
				responseModel: message?.responseModel,
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

	/**
	 * The text to post back: the newest assistant message that actually said
	 * something, or "" if the run produced none. Scanning backwards beats
	 * reading the last message, which is usually a tool result — and an
	 * assistant message can be pure tool calls, with no prose to post.
	 */
	latestReply(messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "assistant") continue;
			const text = extractText(messages[i]);
			if (text) return text;
		}
		return "";
	}

	/**
	 * One record per exchange for the interaction log: who asked what and
	 * where, what was answered, and — the part evals will grade — the
	 * tool-call trace of how. Usage and turns are summed over just this
	 * run's messages, not the channel history the calls resent.
	 */
	interactionRecord(ctx, messages, ts, durationMs, reply, error) {
		const assistants = messages.filter((m) => m.role === "assistant");
		const failed = new Set(messages.filter((m) => m.role === "toolResult" && m.isError).map((m) => m.toolCallId));
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const message of assistants) {
			for (const key of Object.keys(usage)) usage[key] += message.usage?.[key] ?? 0;
		}
		return {
			ts,
			runId: ctx.runId,
			channel: ctx.channelName,
			user: ctx.userName,
			query: ctx.text,
			reply,
			error, // undefined on success, and JSON.stringify drops it
			durationMs,
			turns: assistants.length,
			toolCalls: assistants.flatMap((message) =>
				(message.content || [])
					.filter((block) => block.type === "toolCall")
					.map((block) => ({ name: block.name, args: block.arguments, isError: failed.has(block.id) })),
			),
			usage,
		};
	}
}

/**
 * A message's prose: its text blocks joined, dropping tool calls and thinking.
 * Any role will do, so callers that need an assistant message check for it.
 */
const extractText = (message) =>
	(message.content || [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
