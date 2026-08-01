import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { formatSkillsPrompt, loadSkills, skillVisibleIn } from "../src/skills.js";

let workspace;

async function writeSkill(name, contents) {
	const dir = path.join(workspace, "skills", name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "SKILL.md"), contents);
}

before(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dad-skills-"));
	await writeSkill("greeter", "---\ndescription: Greets people.\n---\n\nBody.\n");
	await writeSkill("donor", "---\ndescription: Donor stuff.\nchannels: [donantes, test-david]\n---\n\nBody.\n");
	await writeSkill("single-channel", "---\ndescription: One channel.\nchannels: donantes\n---\n\nBody.\n");
	await writeSkill("hashed", "---\ndescription: Leading hashes are stripped.\nchannels: ['#donantes']\n---\n\nBody.\n");
	// A description written as a YAML block scalar keeps its newlines.
	await writeSkill("multiline", "---\ndescription: |\n  First line.\n  TRIGGER when: asked.\n---\n\nBody.\n");
	// A frontmatter line that merely starts with --- is not the closing fence.
	await writeSkill("dashes", "---\nname: dashes\n---x: 1\ndescription: Survives inner dashes.\n---\n\nBody.\n");
	// A closing fence at end-of-file, without a trailing newline.
	await writeSkill("terse", "---\ndescription: Terse.\n---");
	await writeSkill("no-description", "---\nname: no-description\n---\n\nBody.\n");
	await writeSkill("bad-yaml", '---\ndescription: "unterminated\n  bad: [1,2\n---\n\nBody.\n');
	await fs.mkdir(path.join(workspace, "skills", "no-skill-file"), { recursive: true });
	await fs.writeFile(path.join(workspace, "skills", "stray.md"), "not a skill");
});

after(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("loadSkills", () => {
	test("loads well-formed skills and ignores the rest", async () => {
		const skills = await loadSkills(workspace);
		const names = skills.map((s) => s.name).sort();
		assert.deepEqual(names, ["dashes", "donor", "greeter", "hashed", "multiline", "single-channel", "terse"]);
	});

	test("a frontmatter line starting with dashes is not the closing fence", async () => {
		const skills = await loadSkills(workspace);
		assert.equal(skills.find((s) => s.name === "dashes").description, "Survives inner dashes.");
	});

	test("returns paths relative to the workspace root", async () => {
		const skills = await loadSkills(workspace);
		const greeter = skills.find((s) => s.name === "greeter");
		assert.equal(greeter.relPath, "skills/greeter/SKILL.md");
	});

	test("parses channels as a list, a bare string, or with a leading hash", async () => {
		const skills = await loadSkills(workspace);
		const by = (name) => skills.find((s) => s.name === name).channels;
		assert.deepEqual(by("donor"), ["donantes", "test-david"]);
		assert.deepEqual(by("single-channel"), ["donantes"]);
		assert.deepEqual(by("hashed"), ["donantes"]);
		assert.equal(by("greeter"), null, "no channels field means everywhere");
	});

	test("keeps the newlines of a block-scalar description", async () => {
		const skills = await loadSkills(workspace);
		const multiline = skills.find((s) => s.name === "multiline");
		assert.match(multiline.description, /First line\.\nTRIGGER when: asked\./);
	});

	test("returns empty for a workspace with no skills directory", async () => {
		assert.deepEqual(await loadSkills(path.join(workspace, "nowhere")), []);
	});
});

describe("skillVisibleIn", () => {
	const unrestricted = { channels: null };
	const restricted = { channels: ["donantes", "C0123"] };

	test("a skill with no channels is visible everywhere", () => {
		assert.ok(skillVisibleIn(unrestricted, { channelName: "anything", channelId: "C9" }));
	});

	test("a restricted skill matches by channel name", () => {
		assert.ok(skillVisibleIn(restricted, { channelName: "donantes", channelId: "C7" }));
	});

	test("a restricted skill matches by channel id", () => {
		assert.ok(skillVisibleIn(restricted, { channelName: "unknown", channelId: "C0123" }));
	});

	test("a restricted skill is hidden elsewhere, including DMs", () => {
		assert.equal(skillVisibleIn(restricted, { channelName: "equipo", channelId: "C7" }), false);
		assert.equal(skillVisibleIn(restricted, { channelName: "dm", channelId: "D9" }), false);
	});
});

describe("formatSkillsPrompt", () => {
	test("is empty when there are no skills", () => {
		assert.equal(formatSkillsPrompt([], "/workspace"), "");
	});

	test("rebases paths onto the executor's workspace", () => {
		const prompt = formatSkillsPrompt([{ name: "a", description: "d", relPath: "skills/a/SKILL.md" }], "/workspace");
		assert.match(prompt, /\/workspace\/skills\/a\/SKILL\.md/);
	});

	test("collapses a multi-line description onto one line", () => {
		const prompt = formatSkillsPrompt(
			[{ name: "a", description: "First.\nSecond.\n", relPath: "skills/a/SKILL.md" }],
			"/workspace",
		);
		const entry = prompt.split("\n").filter((line) => line.startsWith("- "));
		assert.equal(entry.length, 1);
		assert.match(entry[0], /First\. Second\./);
	});
});
