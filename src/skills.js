import fs from "node:fs";
import path from "node:path";

/**
 * Loads skills from <workspace>/skills/<name>/SKILL.md. Frontmatter `name:`
 * and `description:` are used when present; the directory name otherwise.
 * Skill bodies are not loaded — the model reads them on demand.
 */
export function loadSkills(workspaceDir) {
	const skillsDir = path.join(workspaceDir, "skills");
	if (!fs.existsSync(skillsDir)) return [];
	const skills = [];
	for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
		if (!fs.existsSync(skillFile)) continue;
		const head = fs.readFileSync(skillFile, "utf8").slice(0, 2000);
		const frontmatter = head.match(/^---\n([\s\S]*?)\n---/);
		const field = (name) =>
			frontmatter?.[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
		skills.push({
			name: field("name") || entry.name,
			description: field("description") || "",
			dir: entry.name,
		});
	}
	return skills;
}

/** @param workspacePath the workspace path as seen by the executor (host dir or /workspace) */
export function formatSkillsPrompt(skills, workspacePath) {
	if (!skills.length) return "";
	const list = skills
		.map((s) => `- ${s.name}: ${s.description} (instructions: ${workspacePath}/skills/${s.dir}/SKILL.md)`)
		.join("\n");
	return `## Skills

You have skills: predefined workflows with instructions and scripts.

${list}

When a request matches a skill, FIRST read its SKILL.md file with the read tool, then follow its instructions exactly.`;
}
