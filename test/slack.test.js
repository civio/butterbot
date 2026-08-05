import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SlackBot, conversationOf, isFromAPerson, resolveMentions, slackHooks } from "../src/slack.js";

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
		conversations: {
			info: async () => ({ channel: { name: "general" } }),
			replies: async (args) => {
				calls.push(["replies", args]);
				return { messages: [] };
			},
		},
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

	test("the reply reaches Slack as mrkdwn, whatever markdown the model wrote", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async () => "**done**: see [the invoice](https://stripe.com/i/1)",
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", text: "<@UBOT> hi" });

		const updates = calls.filter(([kind]) => kind === "update").map(([, args]) => args.text);
		assert.equal(updates.at(-1), "*done*: see <https://stripe.com/i/1|the invoice>");
	});

	test("answers a channel mention with a message of its own, not in the asker's thread", async () => {
		const calls = [];
		const bot = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "ok" });
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "100.1", text: "<@UBOT> hi" });

		const posts = calls.filter(([kind]) => kind === "post").map(([, args]) => args);
		assert.equal(posts[0].thread_ts, undefined, "threading it onto the question would notify the asker");
		assert.equal(posts[0].reply_broadcast, undefined, "and nothing needs broadcasting back to the channel");
	});

	test("tool activity hangs under the bot's own message, where nobody is subscribed", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async (ctx) => {
				await ctx.postDetail("ran something");
				return "ok";
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "100.1", text: "<@UBOT> hi" });

		const posts = calls.filter(([kind]) => kind === "post").map(([, args]) => args);
		assert.equal(posts[1].thread_ts, posts[0].ts ?? "ts-1", "detail threads under the reply, not the question");
	});

	test("a reply inside someone else's thread stays there, with no placeholder", async () => {
		const calls = [];
		const bot = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "the answer" });
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "300.3", thread_ts: "100.1", text: "<@UBOT> hi" });

		const posts = calls.filter(([kind]) => kind === "post").map(([, args]) => args);
		assert.equal(posts.length, 1, "the answer alone: progress would land in this same thread as well");
		assert.equal(posts[0].thread_ts, "100.1", "it joins the thread it was called into");
		assert.equal(posts[0].text, "the answer");
		assert.equal(calls.filter(([kind]) => kind === "update").length, 0, "nothing to update");
	});

	test("in a thread, narration is posted once and not repeated as the answer", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async (ctx) => {
				// What slackHooks does with the model's prose: both, every turn.
				await Promise.all([ctx.postProgress("Lo miro."), ctx.postDetail("Lo miro.")]);
				await Promise.all([ctx.postProgress("Sí, es socia."), ctx.postDetail("Sí, es socia.")]);
				return "Sí, es socia.";
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "300.3", thread_ts: "100.1", text: "<@UBOT> ¿es socia?" });

		const texts = calls.filter(([kind]) => kind === "post").map(([, args]) => args.text);
		assert.deepEqual(texts, ["Lo miro.", "Sí, es socia."], "each line once, and the answer not said twice");
	});

	test("in a thread, an answer that was never narrated is still posted", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async (ctx) => {
				await ctx.postDetail("```output```");
				return "Sí, es socia.";
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "300.3", thread_ts: "100.1", text: "<@UBOT> ¿es socia?" });

		const texts = calls.filter(([kind]) => kind === "post").map(([, args]) => args.text);
		assert.deepEqual(texts, ["```output```", "Sí, es socia."]);
	});

	test("in a thread, a failure is reported even though nothing was narrated", async () => {
		const calls = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async () => {
				throw new Error("the model went away");
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "C1", user: "U1", ts: "300.3", thread_ts: "100.1", text: "<@UBOT> hi" });

		const texts = calls.filter(([kind]) => kind === "post").map(([, args]) => args.text);
		assert.deepEqual(texts, [":warning: the model went away"]);
	});

	test("answers a DM in the DM, not in a thread", async () => {
		const calls = [];
		const bot = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "ok" });
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		await bot.handle({ channel: "D1", channel_type: "im", user: "U1", ts: "100.1", text: "hi" });

		const [, placeholder] = calls.find(([kind]) => kind === "post");
		assert.equal(placeholder.thread_ts, undefined, "threading a DM would only add a click");
	});

	test("a follow-up in the reply's thread continues the same conversation", async () => {
		const calls = [];
		const seen = [];
		const bot = new SlackBot({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			onMessage: async (ctx) => {
				seen.push(ctx.conversationId);
				return "ok";
			},
		});
		bot.web = fakeWeb(calls);
		bot.botUserId = "UBOT";
		// The question in the channel, then a follow-up in the thread under the reply.
		await bot.handle({ channel: "C1", user: "U1", ts: "100.1", text: "<@UBOT> hi" });
		const replyTs = calls.find(([kind]) => kind === "post")[1] && "ts-1";
		await bot.handle({ channel: "C1", user: "U1", ts: "200.2", thread_ts: replyTs, text: "<@UBOT> and now?" });

		assert.equal(seen[0], "C1:ts-1", "the conversation is named after the reply that roots its thread");
		assert.equal(seen[1], seen[0], "so the follow-up lands in it instead of starting over");
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

describe("conversationOf", () => {
	test("a mention in a thread joins that thread's conversation", () => {
		assert.equal(conversationOf({ channel: "C1", ts: "300.5", thread_ts: "100.1" }, "999.9"), "C1:100.1");
	});

	test("a mention in the channel starts one, named after the reply it gets", () => {
		assert.equal(conversationOf({ channel: "C1", ts: "300.5" }, "400.4"), "C1:400.4");
	});

	test("two questions in one channel are separate conversations", () => {
		const first = conversationOf({ channel: "C1", ts: "100.1" }, "101.1");
		const second = conversationOf({ channel: "C1", ts: "200.2" }, "201.2");
		assert.notEqual(first, second);
	});

	test("a DM is one conversation however many messages it holds", () => {
		const first = conversationOf({ channel: "D1", channel_type: "im", ts: "100.1" }, "101.1");
		const second = conversationOf({ channel: "D1", channel_type: "im", ts: "200.2" }, "201.2");
		assert.equal(first, second, "keying a DM per message would start over every time");
		assert.equal(conversationOf({ channel: "D1", ts: "300.3" }, "301.3"), "D1", "the D prefix is enough on its own");
	});
});

describe("isFromAPerson", () => {
	const said = (extra) => ({ user: "U1MARIA", text: "hola", ...extra });

	test("someone talking", () => {
		assert.equal(isFromAPerson(said(), "UBOT"), true);
	});

	test("keeps the subtypes that are still someone talking", () => {
		assert.equal(isFromAPerson(said({ subtype: "thread_broadcast" }), "UBOT"), true, "a reply also sent to the channel");
		assert.equal(isFromAPerson(said({ subtype: "file_share" }), "UBOT"), true, "a file posted with a comment");
		assert.equal(isFromAPerson(said({ subtype: "me_message" }), "UBOT"), true);
	});

	test("drops Slack narrating itself", () => {
		assert.equal(isFromAPerson(said({ subtype: "channel_join" }), "UBOT"), false);
		assert.equal(isFromAPerson(said({ subtype: "channel_topic" }), "UBOT"), false);
		assert.equal(isFromAPerson({ subtype: "message_deleted" }, "UBOT"), false, "and a deletion has no author at all");
	});

	test("drops apps, and the bot hearing itself", () => {
		assert.equal(isFromAPerson({ bot_id: "B1", text: "posted by an app" }, "UBOT"), false);
		assert.equal(isFromAPerson(said({ subtype: "bot_message", bot_id: "B1" }), "UBOT"), false);
		assert.equal(isFromAPerson({ user: "UBOT", text: "its own words" }, "UBOT"), false);
	});
});

describe("SlackBot.readThread", () => {
	const bot = (messages, replies) => {
		const instance = new SlackBot({ appToken: "xapp-test", botToken: "xoxb-test", onMessage: async () => "ok" });
		instance.botUserId = "UBOT";
		instance.web = {
			conversations: { replies: replies || (async () => ({ messages })) },
			users: { info: async ({ user }) => ({ user: { name: { U1MARIA: "maria", U2DAVID: "david" }[user], profile: {} } }) },
		};
		return instance;
	};
	const mention = { channel: "C1", user: "U2DAVID", ts: "300.3", thread_ts: "100.1", text: "<@UBOT> ¿qué pasó?" };

	test("reads what people said earlier in the thread", async () => {
		const context = await bot([
			{ ts: "100.1", user: "U1MARIA", text: "el pago de Ana ha fallado" },
			{ ts: "200.2", user: "U2DAVID", text: "¿otra vez?" },
			{ ts: "300.3", user: "U2DAVID", text: "<@UBOT> ¿qué pasó?" },
		]).readThread(mention);

		assert.equal(context, "[maria]: el pago de Ana ha fallado\n[david]: ¿otra vez?", "the mention itself is left out");
	});

	test("leaves out the bot's own messages and joins/leaves", async () => {
		const context = await bot([
			{ ts: "100.1", user: "U1MARIA", text: "el pago de Ana ha fallado" },
			{ ts: "150.1", user: "UBOT", text: ":hammer_and_wrench: *bash* `donor-lookup.js`" },
			{ ts: "160.1", user: "U1MARIA", subtype: "channel_join", text: "has joined" },
			{ ts: "170.1", bot_id: "B1", text: "posted by some other app" },
			{ ts: "180.1", user: "U2DAVID", subtype: "thread_broadcast", text: "aviso al canal: lo miro yo" },
		]).readThread(mention);

		assert.equal(
			context,
			"[maria]: el pago de Ana ha fallado\n[david]: aviso al canal: lo miro yo",
			"a reply also sent to the channel is still someone talking in the thread",
		);
	});

	// A page of `count` messages numbered from `from`, as Slack returns them:
	// oldest first, with a cursor when there is more.
	const page = (from, count, has_more) => ({
		messages: Array.from({ length: count }, (_, i) => ({ ts: `${from + i}.0`, user: "U1MARIA", text: `m${from + i}` })),
		has_more,
		response_metadata: { next_cursor: has_more ? `c${from}` : undefined },
	});

	test("pages to the end of a long thread", async () => {
		const cursors = [];
		const instance = bot(null, async ({ cursor }) => {
			cursors.push(cursor);
			return cursors.length === 1 ? page(1, 200, true) : page(201, 5, false);
		});
		const context = await instance.readThread(mention);

		assert.deepEqual(cursors, [undefined, "c1"], "the second page is asked for with the cursor it was given");
		assert.ok(context.includes("[maria]: m1\n"), "the first page is there");
		assert.ok(context.endsWith("[maria]: m205"), "and the newest message is the last word");
	});

	test("over the prompt's worth, the oldest go", async () => {
		const long = (n) => ({ ts: `${n}.0`, user: "U1MARIA", text: `m${n} ${"x".repeat(300)}` });
		const instance = bot(Array.from({ length: 40 }, (_, i) => long(i + 1)));
		const context = await instance.readThread(mention);

		assert.ok(context.length <= 4000, "it is a size of prompt that is being capped");
		assert.ok(context.endsWith("x"), "and it is the messages nearest the question that survive");
		assert.ok(context.includes("[maria]: m40 "), "the newest above all");
		assert.ok(!context.includes("[maria]: m1 "), "the oldest are the ones dropped");
	});

	test("one message longer than the cap is cut, not dropped", async () => {
		const context = await bot([{ ts: "100.1", user: "U1MARIA", text: "x".repeat(9000) }]).readThread(mention);

		assert.equal(context.length, 4000, "there is nothing older to drop, so the message itself gives way");
		assert.ok(context.startsWith("[maria]: xxx"), "and what is kept is the start of it");
	});

	test("says so when a thread is too long to reach the end of", async () => {
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			let calls = 0;
			const instance = bot(null, async () => page(++calls, 1, true)); // never runs out
			await instance.readThread(mention);

			assert.equal(calls, 10, "it stops at the cap rather than paging forever");
			assert.match(warnings[0], /caught up on its beginning only/, "and does not pass it off as the whole thread");
		} finally {
			console.warn = originalWarn;
		}
	});

	test("a mention outside a thread has nothing to catch up on", async () => {
		const instance = bot([]);
		let fetches = 0;
		instance.web.conversations.replies = async () => {
			fetches++;
			return { messages: [] };
		};
		assert.equal(await instance.readThread({ channel: "C1", ts: "300.3" }), "");
		assert.equal(fetches, 0, "and no reason to ask Slack");
	});

	test("a thread it may not read reports so, rather than reporting silence", async () => {
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			const instance = bot([], async () => {
				throw new Error("missing_scope");
			});
			assert.equal(await instance.readThread(mention), null, "null so the caller knows to try again");
			assert.match(warnings[0], /missing_scope/);
		} finally {
			console.warn = originalWarn;
		}
	});
});

describe("slackHooks", () => {
	const recording = () => {
		const details = [];
		const progress = [];
		return {
			details,
			progress,
			ctx: {
				postDetail: async (text) => details.push(text),
				postProgress: async (text) => progress.push(text),
			},
		};
	};

	test("announces a tool call with its command, capped", async () => {
		const { details, ctx } = recording();
		await slackHooks(ctx).onToolStart("bash", { command: "x".repeat(300) });
		assert.match(details[0], /^:hammer_and_wrench: \*bash\* `x{200}`$/, "capped at 200 characters");
	});

	test("marks a failed tool, and stays quiet when a successful one says nothing", async () => {
		const { details, ctx } = recording();
		const hooks = slackHooks(ctx);
		await hooks.onToolEnd("bash", "no such file", true);
		await hooks.onToolEnd("write", "", false);
		assert.deepEqual(details, [":warning: *bash* failed:\n```no such file```"], "no message for empty output");
	});

	test("narration goes to the channel and the thread at once", async () => {
		const { details, progress, ctx } = recording();
		await slackHooks(ctx).onText("Checking the CRM…");
		assert.deepEqual(progress, ["Checking the CRM…"]);
		assert.deepEqual(details, ["Checking the CRM…"]);
	});

	test("narration is converted to mrkdwn on its way out", async () => {
		const { details, progress, ctx } = recording();
		await slackHooks(ctx).onText("Checking the **CRM**…");
		assert.deepEqual(progress, ["Checking the *CRM*…"]);
		assert.deepEqual(details, ["Checking the *CRM*…"]);
	});
});
