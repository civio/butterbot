// Skill discovery and prompt formatting, following what pi-mom's src/agent.ts
// did in loadMomSkills() / formatSkillsForPrompt():
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts
//
// pi-agent-core exports its own loader, which we deliberately don't use. It
// builds a fixed-shape Skill and discards frontmatter keys it doesn't know, so
// a `channels:` field would mean reading and parsing every file a second time.
// It is also more permissive than the convention we document, treating loose
// .md files as skills, and it reads through an ExecutionEnv we would only
// construct to satisfy it. Parsing here is one pass and fewer lines.

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Splits `---\n…\n---\n` frontmatter from the body. Missing or malformed → empty. */
function parseFrontmatter(raw) {
	const normalized = raw.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return {};
	// The closing fence is a whole `---` line, not any line starting with ---.
	const end = normalized.search(/\n---[ \t]*(?:\n|$)/);
	if (end === -1) return {};
	try {
		return parseYaml(normalized.slice(4, end)) ?? {};
	} catch (error) {
		throw new Error(`invalid frontmatter: ${error.message}`);
	}
}

/** `channels: donantes` or `channels: [donantes, test-david]` → array; absent → null (everywhere). */
function parseChannels(value) {
	if (value == null) return null;
	const list = (Array.isArray(value) ? value : String(value).split(","))
		.map((entry) => String(entry).trim().replace(/^#/, ""))
		.filter(Boolean);
	return list.length ? list : null;
}

/**
 * Loads skills from <workspace>/skills/<name>/SKILL.md. Paths are returned
 * relative to the workspace root, so they can be rebased onto whatever the
 * executor exposes: the host directory, or /workspace inside the container.
 */
export async function loadSkills(workspaceDir) {
	const skillsDir = path.join(path.resolve(workspaceDir), "skills");
	let entries;
	try {
		entries = await fs.readdir(skillsDir, { withFileTypes: true });
	} catch {
		return []; // no skills directory is normal
	}

	const skills = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const relPath = `skills/${entry.name}/SKILL.md`;
		let frontmatter;
		try {
			frontmatter = parseFrontmatter(await fs.readFile(path.join(skillsDir, entry.name, "SKILL.md"), "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") console.warn(`Skipping ${relPath}: ${error.message}`);
			continue;
		}
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!description) {
			// Without one the model has no basis for choosing the skill.
			console.warn(`Skipping ${relPath}: no description in frontmatter`);
			continue;
		}
		skills.push({
			name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : entry.name,
			description,
			relPath,
			channels: parseChannels(frontmatter.channels),
		});
	}
	return skills;
}

/**
 * Whether a skill is listed for this message. Restricted skills match on
 * channel name or id, so a rename doesn't silently widen access when ids are
 * used, and a failed name lookup doesn't silently widen it either.
 *
 * This governs what the model is told about, not what it is able to run:
 * anything with a shell can still reach the files. It keeps sensitive work in
 * channels where colleagues can see it; it is not a security boundary.
 */
export function skillVisibleIn(skill, ctx) {
	if (!skill.channels) return true;
	return skill.channels.includes(ctx.channelName) || skill.channels.includes(ctx.channelId);
}

/** @param workspacePath the workspace path as seen by the executor (host dir or /workspace) */
export function formatSkillsPrompt(skills, workspacePath) {
	if (!skills.length) return "";
	const list = skills
		.map((s) => {
			// One line per skill: descriptions may be multi-line in the frontmatter.
			const description = s.description.replace(/\s+/g, " ").trim();
			return `- ${s.name}: ${description} (instructions: ${workspacePath}/${s.relPath})`;
		})
		.join("\n");
	return `## Skills

You have skills: predefined workflows with instructions and scripts.

${list}

When a request matches a skill, FIRST read its instructions file with the read tool, then follow it exactly.`;
}
