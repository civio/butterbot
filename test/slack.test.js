import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveMentions } from "../src/slack.js";

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
