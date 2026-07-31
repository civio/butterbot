// Agent tools, all routed through an executor so they work identically on the
// host and inside the Docker sandbox. Follows pi-mom's tool design.

const MAX_TOOL_OUTPUT = 50000;
const MAX_TOOL_LINES = 2000;

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function truncate(text) {
	let lines = text.split("\n");
	let note = "";
	if (lines.length > MAX_TOOL_LINES) {
		lines = lines.slice(-MAX_TOOL_LINES);
		note = `[output truncated to last ${MAX_TOOL_LINES} lines]\n`;
	}
	let output = lines.join("\n");
	if (output.length > MAX_TOOL_OUTPUT) {
		output = output.slice(-MAX_TOOL_OUTPUT);
		note = `[output truncated to last ${MAX_TOOL_OUTPUT} characters]\n`;
	}
	return note + output;
}

const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });

async function readFile(executor, env, filePath) {
	const result = await executor.exec(`cat ${quote(filePath)}`, { env });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Cannot read ${filePath}`);
	return result.stdout;
}

async function writeFile(executor, env, filePath, content) {
	const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
	const result = await executor.exec(`mkdir -p ${quote(dir)} && cat > ${quote(filePath)}`, {
		env,
		stdin: content,
	});
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Cannot write ${filePath}`);
}

/**
 * @param executor HostExecutor | DockerExecutor
 * @param getEnv () => extra env vars for the current message (channel/user)
 */
export function createTools(executor, getEnv) {
	const bash = {
		name: "bash",
		label: "bash",
		description:
			"Run a shell command. The workspace is the working directory. " +
			"Environment variables identify the current Slack channel and user.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				timeout: { type: "number", description: "Timeout in seconds (default 120)" },
			},
			required: ["command"],
		},
		execute: async (_id, params, signal) => {
			const result = await executor.exec(params.command, {
				env: getEnv(),
				timeoutMs: (params.timeout || 120) * 1000,
				signal,
			});
			let output = result.stdout;
			if (result.stderr.trim()) output += `${output ? "\n" : ""}STDERR:\n${result.stderr}`;
			if (result.code !== 0) {
				throw new Error(`Command failed with exit code ${result.code}\n${truncate(output)}`);
			}
			return text(truncate(output) || "(no output)");
		},
	};

	const read = {
		name: "read",
		label: "read",
		description: "Read a file from the workspace. Paths are relative to the workspace root.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				offset: { type: "number", description: "Start line (1-based, optional)" },
				limit: { type: "number", description: "Max lines to return (optional)" },
			},
			required: ["path"],
		},
		execute: async (_id, params) => {
			const content = await readFile(executor, getEnv(), params.path);
			let lines = content.split("\n");
			if (params.offset) lines = lines.slice(params.offset - 1);
			if (params.limit) lines = lines.slice(0, params.limit);
			return text(truncate(lines.join("\n")) || "(empty file)");
		},
	};

	const write = {
		name: "write",
		label: "write",
		description: "Create or overwrite a file in the workspace.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				content: { type: "string", description: "Full file content" },
			},
			required: ["path", "content"],
		},
		execute: async (_id, params) => {
			await writeFile(executor, getEnv(), params.path, params.content);
			return text(`Wrote ${params.path}`);
		},
	};

	const edit = {
		name: "edit",
		label: "edit",
		description:
			"Replace text in a file. oldText must match exactly one occurrence; include enough context to make it unique.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				oldText: { type: "string", description: "Exact text to replace" },
				newText: { type: "string", description: "Replacement text" },
			},
			required: ["path", "oldText", "newText"],
		},
		execute: async (_id, params) => {
			const content = await readFile(executor, getEnv(), params.path);
			const occurrences = content.split(params.oldText).length - 1;
			if (occurrences === 0) throw new Error(`oldText not found in ${params.path}`);
			if (occurrences > 1) {
				throw new Error(`oldText matches ${occurrences} times in ${params.path}; add context to make it unique`);
			}
			await writeFile(executor, getEnv(), params.path, content.replace(params.oldText, params.newText));
			return text(`Edited ${params.path}`);
		},
	};

	return [bash, read, write, edit];
}
