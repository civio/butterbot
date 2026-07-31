// Tools are exercised against a real HostExecutor in a temp workspace: they
// work by shelling out, so a stubbed executor would test very little.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { HostExecutor } from "../src/sandbox.js";
import { createTools } from "../src/tools.js";

let workspace;
let tools;
let env;

const toolNamed = (name) => tools.find((t) => t.name === name);
const textOf = (result) => result.content.map((part) => part.text).join("");

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dad-tools-"));
	env = {};
	tools = createTools(new HostExecutor(workspace), () => env);
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("createTools", () => {
	test("exposes exactly bash, read, write and edit", () => {
		assert.deepEqual(
			tools.map((t) => t.name),
			["bash", "read", "write", "edit"],
		);
	});
});

describe("bash", () => {
	test("returns command output", async () => {
		const result = await toolNamed("bash").execute("1", { command: "echo hi" });
		assert.equal(textOf(result).trim(), "hi");
	});

	test("throws on a non-zero exit, including the output", async () => {
		await assert.rejects(
			() => toolNamed("bash").execute("1", { command: "echo nope >&2; exit 2" }),
			/exit code 2[\s\S]*nope/,
		);
	});

	test("reports empty output rather than an empty string", async () => {
		const result = await toolNamed("bash").execute("1", { command: "true" });
		assert.equal(textOf(result), "(no output)");
	});

	test("truncates very long output, keeping the tail", async () => {
		const result = await toolNamed("bash").execute("1", { command: "seq 1 5000" });
		const text = textOf(result);
		assert.match(text, /output truncated/);
		assert.match(text, /5000/, "the end of the output is what's kept");
		assert.equal(text.includes("\n1\n"), false, "the start is dropped");
	});

	test("passes the per-message environment to the command", async () => {
		env = { DAD_USER_NAME: "david" };
		const result = await toolNamed("bash").execute("1", { command: "echo $DAD_USER_NAME" });
		assert.equal(textOf(result).trim(), "david");
	});
});

describe("read", () => {
	test("reads a file relative to the workspace", async () => {
		await fs.writeFile(path.join(workspace, "note.txt"), "one\ntwo\nthree\n");
		const result = await toolNamed("read").execute("1", { path: "note.txt" });
		assert.match(textOf(result), /one\ntwo\nthree/);
	});

	test("honours offset and limit", async () => {
		await fs.writeFile(path.join(workspace, "note.txt"), "one\ntwo\nthree\nfour\n");
		const result = await toolNamed("read").execute("1", { path: "note.txt", offset: 2, limit: 2 });
		assert.equal(textOf(result).trim(), "two\nthree");
	});

	test("throws for a missing file", async () => {
		await assert.rejects(() => toolNamed("read").execute("1", { path: "absent.txt" }), /absent\.txt/);
	});
});

describe("write", () => {
	test("creates a file, including missing parent directories", async () => {
		await toolNamed("write").execute("1", { path: "nested/deep/file.txt", content: "hello" });
		assert.equal(await fs.readFile(path.join(workspace, "nested/deep/file.txt"), "utf8"), "hello");
	});

	test("overwrites an existing file", async () => {
		await fs.writeFile(path.join(workspace, "file.txt"), "old");
		await toolNamed("write").execute("1", { path: "file.txt", content: "new" });
		assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "new");
	});
});

describe("edit", () => {
	test("replaces a unique match", async () => {
		await fs.writeFile(path.join(workspace, "file.txt"), "alpha beta gamma");
		await toolNamed("edit").execute("1", { path: "file.txt", oldText: "beta", newText: "delta" });
		assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "alpha delta gamma");
	});

	test("refuses when the text isn't there", async () => {
		await fs.writeFile(path.join(workspace, "file.txt"), "alpha");
		await assert.rejects(
			() => toolNamed("edit").execute("1", { path: "file.txt", oldText: "beta", newText: "x" }),
			/not found/,
		);
	});

	test("refuses an ambiguous match rather than guessing", async () => {
		await fs.writeFile(path.join(workspace, "file.txt"), "beta beta");
		await assert.rejects(
			() => toolNamed("edit").execute("1", { path: "file.txt", oldText: "beta", newText: "x" }),
			/matches 2 times/,
		);
	});
});
