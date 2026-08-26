import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { channelMemoryPath, formatMemoryPrompt, loadMemory } from "../src/memory.js";

describe("channelMemoryPath", () => {
	test("a channel's memory is named after it", () => {
		assert.equal(channelMemoryPath({ channelId: "C1", channelName: "donantes" }), "memory/donantes.md");
	});

	test("a DM's memory is named after the person, not the channel", () => {
		// Slack resolves every DM's channel name to "dm": named that way, all
		// DMs would share one file, read into everyone's private conversation.
		assert.equal(
			channelMemoryPath({ channelId: "D1", channelName: "dm", userName: "carmen" }),
			"memory/dm-carmen.md",
		);
	});

	test("a name that would escape the memory directory cannot", () => {
		assert.equal(channelMemoryPath({ channelId: "C1", channelName: "../secrets" }), "memory/---secrets.md");
	});
});

describe("loadMemory", () => {
	let workspace;
	before(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "butterbot-memory-"));
		await fs.mkdir(path.join(workspace, "memory"));
		await fs.writeFile(path.join(workspace, "memory", "MEMORY.md"), "Donations are handled by Carmen.\n");
		await fs.writeFile(path.join(workspace, "memory", "donantes.md"), "The CRM export runs on Mondays.\n");
	});
	after(() => fs.rm(workspace, { recursive: true, force: true }));

	test("reads the global file and the channel's own", async () => {
		const memory = await loadMemory(workspace, { channelId: "C1", channelName: "donantes" });
		assert.equal(memory.global, "Donations are handled by Carmen.");
		assert.equal(memory.channel, "The CRM export runs on Mondays.");
		assert.equal(memory.channelRelPath, "memory/donantes.md");
	});

	test("a channel that has never remembered anything reads as empty", async () => {
		const memory = await loadMemory(workspace, { channelId: "C2", channelName: "equipo" });
		assert.equal(memory.global, "Donations are handled by Carmen.", "the global file still applies");
		assert.equal(memory.channel, "");
	});

	test("a workspace with no memory directory at all is fine", async () => {
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "butterbot-bare-"));
		try {
			const memory = await loadMemory(bare, { channelId: "C1", channelName: "donantes" });
			assert.equal(memory.global, "");
			assert.equal(memory.channel, "");
		} finally {
			await fs.rm(bare, { recursive: true, force: true });
		}
	});
});

describe("formatMemoryPrompt", () => {
	const memory = {
		global: "Donations are handled by Carmen.",
		channel: "The CRM export runs on Mondays.",
		channelRelPath: "memory/donantes.md",
	};

	test("inlines both files under their workspace paths", () => {
		const prompt = formatMemoryPrompt(memory, "/workspace");
		assert.match(prompt, /## Memory/);
		assert.match(prompt, /\/workspace\/memory\/MEMORY\.md/);
		assert.match(prompt, /Donations are handled by Carmen\./);
		assert.match(prompt, /\/workspace\/memory\/donantes\.md/);
		assert.match(prompt, /The CRM export runs on Mondays\./);
	});

	test("empty memory still teaches the model where to write", () => {
		const prompt = formatMemoryPrompt({ global: "", channel: "", channelRelPath: "memory/equipo.md" }, "/workspace");
		assert.match(prompt, /## Memory/, "the section is never dropped, unlike the skills one");
		assert.match(prompt, /\/workspace\/memory\/equipo\.md/);
		assert.match(prompt, /\(nothing yet\)/);
	});
});
