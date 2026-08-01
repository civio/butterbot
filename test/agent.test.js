import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentPool } from "../src/agent.js";
import { DockerExecutor, HostExecutor } from "../src/sandbox.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SKILLS = [
	{ name: "public-search", description: "Search public content.", relPath: "skills/public-search/SKILL.md", channels: null },
	{ name: "donor", description: "Donor stuff.", relPath: "skills/donor/SKILL.md", channels: ["donantes"] },
];

const pool = (executor, skills = SKILLS) => new AgentPool({ models: null, model: null, executor, skills });

describe("buildSystemPrompt", () => {
	const executor = new HostExecutor("/tmp/ws");

	test("lists an unrestricted skill everywhere", () => {
		const prompt = pool(executor).buildSystemPrompt({ channelName: "random", channelId: "C1" });
		assert.match(prompt, /public-search/);
	});

	test("lists a restricted skill only in its channels", () => {
		const inChannel = pool(executor).buildSystemPrompt({ channelName: "donantes", channelId: "C1" });
		assert.match(inChannel, /donor/);

		const elsewhere = pool(executor).buildSystemPrompt({ channelName: "equipo", channelId: "C2" });
		assert.equal(/skills\/donor/.test(elsewhere), false, "a hidden skill leaks neither name nor path");
		assert.match(elsewhere, /public-search/, "but the unrestricted one is still there");
	});

	test("hides restricted skills in a DM", () => {
		const prompt = pool(executor).buildSystemPrompt({ channelName: "dm", channelId: "D1" });
		assert.equal(/skills\/donor/.test(prompt), false);
	});

	test("omits the skills section entirely when nothing is visible", () => {
		const restrictedOnly = [SKILLS[1]];
		const prompt = pool(executor, restrictedOnly).buildSystemPrompt({ channelName: "equipo", channelId: "C2" });
		assert.equal(/## Skills/.test(prompt), false);
	});

	test("dates the prompt as ISO, in local time", () => {
		// en-CA formats as YYYY-MM-DD but, unlike toISOString(), in the local
		// timezone — UTC is yesterday until 1-2am Madrid time.
		const prompt = pool(executor).buildSystemPrompt({ channelName: "c", channelId: "C1" });
		assert.match(prompt, /Today is \d{4}-\d{2}-\d{2}\./);
	});

	test("describes the sandbox the tools actually run in", () => {
		const onHost = pool(new HostExecutor("/tmp/ws")).buildSystemPrompt({ channelName: "c", channelId: "C1" });
		assert.match(onHost, /run on the host/);

		const inDocker = pool(new DockerExecutor("some-container")).buildSystemPrompt({ channelName: "c", channelId: "C1" });
		assert.match(inDocker, /Docker sandbox/);
		assert.match(inDocker, /\/workspace/);
	});
});

describe("run", () => {
	test("reloads skills before each message", async () => {
		let skills = [];
		const pool = new AgentPool({
			models: null,
			model: null,
			executor: new HostExecutor("/tmp/ws"),
			skills,
			loadSkills: async () => skills,
		});
		// Seed a channel with a minimal fake agent: run() only needs state and prompt().
		const fakeAgent = { state: { messages: [], systemPrompt: "" }, prompt: async () => {} };
		pool.channels.set("C1", { agent: fakeAgent, env: {}, hooks: null });

		// A skill that appears after startup — e.g. written by the agent itself.
		skills = [{ name: "fresh-skill", description: "Added later.", relPath: "skills/fresh-skill/SKILL.md", channels: null }];
		await pool.run({ channelId: "C1", channelName: "general", userId: "U1", userName: "david", text: "hi" }, {});
		assert.match(fakeAgent.state.systemPrompt, /fresh-skill/);
	});

	test("stamps the current run so metrics records can be attributed", async () => {
		const pool = new AgentPool({ models: null, model: null, executor: new HostExecutor("/tmp/ws"), skills: [] });
		const fakeAgent = { state: { messages: [], systemPrompt: "" }, prompt: async () => {} };
		pool.channels.set("C1", { agent: fakeAgent, env: {}, hooks: null });

		await pool.run(
			{ channelId: "C1", channelName: "donantes", userId: "U1", userName: "david", text: "hi", runId: "r_9" },
			{},
		);
		assert.deepEqual(pool.channels.get("C1").run, { runId: "r_9", channel: "donantes" });
	});

	// An exchange as the agent leaves it in the message list: a tool-call turn
	// whose call fails, then the turn with the reply.
	const exchange = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
			usage: { input: 800, output: 20, cacheRead: 0, cacheWrite: 0 },
		},
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: true },
		{
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			usage: { input: 900, output: 30, cacheRead: 10, cacheWrite: 0 },
		},
	];

	const recording = (fakeAgent) => {
		const records = [];
		const pool = new AgentPool({
			models: null,
			model: null,
			executor: new HostExecutor("/tmp/ws"),
			skills: [],
			onInteraction: (record) => records.push(record),
		});
		pool.channels.set("C1", { agent: fakeAgent, env: {}, hooks: null });
		return { pool, records };
	};

	test("logs one interaction record per exchange, with the tool-call trace", async () => {
		// Pre-existing history, to prove only this run's messages are counted.
		const fakeAgent = {
			state: {
				messages: [
					{ role: "user", content: [{ type: "text", text: "[david]: earlier" }] },
					{ role: "assistant", content: [{ type: "text", text: "old reply" }], usage: { input: 99, output: 99 } },
				],
				systemPrompt: "",
			},
			prompt: async (text) => {
				fakeAgent.state.messages.push({ role: "user", content: [{ type: "text", text }] }, ...exchange);
			},
		};
		const { pool, records } = recording(fakeAgent);

		const reply = await pool.run(
			{ channelId: "C1", channelName: "donantes", userId: "U1", userName: "david", text: "list files", runId: "r_7" },
			{},
		);
		assert.equal(reply, "Done.");
		assert.equal(records.length, 1);
		const record = records[0];
		assert.equal(record.runId, "r_7");
		assert.equal(record.channel, "donantes");
		assert.equal(record.user, "david");
		assert.equal(record.query, "list files");
		assert.equal(record.reply, "Done.");
		assert.equal(record.error, undefined);
		assert.match(record.ts, /Z$/);
		assert.ok(record.durationMs >= 0);
		assert.equal(record.turns, 2, "only this run's assistant turns");
		assert.deepEqual(record.toolCalls, [{ name: "bash", args: { command: "ls" }, isError: true }]);
		assert.deepEqual(record.usage, { input: 1700, output: 50, cacheRead: 10, cacheWrite: 0 });
	});

	test("a failed run is still logged, and still throws", async () => {
		const fakeAgent = {
			state: { messages: [], systemPrompt: "" },
			prompt: async () => {
				fakeAgent.state.messages.push(exchange[0], exchange[1]); // died mid-run, no reply
				fakeAgent.state.errorMessage = "model exploded";
			},
		};
		const { pool, records } = recording(fakeAgent);

		await assert.rejects(
			() =>
				pool.run(
					{ channelId: "C1", channelName: "donantes", userId: "U1", userName: "david", text: "hi", runId: "r_8" },
					{},
				),
			/model exploded/,
		);
		assert.equal(records.length, 1);
		assert.equal(records[0].error, "model exploded");
		assert.equal(records[0].reply, "");
		assert.equal(records[0].turns, 1);
	});
});

describe("measure", () => {
	const model = { id: "gemma-4", provider: "local" };
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		usage: { input: 800, output: 120, cacheRead: 5, cacheWrite: 0 },
		stopReason: "stop",
	};

	const measuring = () => {
		const records = [];
		const pool = new AgentPool({
			models: null,
			model: null,
			executor: new HostExecutor("/tmp/ws"),
			skills: [],
			onLlmCall: (record) => records.push(record),
		});
		return { pool, records };
	};

	// The record is written after the stream is fully consumed, asynchronously.
	const nextRecord = async (records) => {
		while (!records.length) await sleep(5);
		return records[0];
	};

	test("relays the events and the final message unchanged", async () => {
		const { pool } = measuring();
		const inner = createAssistantMessageEventStream();
		const outer = pool.measure({ run: {} }, model, inner);
		inner.push({ type: "start", partial: {} });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: {} });
		inner.push({ type: "done", reason: "stop", message });

		const events = [];
		for await (const event of outer) events.push(event.type);
		assert.deepEqual(events, ["start", "text_delta", "done"]);
		assert.equal(await outer.result(), message);
	});

	test("times the call and reports usage", async () => {
		const { pool, records } = measuring();
		const inner = createAssistantMessageEventStream();
		const state = { run: { runId: "r_1", channel: "donantes" } };
		pool.measure(state, model, inner);

		inner.push({ type: "start", partial: {} }); // response opened, no tokens yet
		await sleep(30);
		inner.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: {} });
		await sleep(10);
		inner.push({ type: "done", reason: "stop", message });

		const record = await nextRecord(records);
		assert.equal(record.runId, "r_1");
		assert.equal(record.channel, "donantes");
		assert.equal(record.provider, "local");
		assert.equal(record.model, "gemma-4");
		assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
		assert.ok(record.ttftMs >= 20, `ttft includes the wait for the first token, got ${record.ttftMs}ms`);
		assert.ok(record.genMs >= 5, `generation runs from the first token, got ${record.genMs}ms`);
		assert.ok(record.tokensPerSec > 0);
		assert.equal(record.input, 800);
		assert.equal(record.output, 120);
		assert.equal(record.cacheRead, 5);
		assert.equal(record.stopReason, "stop");
	});

	test("a failed call is still logged, with no first token", async () => {
		const { pool, records } = measuring();
		const inner = createAssistantMessageEventStream();
		pool.measure({ run: { runId: "r_2", channel: "dm" } }, model, inner);

		inner.push({ type: "start", partial: {} });
		inner.push({
			type: "error",
			reason: "error",
			error: { role: "assistant", content: [], usage: { input: 800, output: 0 }, stopReason: "error" },
		});

		const record = await nextRecord(records);
		assert.equal(record.stopReason, "error");
		assert.equal(record.ttftMs, null, "no content ever arrived");
		assert.equal(record.tokensPerSec, null);
	});

	test("without a metrics hook the stream is returned as-is", () => {
		const inner = createAssistantMessageEventStream();
		const plain = pool(new HostExecutor("/tmp/ws"));
		assert.equal(plain.measure({ run: {} }, model, inner), inner);
	});
});

describe("forwardEvent", () => {
	const p = () => pool(new HostExecutor("/tmp/ws"));

	test("forwards assistant text to onText", async () => {
		const texts = [];
		const state = { hooks: { onText: async (t) => texts.push(t) } };
		await p().forwardEvent(state, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "Checking the CRM…" }] },
		});
		assert.deepEqual(texts, ["Checking the CRM…"]);
	});

	test("stays quiet for turns without text, and for non-assistant messages", async () => {
		const texts = [];
		const state = { hooks: { onText: async (t) => texts.push(t) } };
		const agentPool = p();
		await agentPool.forwardEvent(state, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall" }] },
		});
		await agentPool.forwardEvent(state, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		assert.deepEqual(texts, []);
	});

	test("forwards tool start and end", async () => {
		const calls = [];
		const state = {
			hooks: {
				onToolStart: async (name, args) => calls.push(["start", name, args.command]),
				onToolEnd: async (name, detail, isError) => calls.push(["end", name, detail, isError]),
			},
		};
		const agentPool = p();
		await agentPool.forwardEvent(state, { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
		await agentPool.forwardEvent(state, {
			type: "tool_execution_end",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		assert.deepEqual(calls, [
			["start", "bash", "ls"],
			["end", "bash", "ok", false],
		]);
	});
});

describe("trimHistory", () => {
	const messages = (roles) => roles.map((role, i) => ({ role, content: `${role}-${i}` }));

	test("leaves a short transcript alone", () => {
		const agent = { state: { messages: messages(["user", "assistant"]) } };
		pool(new HostExecutor("/tmp/ws")).trimHistory(agent);
		assert.equal(agent.state.messages.length, 2);
	});

	test("drops the oldest turns once over the cap, and starts on a user message", () => {
		// Long enough to trim, and shaped so a naive slice would land mid-turn.
		const roles = [];
		for (let i = 0; i < 40; i++) roles.push("user", "assistant", "toolResult");
		const agent = { state: { messages: messages(roles) } };
		pool(new HostExecutor("/tmp/ws")).trimHistory(agent);

		assert.ok(agent.state.messages.length < roles.length, "history was trimmed");
		assert.equal(agent.state.messages[0].role, "user", "a transcript can't open on a tool result");
	});
});
