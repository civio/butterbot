// Structured JSONL logs for the harness: one file per concern, one JSON object
// per line, camelCase fields, RFC 3339 UTC timestamps. Fields are only ever
// added — never renamed or repurposed — and readers ignore fields they don't
// know.
//
// These files deliberately live outside the workspace: the workspace is
// mounted into the sandbox, so anything in it is readable by the model, and
// harness logs (other channels' conversations included) must not be.

import fs from "node:fs/promises";
import path from "node:path";

export class JsonlLog {
	constructor(filePath) {
		this.filePath = filePath;
	}

	/**
	 * Appends one record as a single line, creating the directory on first
	 * use. Best-effort: a reply must never fail over logging, so errors are
	 * warned about and swallowed.
	 */
	async append(record) {
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`);
		} catch (error) {
			console.warn(`could not append to ${this.filePath}: ${error.message}`);
		}
	}
}
