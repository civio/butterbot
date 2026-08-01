import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { JsonlLog } from "../src/log.js";

let dir;

before(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dad-log-"));
});

after(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("JsonlLog", () => {
	test("appends one JSON object per line, creating the directory", async () => {
		const file = path.join(dir, "logs", "metrics.jsonl");
		const log = new JsonlLog(file);
		await log.append({ n: 1 });
		await log.append({ n: 2, s: "€ ok" });
		const lines = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
		assert.deepEqual(
			lines.map((line) => JSON.parse(line)),
			[{ n: 1 }, { n: 2, s: "€ ok" }],
		);
	});

	test("warns instead of throwing when the file can't be written", async () => {
		await fs.writeFile(path.join(dir, "blocker"), "");
		const warnings = [];
		const original = console.warn;
		console.warn = (message) => warnings.push(message);
		try {
			// The parent "directory" is a file, so mkdir/append must fail.
			await new JsonlLog(path.join(dir, "blocker", "metrics.jsonl")).append({ n: 1 });
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /could not append/);
	});
});
