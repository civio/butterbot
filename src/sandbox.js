// Originally based on pi-mom's src/sandbox.ts (MIT, © Mario Zechner), ported to
// JavaScript for pi-dad:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/sandbox.ts

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

// Where the workspace is mounted inside sandbox containers (pi-mom convention).
const CONTAINER_WORKSPACE = "/workspace";
// Memory guard, in UTF-16 code units; the last chunk may overshoot it.
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

// Both executors expose the same shape: `workspacePath` (the workspace as the
// command sees it), `sandboxed` (whether commands are confined — it keys the
// startup warning and the prompt's environment note), and `exec`.

/** Runs commands directly on the host, with the workspace as working directory. */
export class HostExecutor {
	constructor(workspaceDir) {
		this.workspaceDir = path.resolve(workspaceDir);
	}

	get workspacePath() {
		return this.workspaceDir;
	}

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

  // Parse the container name from "docker:<container>" spec
	const match = spec.match(/^docker:(.+)$/);
	if (!match) throw new Error(`Invalid sandbox spec "${spec}" — use "host" or "docker:<container>"`);
	const container = match[1];

  // Check that the container is running
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

/**
 * Spawns a command, feeds it `stdin`, and collects its output. Rejects if the
 * spawn itself fails or the timeout fires; otherwise resolves with the exit
 * code. Shared by both executors below.
 */
function run(command, args, { cwd, env, stdin, timeoutMs, signal }) {
	return new Promise((resolve, reject) => {
		// Spawn into its own process group, so the timeout can kill the whole
		// tree: killing just `sh` would orphan the children of a pipeline or
		// script, which keep the stdio pipes open and so delay the "close" event
		// (and this promise) until they exit on their own.
		const child = spawn(command, args, { cwd, env, signal, detached: true });
		let stdout = "";
		let stderr = "";
		let killed = false;

		// On timeout, kill that group; "close" below turns the flag into an error.
		const timer = setTimeout(() => {
			killed = true;
			try {
				process.kill(-child.pid, "SIGKILL"); // negative pid: the process group
			} catch {
				child.kill("SIGKILL"); // group already gone; make sure `sh` is too
			}
		}, timeoutMs);

		// Collect both streams up to the memory guard. Decoding is set on the
		// stream rather than done per chunk, so a multibyte character split
		// across two pipe chunks still decodes as one character.
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
		});

		// Settle the promise: spawn failure and timeout reject, anything else —
		// including a non-zero exit — resolves and lets the caller decide.
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (killed) reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
			else resolve({ stdout, stderr, code: code ?? -1 });
		});

		// Feed stdin, swallowing EPIPE. If the child exits without draining it
		// (mkdir failed before cat ran, container stopped, timeout SIGKILL), the
		// pending write errors on this stream, and an unhandled stream error is an
		// uncaught exception that kills the process. The real failure still
		// arrives through the exit code and stderr on "close". The handler must be
		// registered before write(), which can fail in the same tick.
		child.stdin.on("error", () => {});
		if (stdin != null) child.stdin.write(stdin);
		child.stdin.end();
	});
}
