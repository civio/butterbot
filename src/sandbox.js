// Originally based on pi-mom's src/sandbox.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/sandbox.ts

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

// Where the workspace is mounted inside sandbox containers (pi-mom convention).
const CONTAINER_WORKSPACE = "/workspace";
// Memory guard, in UTF-16 code units; the last chunk may overshoot it.
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

function run(command, args, { cwd, env, stdin, timeoutMs, signal }) {
	return new Promise((resolve, reject) => {
		// detached puts the command in its own process group, so the timeout can
		// kill the whole tree: killing just `sh` would orphan the children of a
		// pipeline or script, which keep running — and keep the stdio pipes open,
		// delaying the "close" event (and this promise) until they exit.
		const child = spawn(command, args, { cwd, env, signal, detached: true });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			try {
				process.kill(-child.pid, "SIGKILL"); // negative pid: the process group
			} catch {
				child.kill("SIGKILL"); // group already gone; make sure sh is too
			}
		}, timeoutMs);
		// Decode as a stream, not per chunk: without this, a multibyte character
		// split across a pipe chunk decodes as two replacement characters.
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (killed) reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
			else resolve({ stdout, stderr, code: code ?? -1 });
		});
		// If the child exits without draining stdin (mkdir failed before cat ran,
		// container stopped, timeout SIGKILL), the pending write emits EPIPE on this
		// stream; unhandled, that is an uncaught exception that kills the process.
		// The real failure still arrives through the exit code and stderr on "close".
		// Must be registered before write(), which can fail in the same tick.
		child.stdin.on("error", () => {});
		if (stdin != null) child.stdin.write(stdin);
		child.stdin.end();
	});
}

/** Runs commands directly on the host, with the workspace as working directory. */
export class HostExecutor {
	constructor(workspaceDir) {
		this.workspaceDir = path.resolve(workspaceDir);
	}

	get workspacePath() {
		return this.workspaceDir;
	}

	/** Whether commands are confined; keys the startup warning and the prompt's environment note. */
	get sandboxed() {
		return false;
	}

	exec(command, { env = {}, stdin, timeoutMs = 120000, signal } = {}) {
		return run("sh", ["-c", command], {
			cwd: this.workspaceDir,
			env: { ...process.env, ...env },
			stdin,
			timeoutMs,
			signal,
		});
	}
}

/**
 * Runs commands inside a long-lived Docker container that has the workspace
 * bind-mounted at /workspace (pi-mom's sandbox setup, which this follows).
 */
export class DockerExecutor {
	constructor(container) {
		this.container = container;
	}

	get workspacePath() {
		return CONTAINER_WORKSPACE;
	}

	get sandboxed() {
		return true;
	}

	exec(command, { env = {}, stdin, timeoutMs = 120000, signal } = {}) {
		const args = ["exec", "-i", "-w", CONTAINER_WORKSPACE];
		for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
		args.push(this.container, "sh", "-c", command);
		return run("docker", args, { stdin, timeoutMs, signal });
	}
}

/** Parses "host" or "docker:<container>"; validates the container is running. */
export function createExecutor(spec, workspaceDir) {
	if (spec === "host") return new HostExecutor(workspaceDir);
	const match = spec.match(/^docker:(.+)$/);
	if (!match) throw new Error(`Invalid sandbox spec "${spec}" — use "host" or "docker:<container>"`);
	const container = match[1];
	let running;
	try {
		running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"], // docker's own error goes to stderr; ours is clearer
		}).trim();
	} catch {
		throw new Error(`Docker container "${container}" not found — is Docker running?`);
	}
	if (running !== "true") {
		throw new Error(`Docker container "${container}" is not running (docker start ${container})`);
	}
	return new DockerExecutor(container);
}
