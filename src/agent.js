// Originally based on pi-mom's src/agent.ts (MIT, © Mario Zechner), ported to
// JavaScript for Butterbot and rewired to the current pi agent core:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { serverAnswers } from "./llm.js";
import { createTools } from "./tools.js";
import { formatMemoryPrompt } from "./memory.js";
import { BUILTIN_COMMANDS, formatSkillsPrompt, skillVisibleIn } from "./skills.js";

// The harness converts the reply to Slack's mrkdwn dialect, so the model
// only needs to write plain Markdown. But tables are not supported.
const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a team, reachable via Slack.
Answer concisely, in plain Markdown. Do not use tables: Slack cannot render them,
so use a short list instead.`;

// Cap on per-conversation in-memory history (user/assistant/tool messages).
const MAX_HISTORY = 60;

// How many conversations are kept in memory. Note that each thread in channel
// is its own conversation; when the limit is reached, least recently used are dropped.
const MAX_CONVERSATIONS = 200;

/**
 * One long-lived agent per conversation — a Slack thread, or a DM — each with
 * its own history (trimmed to MAX_HISTORY) and the environment identifying
 * whoever is currently talking to it.
 */
export class AgentPool {
	constructor({ models, model, executor, loadSkills, loadMemory, loadSecrets, systemPrompt, onLlmCall, onInteraction }) {
		this.models = models;
		this.model = model;
		this.executor = executor;
		this.loadSkills = loadSkills; // optional; () => the skills to offer this message
		this.loadMemory = loadMemory; // optional; (ctx) => the memory files for this channel
		this.loadSecrets = loadSecrets; // optional; (userName) => KEY/value secrets on file for them
		this.onLlmCall = onLlmCall; // optional; receives one metrics record per LLM call
		this.onInteraction = onInteraction; // optional; receives one record per exchange
		this.basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
		this.conversations = new Map(); // conversationId -> { agent, env, hooks }
		this.running = new Map(); // channelId -> state of the run in progress there, for !stop
	}

	/**
	 * Answers one message on its channel's agent and returns the reply text,
	 * reporting progress through `hooks` as the turn runs. Appends one
	 * interaction record either way, then throws if the run errored.
	 *
	 * @param ctx { conversationId, channelId, channelName, userId, userName, text,
	 *   source, readThread, runId }
	 * @param hooks { onToolStart(name, args), onToolEnd(name, detail, isError), onText(text) }
	 */
	async run(ctx, hooks) {
		// Skills and memory are re-read on every message, so ones added or edited
		// since startup — possibly by the agent itself — take effect without a
		// restart, as they did in pi-mom. Both travel as locals rather than on
		// `this`: channels run concurrently, and parked at any await here another
		// channel's run could overwrite a shared field before this one builds its
		// prompt — for memory, which is per-channel, that would put one channel's
		// facts in another's prompt.
		const skills = this.loadSkills ? await this.loadSkills() : [];
		const memory = this.loadMemory ? await this.loadMemory(ctx) : null;

    // Collect conversation state.
		const state = this.conversationState(ctx);
		state.env = await this.envFor(ctx);
		state.run = { runId: ctx.runId, channel: ctx.channelName }; // stamps this run's metrics records
		state.hooks = hooks;
		state.agent.state.systemPrompt = this.buildSystemPrompt(ctx, skills, memory);
		this.trimHistory(state.agent);

		// What was said in this thread before Butterbot was brought into it, asked
		// for only while this conversation is new — once it has a history of its
		// own there is nothing to catch up on.
		let threadContext = "";
		if (!state.caughtUp && ctx.readThread) {
			const read = await ctx.readThread();
			if (read !== null) state.caughtUp = true;
			threadContext = read || "";
		}

		// Run the agent prompt, collecting metrics
		const ts = new Date().toISOString();
		const before = state.agent.state.messages.length;
		const t0 = performance.now();
		// Runs in a channel are one at a time (the Slack side queues them), so
		// the channel is enough to find the run !stop means.
		state.stoppedBy = null;
		this.running.set(ctx.channelId, state);
		try {
			await state.agent.prompt(this.buildPrompt(ctx, threadContext, skills));
		} finally {
			state.hooks = null;
			if (this.running.get(ctx.channelId) === state) this.running.delete(ctx.channelId);
		}

		// Collect results. Only this run's messages: scanning the whole channel
		// history would answer with an earlier exchange's reply on a turn that
		// produced no text of its own.
		const error = state.agent.state.errorMessage;
		const answered = state.agent.state.messages.slice(before);
		const reply = this.latestReply(answered);

		// A failed run is rolled back to where it started, to maintain a clean state
		// without error messages and partial runs.
		if (error) {
			state.agent.state.messages = state.agent.state.messages.slice(0, before);
			// The rollback also discards the turn that carried the thread catch-up,
			// when this run had one, so the next message must read the thread again.
			if (threadContext) state.caughtUp = false;
		}

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

		// Stopping is not a failure to explain, and probing a server that is
		// still busy with the aborted request would only delay saying so.
		if (error && state.stoppedBy) return `_Stopped by ${state.stoppedBy}._`;
		if (error) throw new Error(await this.describeError(error));
		return reply;
	}

	/**
	 * Answers a `!command` without the model, or returns null when the message
	 * isn't one — `!skill` included, which goes to the model (see invokedSkill).
	 * Commands are the built-ins plus those skills declare in their
	 * frontmatter, and only the commands of skills visible in this channel
	 * exist here. An empty string means handled, with nothing to post.
	 */
	async command(ctx) {
		const match = /^!(\S+)\s*([\s\S]*)$/.exec(ctx.text);
		if (!match) return null;
		const name = match[1].toLowerCase(); // a phone keyboard capitalises "!Help"
		if (name === "stop") return this.stop(ctx);

		const skills = (this.loadSkills ? await this.loadSkills() : []).filter((skill) => skillVisibleIn(skill, ctx));
		if (name === "help") return formatHelp(skills);
		for (const skill of skills) {
			const command = skill.commands?.find((c) => c.name === name);
			if (command) return this.runCommand(ctx, skill, command, match[2].trim().split(/\s+/).filter(Boolean));
		}
		return null;
	}

	/** Aborts the run in progress in this channel; its own reply says who stopped it. */
	stop(ctx) {
		const state = this.running.get(ctx.channelId);
		if (!state) return "_Nothing to stop._";
		state.stoppedBy = ctx.userName;
		state.agent.abort();
		return "";
	}

	/**
	 * Runs a skill's command script in the sandbox, with the same environment
	 * the model's commands get, and returns its output as the reply. The
	 * arguments are quoted one by one, so they reach the script as words and
	 * are never interpreted by the shell.
	 */
	async runCommand(ctx, skill, command, args) {
		const skillDir = path.posix.dirname(`${this.executor.workspacePath}/${skill.relPath}`);
		const line = [path.posix.join(skillDir, command.run), ...args].map(shellQuote).join(" ");
		const ts = new Date().toISOString();
		const t0 = performance.now();
		let reply;
		let error;
		try {
			const { stdout, stderr, code } = await this.executor.exec(line, { env: await this.envFor(ctx) });
			const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			if (code === 0) {
				reply = output || "_Done._";
			} else {
				error = `exit code ${code}`;
				reply = `:warning: \`!${command.name}\` failed (${error})${output ? `\n\`\`\`${output}\`\`\`` : ""}`;
			}
		} catch (thrown) {
			error = thrown.message;
			reply = `:warning: \`!${command.name}\` failed: ${error}`;
		}

		if (this.onInteraction) {
			try {
				await this.onInteraction({
					ts,
					runId: ctx.runId,
					channel: ctx.channelName,
					conversation: ctx.conversationId,
					source: ctx.source,
					user: ctx.userName,
					query: ctx.text,
					command: `${skill.name}/${command.name}`, // answered without the model
					reply,
					error,
					durationMs: Math.round(performance.now() - t0),
					turns: 0,
					toolCalls: [],
				});
			} catch (hookError) {
				console.warn(`interaction log: ${hookError.message}`);
			}
		}
		return reply;
	}

	/** The environment a message's commands run with: the asker's secrets, then who and where. */
	async envFor(ctx) {
		// Secrets go in first so that a file which happens to define
		// BUTTERBOT_USER_NAME cannot dress this message up as someone else.
		return {
			...(await this.secretsFor(ctx)),
			BUTTERBOT_CHANNEL_ID: ctx.channelId,
			BUTTERBOT_CHANNEL_NAME: ctx.channelName,
			BUTTERBOT_USER_ID: ctx.userId,
			BUTTERBOT_USER_NAME: ctx.userName,
		};
	}

	/**
	 * A failed run's error as Slack shows it. A model server that is down fails
	 * with a bare "Connection error." or "Request timed out.", which doesn't say
	 * what to check, so when the server doesn't answer the reply says so. The
	 * interaction log keeps the original error.
	 */
	async describeError(error) {
		const baseUrl = this.model?.baseUrl;
		if (!baseUrl || (await serverAnswers(baseUrl))) return error;
		return `Can't reach the model at ${baseUrl}, so I can't answer right now (${error})`;
	}

	/**
	 * The skill a message names outright — `!whoami rest…` — or null. Naming
	 * one replaces the matching step, not the mechanics: the skill still runs
	 * by the model reading the instructions file, buildPrompt just orders that
	 * directly instead of leaving the model to spot the skill in its list,
	 * which a small model — or a distracted big one — sometimes misses. Only
	 * skills visible in this channel count, and anything else starting with !
	 * falls through as ordinary text, so a typo gets the model's best guess
	 * rather than silence.
	 */
	invokedSkill(ctx, skills) {
		const match = /^!(\S+)\s*([\s\S]*)$/.exec(ctx.text);
		if (!match) return null;
		// Case-insensitive: a phone keyboard turns "!whoami" into "!Whoami".
		const name = match[1].toLowerCase();
		const skill = skills.find((s) => s.name.toLowerCase() === name && skillVisibleIn(s, ctx));
		return skill ? { skill, input: match[2].trim() } : null;
	}

	/**
	 * What to prompt with: the message, and — on the first turn of a thread
	 * the agent was pulled into — what was said in it beforehand. It goes in as
	 * part of the message rather than as replayed history, because it is
	 * hearsay: read from Slack once, not something this agent took part in.
	 */
	buildPrompt(ctx, threadContext, skills) {
		const invokedSkill = this.invokedSkill(ctx, skills);
		const message = invokedSkill
			? `[${ctx.userName}] invoked the skill "${invokedSkill.skill.name}". Read ` +
				`${this.executor.workspacePath}/${invokedSkill.skill.relPath} with the read tool and follow it exactly.` +
				(invokedSkill.input ? `\nTheir input for it: ${invokedSkill.input}` : "")
			: `[${ctx.userName}]: ${ctx.text}`;

    return threadContext
			? `Earlier messages in this Slack thread, for context:\n\n${threadContext}\n\n${message}`
			: message;
	}

	/**
	 * This conversation's { agent, env, hooks } bundle, building the agent —
	 * tools, event subscription and all — the first time the conversation is
	 * seen. Kept from then on, so its history survives between messages.
	 */
	conversationState(ctx) {
		const conversationId = ctx.conversationId ?? ctx.channelId;
		let state = this.conversations.get(conversationId);
		if (state) {
			// Re-inserting makes this the newest entry, so eviction below kicks oldest.
			this.conversations.delete(conversationId);
			this.conversations.set(conversationId, state);
			return state;
    }

		state = { env: {}, hooks: null };
		state.agent = new Agent({
			initialState: {
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
		this.conversations.set(conversationId, state);

		// Map iterates in insertion order, so this drops the oldest conversation.
		while (this.conversations.size > MAX_CONVERSATIONS) {
			this.conversations.delete(this.conversations.keys().next().value);
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

	buildSystemPrompt(ctx, skills, memory) {
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
The environment variables BUTTERBOT_CHANNEL_ID, BUTTERBOT_CHANNEL_NAME, BUTTERBOT_USER_ID and BUTTERBOT_USER_NAME
identify the current Slack channel and user.${secretsNote}`,
			memory && formatMemoryPrompt(memory, this.executor.workspacePath),
			formatSkillsPrompt(
				skills.filter((skill) => skillVisibleIn(skill, ctx)),
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
			conversation: ctx.conversationId, // the thread, so an eval can follow one
			source: ctx.source, // channel | thread | dm — where the question came from
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

/**
 * What `!help` answers: the commands that work here, then the skills that can
 * be named with `!skill`, which go through the model.
 */
function formatHelp(skills) {
	const lines = ["*Commands* (answered without the model):"];
	for (const [name, description] of Object.entries(BUILTIN_COMMANDS)) lines.push(`• \`!${name}\` — ${description}`);
	for (const skill of skills) {
		for (const command of skill.commands ?? []) {
			lines.push(`• \`!${command.name}\`${command.description ? ` — ${command.description}` : ""} _(${skill.name})_`);
		}
	}
	if (skills.length) {
		lines.push("", `*Skills* (\`!skill\` asks the model to follow one): ${skills.map((s) => `\`!${s.name}\``).join(", ")}`);
	}
	return lines.join("\n");
}

/** Quotes a word for sh, so it reaches the command as-is. */
const shellQuote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
