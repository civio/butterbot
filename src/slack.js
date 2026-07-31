// Originally based on pi-mom's src/slack.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/slack.ts

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

// Slack rejects messages longer than 40k characters.
const MAX_MESSAGE_LENGTH = 39000;
const MAX_DETAIL_LENGTH = 1500;

export class SlackBot {
	/**
	 * @param onMessage async (ctx) => replyText, where ctx is
	 *   { channelId, channelName, userId, userName, text, postDetail }.
	 *   postDetail(text) posts into the reply's thread (tool activity).
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

	enqueue(event) {
		const previous = this.queues.get(event.channel) || Promise.resolve();
		const next = previous.then(() => this.handle(event)).catch(() => {});
		this.queues.set(event.channel, next);
	}

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

	async handle(event) {
		const text = (event.text || "").replaceAll(`<@${this.botUserId}>`, "").trim();
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

		let reply;
		try {
			reply = await this.onMessage({
				channelId: event.channel,
				channelName: await this.channelName(event.channel),
				userId: event.user,
				userName: await this.userName(event.user),
				text,
				postDetail,
			});
			if (!reply) reply = "_(empty response)_";
		} catch (error) {
			reply = `:warning: ${error.message}`;
		}
		if (reply.length > MAX_MESSAGE_LENGTH) {
			reply = `${reply.slice(0, MAX_MESSAGE_LENGTH)}\n_(truncated)_`;
		}

		await this.web.chat.update({
			channel: event.channel,
			ts: placeholder.ts,
			text: reply,
		});
	}

	async stop() {
		await this.socket.disconnect();
	}
}
