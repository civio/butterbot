// Memory files injected into the system prompt, so facts and conventions
// survive between conversations. In the spirit of pi-mom's getMemory()
// (https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts),
// but with a layout of pi-dad's own: pi-mom kept a MEMORY.md at the workspace
// root plus one inside each channel directory, and pi-dad has no channel
// directories, so everything lives together under <workspace>/memory/.

import fs from "node:fs/promises";
import path from "node:path";

// Uppercase on purpose: Slack channel names are lowercase, so the global file
// can never collide with a channel's.
export const GLOBAL_MEMORY = "memory/MEMORY.md";

/**
 * This channel's memory file, relative to the workspace root — channel-wide,
 * like the channel itself: every thread and every user in it share the one
 * file. DMs are keyed by who is talking instead, because Slack gives a DM
 * channel no name — slack.js resolves them all to "dm" — and a single shared
 * file would pour everyone's private conversations into every DM prompt.
 */
export function channelMemoryPath(ctx) {
	// A DM's channel id starts with D — the same test slack.js uses. ctx.source
	// would misfire here: a follow-up inside a DM thread arrives as "thread".
	const name = ctx.channelId?.startsWith("D") ? `dm-${ctx.userName}` : ctx.channelName;
	// The name arrives over the network and lands in a filesystem path. Slack
	// only allows [a-z0-9-_] anyway; anything else becomes "-".
	return `memory/${String(name).replace(/[^\w-]/g, "-")}.md`;
}

/**
 * Reads the global and this channel's memory. Loaded per message, like
 * skills, so edits — the model's own included — take effect without a restart.
 * A missing file is simply nothing remembered yet, and reads as "".
 */
export async function loadMemory(workspaceDir, ctx) {
	const channelRelPath = channelMemoryPath(ctx);
	return {
		global: await readMemoryFile(workspaceDir, GLOBAL_MEMORY),
		channel: await readMemoryFile(workspaceDir, channelRelPath),
		channelRelPath,
	};
}

async function readMemoryFile(workspaceDir, relPath) {
	try {
		return (await fs.readFile(path.join(path.resolve(workspaceDir), relPath), "utf8")).trim();
	} catch (error) {
		// A file that exists but can't be read is worth a line in the log; losing
		// its contents silently would look like the memory was never written.
		if (error.code !== "ENOENT") console.warn(`Could not read ${relPath}: ${error.message}`);
		return "";
	}
}

/**
 * The "## Memory" section of the system prompt. The contents go in inline
 * rather than as paths for the model to read: fetching them would be a tool
 * call that a small model skips more often than not. Unlike the skills
 * section it is never dropped when empty — the instructions are what tell
 * the model it can remember anything at all.
 */
export function formatMemoryPrompt(memory, workspacePath) {
	const section = (title, relPath, content) =>
		`### ${title} — ${workspacePath}/${relPath}\n\n${content || "(nothing yet)"}`;
	return [
		`## Memory

The two files below persist across conversations. When you learn something worth
keeping — or are asked to remember or forget something — update them with the write
or edit tools: facts for the whole team in the global file, facts about this channel
or person in the channel file. Keep them brief; both go into every prompt here.`,
		section("Global memory", GLOBAL_MEMORY, memory.global),
		section("Channel memory", memory.channelRelPath, memory.channel),
	].join("\n\n");
}
