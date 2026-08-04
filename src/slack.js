// Originally based on pi-mom's src/slack.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/slack.ts

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

// Slack rejects messages longer than 40k characters.
const MAX_MESSAGE_LENGTH = 39000;
const MAX_DETAIL_LENGTH = 1500;

/**
 * Socket Mode connection to Slack: turns channel mentions and DMs into
 * `onMessage` calls — one at a time per channel — and renders the answer as a
 * placeholder message that accumulates progress until the reply replaces it,
 * with tool activity in its thread.
 */
export class SlackBot {
	/**
	 * @param onMessage async (ctx) => replyText, where ctx is
	 *   { channelId, channelName, userId, userName, text, postDetail, postProgress }.
	 *   postDetail(text) posts into the reply's thread (tool activity).
	 *   postProgress(text) accumulates into the reply message while the agent
	 *   works; the final reply replaces it.
	 */
	constructor({ appToken, botToken, onMessage }) {
		this.socket = new SocketModeClient({ appToken });
		this.web = new WebClient(botToken);
		this.onMessage = onMessage;
		this.botUserId = null;
		this.queues = new Map(); // channelId -> promise chain, serializes replies
		this.channelNames = new Map();
		this.userNames = new Map();
	}

	// Connects to Slack and starts the bot.
	async start() {
		const auth = await this.web.auth.test();
		this.botUserId = auth.user_id;

		// Mentions in channels the bot is a member of.
		this.socket.on("app_mention", async ({ event, ack }) => {
			await ack();
			this.enqueue(event);
		});

		// Direct messages. Channel mentions also arrive as "message" events;
		// those are skipped here and handled once via app_mention.
		this.socket.on("message", async ({ event, ack }) => {
			await ack();
			if (event.channel_type !== "im") return;
			if (event.subtype || event.bot_id || event.user === this.botUserId) return;
			this.enqueue(event);
		});

		await this.socket.start();
		return auth;
	}

	// Queues an event to be handled by the bot, with retries and logging on failure.
	enqueue(event) {
		const previous = this.queues.get(event.channel) || Promise.resolve();
		// The catch keeps one failed message from poisoning the channel's queue;
		// log what happened, or the failure would be invisible everywhere.
		const next = previous
			.then(() => this.handle(event))
			.catch((error) => console.warn(`[${event.channel}] dropped message: ${error.message}`));
		this.queues.set(event.channel, next);
	}

	// Resolves the name of a channel by its ID, caching results for efficiency.
	async channelName(channelId) {
		if (!this.channelNames.has(channelId)) {
			try {
				const info = await this.web.conversations.info({ channel: channelId });
				this.channelNames.set(channelId, info.channel.name || "dm");
			} catch {
				this.channelNames.set(channelId, "unknown");
			}
		}
		return this.channelNames.get(channelId);
	}

	// Resolves the name of a user by their ID, caching results for efficiency.
	async userName(userId) {
		if (!this.userNames.has(userId)) {
			try {
				const info = await this.web.users.info({ user: userId });
				const profile = info.user.profile || {};
				this.userNames.set(userId, info.user.name || profile.display_name || "unknown");
			} catch {
				this.userNames.set(userId, "unknown");
			}
		}
		return this.userNames.get(userId);
	}

	// Handles an incoming event, resolving mentions and posting a reply if necessary.
	async handle(event) {
		const text = await resolveMentions(event.text || "", this.botUserId, (id) => this.userName(id));
		if (!text) return;

		// Reply in the same thread if the message came from one.
		const thread_ts = event.thread_ts;
		const placeholder = await this.web.chat.postMessage({
			channel: event.channel,
			thread_ts,
			text: "_…_",
    });

		// Tool activity goes to the thread under the reply (or the existing thread).
		const detailAnchor = thread_ts || placeholder.ts;
		const postDetail = async (detailText) => {
			try {
				await this.web.chat.postMessage({
					channel: event.channel,
					thread_ts: detailAnchor,
					text: detailText.length > MAX_DETAIL_LENGTH ? `${detailText.slice(0, MAX_DETAIL_LENGTH)}…` : detailText,
				});
			} catch {
				// Tool detail is best-effort; never break the reply over it.
			}
		};

		// Intermediate narration accumulates in the placeholder, so the channel
		// shows progress during a long run; the final reply replaces it.
		let progress = "";
		const postProgress = async (progressText) => {
			progress = progress ? `${progress}\n${progressText}` : progressText;
			if (progress.length > MAX_MESSAGE_LENGTH) progress = progress.slice(0, MAX_MESSAGE_LENGTH);
			try {
				await this.web.chat.update({
					channel: event.channel,
					ts: placeholder.ts,
					text: `${progress}\n_…_`,
				});
			} catch {
				// Progress is best-effort, like postDetail; never break the reply over it.
			}
		};

		// Call the LLM agent to process the user's message.
		let reply;
		try {
			reply = await this.onMessage({
				channelId: event.channel,
				channelName: await this.channelName(event.channel),
				userId: event.user,
				userName: await this.userName(event.user),
				text,
				postDetail,
				postProgress,
			});
			if (!reply) reply = "_(empty response)_";
		} catch (error) {
			reply = `:warning: ${error.message}`;
		}
		if (reply.length > MAX_MESSAGE_LENGTH) {
			reply = `${reply.slice(0, MAX_MESSAGE_LENGTH)}\n_(truncated)_`;
		}

		// Post the final reply to the channel.
		try {
			await this.web.chat.update({
				channel: event.channel,
				ts: placeholder.ts,
				text: reply,
			});
		} catch {
			// A duplicate message beats a lost reply — the agent's work is already
			// done. If this fails too, the rejection reaches enqueue's log.
			await this.web.chat.postMessage({ channel: event.channel, thread_ts, text: reply });
		}
	}

	async stop() {
		await this.socket.disconnect();
	}
}

/**
 * The hooks AgentPool calls as a run progresses, each deciding where its output
 * goes: tool calls and their results into the thread, narration into both the
 * channel message and the thread.
 */
export function slackHooks(ctx) {
	return {
		onToolStart: (name, args) => {
			const snippet = args?.command || args?.path || "";
			return ctx.postDetail(`:hammer_and_wrench: *${name}* \`${String(snippet).slice(0, 200)}\``);
		},
		onToolEnd: (name, detail, isError) => {
			if (isError) return ctx.postDetail(`:warning: *${name}* failed:\n\`\`\`${detail}\`\`\``);
			return detail ? ctx.postDetail(`\`\`\`${detail}\`\`\``) : undefined;
		},
		onText: (text) => Promise.all([ctx.postProgress(text), ctx.postDetail(text)]),
	};
}

/**
 * Rewrites user mentions for the model: the bot's own is dropped, anyone else's
 * becomes a readable @name. Resolving also removes the raw <@U…> ids, so a mention
 * echoed back in a reply renders as plain text instead of pinging someone.
 * Exported for testing only.
 */
export async function resolveMentions(text, botUserId, userName) {
	let result = text;
	for (const [mention, userId] of text.matchAll(/<@([A-Z0-9]+)>/g)) {
		result = result.replaceAll(mention, userId === botUserId ? "" : `@${await userName(userId)}`);
	}
	return result.trim();
}
