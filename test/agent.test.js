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

	test("describes the sandbox the tools actually run in", () => {
		const onHost = pool(new HostExecutor("/tmp/ws")).buildSystemPrompt({ channelName: "c", channelId: "C1" });
		assert.match(onHost, /run on the host/);

		const inDocker = pool(new DockerExecutor("some-container")).buildSystemPrompt({ channelName: "c", channelId: "C1" });
		assert.match(inDocker, /Docker sandbox/);
		assert.match(inDocker, /\/workspace/);
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
