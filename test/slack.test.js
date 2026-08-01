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
});
