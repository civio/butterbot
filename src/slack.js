// Originally based on pi-mom's src/slack.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/slack.ts

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { toMrkdwn } from "./mrkdwn.js";

// Slack rejects messages longer than 40k characters.
const MAX_MESSAGE_LENGTH = 39000;
const MAX_DETAIL_LENGTH = 1500;

// How much of a thread reaches the prompt when catching up on one.
const MAX_THREAD_CONTEXT = 4000;
// Slack returns a thread from its first message and offers no way to ask for
// the end, so the newest — the ones that explain the question — are reached by
// paging. Big pages so one call almost always suffices, and a cap on how many,
// so an enormous thread costs a bounded number of calls.
const THREAD_PAGE_SIZE = 200;
const MAX_THREAD_PAGES = 10;

/**
 * Socket Mode connection to Slack: turns channel mentions and DMs into
 * `onMessage` calls — one at a time per channel — and renders the answer as a
 * placeholder message that accumulates progress until the reply replaces it,
 * with tool activity in its thread.
 */
export class SlackBot {
	/**
	 * @param onMessage async (ctx) => replyText, where ctx is
	 *   { conversationId, channelId, channelName, userId, userName, text,
	 *     source, readThread, postDetail, postProgress }.
	 *   readThread() reads the thread this came from, for a conversation being
	 *   met for the first time; "" if there is none, null if it couldn't be read.
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
		this.ownThreads = new Map(); // "channelId:ts" -> did the bot post that thread's first message
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
			if (!isFromAPerson(event, this.botUserId)) return;
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

	/**
	 * The ts of the message a thread hangs from when the bot posted it itself,
	 * and null otherwise. That message is the placeholder that answered the mention
	 * which opened the conversation, and the whole of what the channel sees of
	 * it, so every later answer in the thread belongs in it too.
	 *
	 * We ask Slack instead of remembering, in case a thread outlives the process
	 * that started it.
	 */
	async ownThreadRoot(channelId, threadTs) {
		const key = `${channelId}:${threadTs}`;
		if (!this.ownThreads.has(key)) {
			try {
				const thread = await this.web.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
				this.ownThreads.set(key, thread.messages?.[0]?.user === this.botUserId);
			} catch (error) {
				// Most likely the same missing history scope readThread copes with.
				// Nothing is cached: a failed read is worth trying again.
				console.warn(`[${channelId}] could not read the thread's first message: ${error.message}`);
				return null;
			}
		}
		return this.ownThreads.get(key) ? threadTs : null;
	}

	/**
	 * The last of what people said in the thread this event is in, ready to be
	 * given to the model: "" when there is no thread to catch up on, and null
	 * when the thread could not be read — a distinction the caller needs, since
	 * nothing to read is settled and a failed read is worth trying again.
	 */
	async readThread(event) {
		if (!event.thread_ts) return "";

		// Paged through to the end, since it is the messages next to the question
		// that explain it. How much of what comes back is used is decided below,
		// on the formatted text, where the limit that matters is a size of prompt
		// rather than a number of messages.
		const messages = [];
		let cursor;
		let unread = false;
		try {
			for (let page = 0; ; page++) {
				const replies = await this.web.conversations.replies({
					channel: event.channel,
					ts: event.thread_ts,
					limit: THREAD_PAGE_SIZE,
					cursor,
				});
				messages.push(...(replies.messages || []));
				cursor = replies.response_metadata?.next_cursor;
				if (!replies.has_more || !cursor) break;
				if (page + 1 >= MAX_THREAD_PAGES) {
					unread = true;
					break;
				}
			}
		} catch (error) {
			// Most likely a missing history scope, which only costs the catch-up:
			// answering the question at hand does not depend on it.
			console.warn(`[${event.channel}] could not read the thread: ${error.message}`);
			return null;
		}

		// Said out loud rather than passed off as the whole thread: past this many
		// messages the catch-up is the start of the conversation, not the end of it.
		if (unread) {
			console.warn(
				`[${event.channel}] thread longer than ${MAX_THREAD_PAGES * THREAD_PAGE_SIZE} messages; caught up on its beginning only`,
			);
		}

		// Only what people wrote is returned. The bot's own messages in a thread are
    // mostly narration and tool output, and telling those apart from its answers
    // after the fact is guesswork — better to leave them all out than to feed it
    // a transcript of itself thinking out loud.
		const lines = [];
		for (const message of messages) {
			// The mention being answered is the caller's job, not context for it.
      if (message.ts === event.ts) continue;

      if (!isFromAPerson(message, this.botUserId)) continue;

      const said = await resolveMentions(message.text || "", this.botUserId, (id) => this.userName(id));
			if (said) lines.push(`[${await this.userName(message.user)}]: ${said}`);
		}

		// Over the cap the oldest go: the messages nearest the question are the
		// ones that explain it. The last one is never dropped, though, so we
		// always have some context.
		let context = lines.join("\n");
		while (context.length > MAX_THREAD_CONTEXT && lines.length > 1) {
			lines.shift();
			context = lines.join("\n");
    }
		// Slice needed in case the only line is over the cap
		return context.slice(0, MAX_THREAD_CONTEXT);
	}

	// Handles an incoming event, resolving mentions and posting a reply if necessary.
	async handle(event) {
		const text = await resolveMentions(event.text || "", this.botUserId, (id) => this.userName(id));
		if (!text) return;

		// When responding to a mention from a channel, we use a placeholder message
		// in the channel to show something is happening, while we post updates in
		// a thread. Note the threaded details hang from the placeholder, not from
		// the mention itself. The user would otherwise get notified by Slack
		// automatically at every step, at every tool call, which is quite annoying.
		//
		// When responding in a thread, though, no placeholder is posted: progress and
		// tool activity go to the thread directly.
		const thread_ts = event.thread_ts;
		const placeholder = thread_ts
			? null
			: await this.web.chat.postMessage({
					channel: event.channel,
					text: "_…_",
				});

		// The thread may nonetheless be one of ours, hanging from the placeholder of
		// the mention that opened the conversation. That message is all the channel
		// sees of it, so the answer to a follow-up replaces it too — or the channel
		// would be left showing the first one as if nothing had happened since.
		// Only the answer, though: the narration on the way to it stays in the thread,
		// as it does for any other message asked there.
		const channelMessage = placeholder ? placeholder.ts : await this.ownThreadRoot(event.channel, thread_ts);

		// Name the conversation. After the placeholder is posted, since in-channel
		// replies are threaded under the placeholder, not the original event.
		const conversationId = conversationOf(event, channelMessage);

		// Tool activity goes to the thread under the reply (or the existing thread).
		const detailAnchor = thread_ts || channelMessage;
		let lastPosted = "";
		const postDetail = async (detailText) => {
			try {
				await this.web.chat.postMessage({
					channel: event.channel,
					thread_ts: detailAnchor,
					text: detailText.length > MAX_DETAIL_LENGTH ? `${detailText.slice(0, MAX_DETAIL_LENGTH)}…` : detailText,
				});
				lastPosted = detailText;
			} catch {
				// Tool detail is best-effort; never break the reply over it.
			}
		};

		// Intermediate narration accumulates in the placeholder, so the channel
		// shows progress during a long run; the final reply replaces it. With no
		// placeholder to grow, the narration has already been posted by postDetail.
		let progress = "";
		const postProgress = async (progressText) => {
			if (!placeholder) return;
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
				conversationId,
				channelId: event.channel,
				channelName: await this.channelName(event.channel),
				userId: event.user,
				userName: await this.userName(event.user),
				text,
				// The handler will call this function if it needs the thread text.
				readThread: () => this.readThread(event),
				source: sourceOf(event),
				postDetail,
				postProgress,
			});
			reply = toMrkdwn(reply);  // Translate to Slack's mrkdwn dialect
			if (!reply) reply = "_(empty response)_";
		} catch (error) {
			reply = `:warning: ${error.message}`;
		}
		if (reply.length > MAX_MESSAGE_LENGTH) {
			reply = `${reply.slice(0, MAX_MESSAGE_LENGTH)}\n_(truncated)_`;
		}

		// When responding in a thread, the answer goes there — unless it is the last
		// thing said, the model's closing words having been posted already as they
		// streamed; avoid duplication.
		if (thread_ts && reply !== lastPosted) {
			await this.web.chat.postMessage({ channel: event.channel, thread_ts, text: reply });
		}

		// And the message in the channel is brought up to date with the answer,
		// replacing either the placeholder just posted or whatever this conversation
		// last had to say.
		if (!channelMessage) return;
		try {
			await this.web.chat.update({
				channel: event.channel,
				ts: channelMessage,
				text: reply,
			});
		} catch (error) {
			// Answering a mention, the edit that just failed was the only copy of the
			// answer: a duplicate message beats losing it, the agent's work being done.
			// If this fails too, the rejection reaches enqueue's log. In a thread the
			// answer is posted there already, so all a failed update costs is a stale
			// message in the channel, and saying so in the log is enough.
			if (thread_ts) console.warn(`[${event.channel}] could not update the channel message: ${error.message}`);
			else await this.web.chat.postMessage({ channel: event.channel, text: reply });
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
		// Narration is the model's prose, so it needs translating; the strings
		// above are written here and already in Slack's dialect.
		onText: (text) => {
			const converted = toMrkdwn(text);
			return Promise.all([ctx.postProgress(converted), ctx.postDetail(converted)]);
		},
	};
}

/**
 * Which conversation an event belongs to. A conversation is a thread, and each
 * has an agent and a history of its own, so two questions asked in the same
 * channel cannot end up answering each other.
 *
 * Named after the message its thread hangs from, which is:
 *   - in a thread — that thread's parent, `thread_ts` on the event
 *   - in a channel — the reply just posted, since the rest of the exchange will
 *     hang from it. Hence `replyTs`: it takes the bot having spoken.
 *   - in a DM — nothing. A DM has no thread worth the name, so the channel is
 *     the conversation; keying it per message would start over on every one.
 *
 * Exported for testing only.
 */
export function conversationOf(event, replyTs) {
	if (event.thread_ts) return `${event.channel}:${event.thread_ts}`;
	if (isDirectMessage(event)) return event.channel;
	return `${event.channel}:${replyTs}`;
}

/**
 * Where a mention came from, recorded on every interaction:
 *   - `channel` — opens a conversation and carries its own question, so the
 *     exchange stands on its own. The one to filter an eval set to.
 *   - `thread` — continues something: either an earlier exchange, which the log
 *     holds under the same conversation, or a thread pi-dad was pulled into.
 *   - `dm` — a private line, one conversation for the whole channel.
 *
 * Useful for filtering the interaction log (e.g. to build eval datasets):
 * interactions started in a thread can't be replayed, so they should be filtered
 * out when building an eval set.
 */
const sourceOf = (event) => (isDirectMessage(event) ? "dm" : event.thread_ts ? "thread" : "channel");

/**
 * Slack gives DM channels ids beginning with D. The channel_type field would
 * say so too, but only `message` events carry it — and taking a DM for a
 * channel would start a fresh conversation on every message sent.
 */
const isDirectMessage = (event) => event.channel_type === "im" || event.channel.startsWith("D");

/**
 * Whether a message is a person talking: not an app posting, not Slack
 * narrating itself, and not the bot's own voice coming back to it.
 * Exported for testing only.
 */
export function isFromAPerson(message, botUserId) {
	// A message carries a subtype when it isn't a plain thing someone typed.
	// These three still hold something a person wrote — a reply also sent to the
	// channel, a file posted with a comment, a /me. Every other subtype is a
	// system notice: joins and leaves, topic changes, the stub left by a deletion.
	const contentSubtypes = ["thread_broadcast", "file_share", "me_message"];
	return (
		Boolean(message.user) &&
		message.user !== botUserId &&
		!message.bot_id &&
		(!message.subtype || contentSubtypes.includes(message.subtype))
	);
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
