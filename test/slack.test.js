import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SlackBot, resolveMentions } from "../src/slack.js";

const lookup = (id) => Promise.resolve({ U1MARIA: "maria", U2DAVID: "david" }[id] || "unknown");

describe("resolveMentions", () => {
	test("drops the bot's own mention", async () => {
		assert.equal(await resolveMentions("<@UBOT> do the thing", "UBOT", lookup), "do the thing");
	});

	test("resolves other users' mentions to readable names", async () => {
		assert.equal(
			await resolveMentions("<@UBOT> ask <@U1MARIA> about the Stripe export", "UBOT", lookup),
			"ask @maria about the Stripe export",
		);
	});

	test("resolves multiple and repeated mentions", async () => {
		assert.equal(
			await resolveMentions("<@U1MARIA> and <@U2DAVID>, mostly <@U1MARIA>", "UBOT", lookup),
			"@maria and @david, mostly @maria",
		);
	});

	test("leaves text without mentions unchanged", async () => {
		assert.equal(await resolveMentions("no mentions here", "UBOT", lookup), "no mentions here");
	});

	test("falls back to the lookup's answer for an unknown user", async () => {
		assert.equal(await resolveMentions("ping <@U9GONE>", "UBOT", lookup), "ping @unknown");
	});
});

describe("SlackBot.handle", () => {
	// The web client is stubbed: these tests exercise the message flow, not Slack.
	const fakeWeb = (calls) => ({
		chat: {
			postMessage: async (args) => {
				calls.push(["post", args]);
				return { ts: `ts-${calls.length}` };
			},
			update: async (args) => calls.push(["update", args]),
		},
		conversations: { info: async () => ({ channel: { name: "general" } }) },
		users: { info: async () => ({ user: { name: "david", profile: {} } }) },
	});

	test("streams progress into the placeholder, then replaces it with the reply", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async (ctx) => {
				await ctx.postProgress("Checking the CRM…");
				await ctx.postProgress("Found it; drafting a reply.");
				return "done";
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", text: "<@UBOT> hi" });

		const updates = calls.filter(([kind]) => kind === "update").map(([, args]) => args.text);
		assert.equal(updates[0], "Checking the CRM…\n_…_", "progress shows with a still-working marker");
		assert.equal(updates[1], "Checking the CRM…\nFound it; drafting a reply.\n_…_", "progress accumulates");
		assert.equal(updates.at(-1), "done", "the final reply replaces the progress");
	});

	test("falls back to a new message when updating the placeholder fails", async () => {
		const calls = [];
		const web = fakeWeb(calls);
		web.chat.update = async () => {
			throw new Error("ratelimited");
		};
		const bot = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "the reply" });
		bot.web = web;
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", text: "<@UBOT> hi" });

		const posts = calls.filter(([kind]) => kind === "post").map(([, args]) => args.text);
		assert.ok(posts.includes("the reply"), "a duplicate message beats a lost reply");
	});

	test("a failed message is logged and does not block the channel's queue", async () => {
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			const calls = [];
			const web = fakeWeb(calls);
			const workingPost = web.chat.postMessage;
			let failures = 1;
			web.chat.postMessage = async (args) => {
				if (failures-- > 0) throw new Error("channel_not_found");
				return workingPost(args);
			};
			const bot = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "ok" });
			bot.web = web;
			bot.botUserId = "UBOT";
			bot.enqueue({ channel: "C1", user: "U1", text: "<@UBOT> one" });
			bot.enqueue({ channel: "C1", user: "U1", text: "<@UBOT> two" });
			await bot.queues.get("C1");

			assert.equal(warnings.length, 1, "the dropped message is logged");
			assert.match(warnings[0], /channel_not_found/);
			const updates = calls.filter(([kind]) => kind === "update");
			assert.equal(updates.at(-1)[1].text, "ok", "the second message still got its reply");
		} finally {
			console.warn = originalWarn;
		}
	});
});
