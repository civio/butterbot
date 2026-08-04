// Agent tools, all routed through an executor so they work identically on the
// host and inside the Docker sandbox.
//
// Originally based on pi-mom's src/tools/ (MIT, © Mario Zechner) — index.ts,
// bash.ts, read.ts, write.ts, edit.ts and truncate.ts — ported to JavaScript
// and collapsed into a single module for pi-dad:
// https://github.com/earendil-works/pi/tree/v0.70.6/packages/mom/src/tools

const MAX_TOOL_OUTPUT = 50000;
const MAX_TOOL_LINES = 2000;

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
				throw new Error(`Command failed with exit code ${result.code}\n${keepCommandOutputTail(output)}`);
			}
			return createTextResult(keepCommandOutputTail(output) || "(no output)");
		},
	};

	const read = {
		name: "read",
		label: "read",
		description:
			"Read a file from the workspace. Paths are relative to the workspace root. " +
			"Long files are returned from the start; page through them with offset and limit.",
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
			const allLines = content.split("\n");
			if (allLines.at(-1) === "") allLines.pop(); // a trailing newline is not a line
      const totalLines = allLines.length;

      // Check the start line is within bounds.
			const startLine = Math.max(1, params.offset || 1);
			if (params.offset && startLine > totalLines) {
				throw new Error(`offset ${params.offset} is beyond the end of ${params.path} (${totalLines} lines)`);
			}

			// Retrieve the requested lines, capped at MAX_TOOL_LINES.
			// If the output exceeds MAX_TOOL_OUTPUT, truncate it to the last line boundary,
			// so the range reported below covers exactly the lines actually returned.
      let lines = allLines.slice(startLine - 1, startLine - 1 + (params.limit || Infinity)).slice(0, MAX_TOOL_LINES);
			let output = lines.join("\n");
			if (output.length > MAX_TOOL_OUTPUT) {
				const cut = output.lastIndexOf("\n", MAX_TOOL_OUTPUT);
				output = output.slice(0, cut > 0 ? cut : MAX_TOOL_OUTPUT);
				lines = output.split("\n");
      }

			// Add a continuation note if the output is truncated.
			const endLine = startLine + lines.length - 1;
			if (endLine < totalLines) {
				output += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue]`;
      }

			return createTextResult(output || "(empty file)");
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
			return createTextResult(`Wrote ${params.path}`);
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

      // Count occurrences of oldText in the content.
			const occurrences = content.split(params.oldText).length - 1;
			if (occurrences === 0) throw new Error(`oldText not found in ${params.path}`);
			if (occurrences > 1) {
				throw new Error(`oldText matches ${occurrences} times in ${params.path}; add context to make it unique`);
      }

			// Replace oldText with newText at the found index.
			// Careful: note that String.replace would expand $-patterns ($&, $', …) in newText.
			const index = content.indexOf(params.oldText);
      const edited = content.slice(0, index) + params.newText + content.slice(index + params.oldText.length);

      // Write the edited content back to the file.
			await writeFile(executor, getEnv(), params.path, edited);
			return createTextResult(`Edited ${params.path}`);
		},
	};

	return [bash, read, write, edit];
}

/**
 * Caps command output at the last MAX_TOOL_LINES lines and MAX_TOOL_OUTPUT
 * characters, keeping the end: for a command it is the last lines — the error,
 * the summary — that carry the answer, and the note says what was dropped.
 */
function keepCommandOutputTail(text) {
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

const createTextResult = (value) => ({ content: [{ type: "text", text: value }], details: {} });

/**
 * Wraps a value in single quotes for `sh -c`, so a path with spaces or `$` in
 * it stays one literal argument. An embedded single quote is closed, escaped
 * and reopened — the `'\''` idiom — because nothing else escapes inside single
 * quotes in POSIX shell.
 */
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function readFile(executor, env, filePath) {
	const result = await executor.exec(`cat ${shellQuote(filePath)}`, { env });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Cannot read ${filePath}`);
	return result.stdout;
}

async function writeFile(executor, env, filePath, content) {
	const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
	const result = await executor.exec(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(filePath)}`, {
		env,
		stdin: content,
	});
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Cannot write ${filePath}`);
}
