import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { HostExecutor, createExecutor } from "../src/sandbox.js";

let workspace;

before(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dad-sandbox-"));
});

after(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("createExecutor", () => {
	test("host mode resolves the workspace to an absolute path", () => {
		const executor = createExecutor("host", workspace);
		assert.ok(executor instanceof HostExecutor);
		assert.equal(executor.workspacePath, path.resolve(workspace));
	});

	test("rejects a spec that is neither host nor docker:<container>", () => {
		assert.throws(() => createExecutor("sandboxed", workspace), /Invalid sandbox spec/);
		assert.throws(() => createExecutor("docker:", workspace), /Invalid sandbox spec/);
	});

	test("rejects a container that isn't running", () => {
		assert.throws(
			() => createExecutor("docker:pi-dad-no-such-container", workspace),
			/not found|is not running/,
		);
	});
});

describe("HostExecutor.exec", () => {
	test("captures stdout and a zero exit code", async () => {
		const result = await new HostExecutor(workspace).exec("echo hello");
		assert.equal(result.stdout.trim(), "hello");
		assert.equal(result.code, 0);
	});

	test("runs in the workspace directory", async () => {
		const result = await new HostExecutor(workspace).exec("pwd");
		// pwd resolves symlinks; on macOS the temp dir is one (/var → /private/var).
		assert.equal(result.stdout.trim(), await fs.realpath(workspace));
	});

	test("passes extra environment variables through", async () => {
		const result = await new HostExecutor(workspace).exec("echo $DAD_CHANNEL_NAME", {
			env: { DAD_CHANNEL_NAME: "donantes" },
		});
		assert.equal(result.stdout.trim(), "donantes");
	});

	test("reports a non-zero exit code with stderr rather than throwing", async () => {
		const result = await new HostExecutor(workspace).exec("echo oops >&2; exit 3");
		assert.equal(result.code, 3);
		assert.match(result.stderr, /oops/);
	});

	test("writes stdin to the command", async () => {
		const result = await new HostExecutor(workspace).exec("cat", { stdin: "piped" });
		assert.equal(result.stdout, "piped");
	});

	test("survives a command that exits without reading its stdin", async () => {
		// The pending stdin write fails with EPIPE; unhandled, it would crash the process.
		const result = await new HostExecutor(workspace).exec("exit 7", { stdin: "x".repeat(4 * 1024 * 1024) });
		assert.equal(result.code, 7);
	});

	test("kills a command that outruns its timeout", async () => {
		await assert.rejects(() => new HostExecutor(workspace).exec("sleep 5", { timeoutMs: 150 }), /timed out/);
	});

	test("the timeout kills the command's children too, not just the shell", async () => {
		// A background job survives its shell unless the whole process group is killed —
		// and a surviving job holds the stdio pipes open, delaying the rejection with it.
		const started = Date.now();
		await assert.rejects(
			() => new HostExecutor(workspace).exec("sleep 10 & echo $! > pid.txt; wait", { timeoutMs: 300 }),
			/timed out/,
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 5000, `rejected in ${elapsed}ms — orphans kept the pipes open past the timeout`);
		const pid = Number((await fs.readFile(path.join(workspace, "pid.txt"), "utf8")).trim());
		assert.ok(pid > 0, "the background sleep reported its pid");
		await new Promise((resolve) => setTimeout(resolve, 100)); // let SIGKILL land
		assert.throws(() => process.kill(pid, 0), /ESRCH/, "the grandchild should be dead");
	});
});
