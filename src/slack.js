import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

// Slack rejects messages longer than 40k characters.
const MAX_MESSAGE_LENGTH = 39000;

export class SlackBot {
	/**
	 * @param onMessage async (channelId, text, userId) => replyText.
	 *   Called once per incoming mention or DM; its return value is posted
	 *   as the reply.
	 */
	constructor({ appToken, botToken, onMessage }) {
		this.socket = new SocketModeClient({ appToken });
		this.web = new WebClient(botToken);
		this.onMessage = onMessage;
		this.botUserId = null;
		this.queues = new Map(); // channelId -> promise chain, serializes replies
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

		let reply;
		try {
			reply = await this.onMessage(event.channel, text, event.user);
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
