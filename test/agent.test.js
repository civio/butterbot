import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentPool } from "../src/agent.js";
import { DockerExecutor, HostExecutor } from "../src/sandbox.js";

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
