import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { AgentPool } from "../src/agent.js";
import { HostExecutor } from "../src/sandbox.js";
import { loadSkills } from "../src/skills.js";

let workspace;

async function writeSkill(name, frontmatter, scripts = {}) {
	const dir = path.join(workspace, "skills", name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody.\n`);
	for (const [file, body] of Object.entries(scripts)) {
		await fs.writeFile(path.join(dir, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}
}

before(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "butterbot-commands-"));
	await writeSkill(
		"web",
		[
			"description: Deploys the websites.",
			"channels: [web]",
			"commands:",
			"  Deploy: { run: deploy.sh, description: Deploy a site }",
			"  fail: fail.sh",
			"  help: whatever.sh",
			"  broken: { description: No script }",
		].join("\n"),
		{
			"deploy.sh": 'printf "%s|" "$@"; echo "by $BUTTERBOT_USER_NAME"',
			"fail.sh": 'echo "no such site" >&2; exit 3',
		},
	);
	await writeSkill("greeter", "description: Greets people.");
});

after(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

const ctx = (text, extra) => ({ channelId: "C1", channelName: "web", userId: "U1", userName: "david", text, ...extra });

const pool = (records = []) =>
	new AgentPool({
		models: null,
		model: null,
		executor: new HostExecutor(workspace),
		loadSkills: () => loadSkills(workspace),
		onInteraction: (record) => records.push(record),
	});

describe("loadSkills, commands", () => {
	test("reads commands from the frontmatter, lowercased, and skips the unusable ones", async () => {
		const web = (await loadSkills(workspace)).find((skill) => skill.name === "web");
		assert.deepEqual(web.commands, [
			{ name: "deploy", run: "deploy.sh", description: "Deploy a site" },
			{ name: "fail", run: "fail.sh", description: "" },
		]);
	});

	test("a skill without commands has none", async () => {
		const greeter = (await loadSkills(workspace)).find((skill) => skill.name === "greeter");
		assert.deepEqual(greeter.commands, []);
	});
});

describe("AgentPool.command", () => {
	test("runs the skill's script with the arguments and the asker's environment", async () => {
		const records = [];
		const reply = await pool(records).command(ctx("!deploy civio datos"));
		assert.equal(reply, "civio|datos|by david");
		assert.equal(records[0].command, "web/deploy");
		assert.equal(records[0].turns, 0);
	});

	test("passes arguments as words, never to the shell", async () => {
		const reply = await pool().command(ctx("!DEPLOY civio; touch pwned $(id)"));
		assert.equal(reply, "civio;|touch|pwned|$(id)|by david");
		await assert.rejects(fs.access(path.join(workspace, "pwned")));
	});

	test("reports a failing script with its exit code and output", async () => {
		const records = [];
		const reply = await pool(records).command(ctx("!fail"));
		assert.match(reply, /`!fail` failed \(exit code 3\)/);
		assert.match(reply, /no such site/);
		assert.equal(records[0].error, "exit code 3");
	});

	test("doesn't exist where its skill isn't visible", async () => {
		assert.equal(await pool().command(ctx("!deploy civio", { channelName: "random", channelId: "C2" })), null);
	});

	test("leaves ordinary messages and !skill to the model", async () => {
		assert.equal(await pool().command(ctx("deploy civio")), null);
		assert.equal(await pool().command(ctx("!greeter hola")), null);
		assert.equal(await pool().command(ctx("!nonsense")), null);
	});

	test("!help lists the built-ins, this channel's commands and its skills", async () => {
		const help = await pool().command(ctx("!help"));
		assert.match(help, /`!stop`/);
		assert.match(help, /`!deploy` — Deploy a site _\(web\)_/);
		assert.match(help, /`!greeter`/);

		const elsewhere = await pool().command(ctx("!help", { channelName: "random", channelId: "C2" }));
		assert.doesNotMatch(elsewhere, /deploy/);
	});
});

describe("!stop", () => {
	test("with nothing running, says so", async () => {
		assert.equal(await pool().command(ctx("!stop")), "_Nothing to stop._");
	});

	test("aborts the channel's run, which answers saying who stopped it", async () => {
		const p = pool();
		// A run that only ends when aborted, as a model stuck in a loop would.
		let started;
		const running = new Promise((resolve) => (started = resolve));
		const agent = {
			state: { messages: [], systemPrompt: "" },
			prompt: () =>
				new Promise((resolve) => {
					agent.abort = () => {
						agent.state.errorMessage = "Request aborted";
						resolve();
					};
					started();
				}),
		};
		p.conversations.set("C1", { agent, env: {}, hooks: null });

		const run = p.run(ctx("loop forever", { conversationId: "C1" }), {});
		await running;
		assert.equal(await p.command(ctx("!stop", { userName: "maria" })), "", "nothing to post: the run answers");
		assert.equal(await run, "_Stopped by maria._");
		assert.equal(await p.command(ctx("!stop")), "_Nothing to stop._", "and it no longer counts as running");
	});
});
