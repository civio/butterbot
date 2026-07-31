// Skill discovery. Loading is delegated to pi-agent-core's loader (proper YAML
// frontmatter parsing, recursive traversal, ignore files, diagnostics); this
// module keeps the prompt formatting, which pi-mom's src/agent.ts did in
// loadMomSkills() / formatSkillsForPrompt():
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import path from "node:path";
import { loadSkills as loadPiSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Loads skills from <workspace>/skills. Paths are returned relative to the
 * workspace root, so they can be rebased onto whatever the executor exposes:
 * the host directory, or /workspace inside the sandbox container.
 */
export async function loadSkills(workspaceDir) {
	const root = path.resolve(workspaceDir);
	const env = new NodeExecutionEnv({ cwd: root });
	const { skills, diagnostics } = await loadPiSkills(env, path.join(root, "skills"));
	for (const diagnostic of diagnostics) {
		console.warn(`Skill ${diagnostic.type} (${diagnostic.code}): ${diagnostic.message} [${diagnostic.path}]`);
	}
	return skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		// Always POSIX-style: this path is read inside the sandbox.
		relPath: path.relative(root, skill.filePath).split(path.sep).join("/"),
	}));
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
