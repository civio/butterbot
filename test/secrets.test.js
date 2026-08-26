import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadSecrets } from "../src/secrets.js";

let secretsDir;

before(async () => {
	secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "butterbot-secrets-"));
	// The baseline: read-only access, nobody's in particular.
	await fs.writeFile(
		path.join(secretsDir, "shared.env"),
		["# CRM read-only", "CRM_API_TOKEN_DONOR_SUPPORT=readonly-token", "CRM_API_URL=https://crm.civio.es", ""].join("\n"),
	);
	await fs.writeFile(
		path.join(secretsDir, "david.env"),
		["CRM_API_TOKEN_DONOR_SUPPORT=readwrite-token", "STRIPE_API_KEY=rk_live_abc", ""].join("\n"),
	);
	await fs.writeFile(path.join(secretsDir, "carmen.env"), "MAILCHIMP_API_KEY=mc-carmen\n");
});

after(async () => {
	await fs.rm(secretsDir, { recursive: true, force: true });
});

describe("loadSecrets", () => {
	test("lays a user's own file over the shared one", async () => {
		assert.deepEqual(await loadSecrets(secretsDir, "david"), {
			CRM_API_TOKEN_DONOR_SUPPORT: "readwrite-token", // his own beats the shared read-only one
			CRM_API_URL: "https://crm.civio.es", // shared, and he doesn't override it
			STRIPE_API_KEY: "rk_live_abc", // only his
		});
	});

	test("gives each user their own keys and nobody else's", async () => {
		const carmen = await loadSecrets(secretsDir, "carmen");
		assert.equal(carmen.MAILCHIMP_API_KEY, "mc-carmen");
		assert.equal(carmen.STRIPE_API_KEY, undefined, "David's Stripe key is not hers to use");
		assert.equal(carmen.CRM_API_TOKEN_DONOR_SUPPORT, "readonly-token", "she is on the shared baseline");
	});

	test("a user with no file of their own still gets the shared one", async () => {
		assert.deepEqual(await loadSecrets(secretsDir, "newcomer"), {
			CRM_API_TOKEN_DONOR_SUPPORT: "readonly-token",
			CRM_API_URL: "https://crm.civio.es",
		});
	});

	test("a missing directory is not an error, at either level", async () => {
		assert.deepEqual(await loadSecrets(path.join(secretsDir, "nope"), "david"), {});
	});

	test("an unusable name still gets the shared file, but nobody's personal one", async () => {
		// "unknown" is what slack.js falls back to when the users:read lookup
		// fails, and it is a legal handle: it reads as "no file", not as a refusal.
		for (const name of ["../david", "da/vid", "", undefined, "david ", "d;id"]) {
			const secrets = await loadSecrets(secretsDir, name);
			assert.equal(secrets.STRIPE_API_KEY, undefined, `accepted ${JSON.stringify(name)}`);
			assert.equal(secrets.CRM_API_TOKEN_DONOR_SUPPORT, "readonly-token");
		}
	});
});

// The parsing is dotenv's, not ours; this pins the format we tell admins to
// write, and would catch the day an upgrade changes it under us.
describe("file format", () => {
	test("reads the shapes a hand-written .env uses", async () => {
		await fs.writeFile(
			path.join(secretsDir, "formats.env"),
			[
				"# a comment line",
				"",
				"PLAIN=1",
				"  SPACED = 2  ",
				"export PREFIXED=3",
				'DOUBLE="hello world"',
				"SINGLE='hi'",
				"EMPTY=",
				"just words",
				'HASH="tok#en"', // quoted, because unquoted a # starts a comment
			].join("\n"),
		);
		assert.deepEqual(await loadSecrets(secretsDir, "formats"), {
			CRM_API_TOKEN_DONOR_SUPPORT: "readonly-token", // from shared.env
			CRM_API_URL: "https://crm.civio.es",
			PLAIN: "1",
			SPACED: "2",
			PREFIXED: "3",
			DOUBLE: "hello world",
			SINGLE: "hi",
			EMPTY: "",
			HASH: "tok#en",
		});
	});

	test("an unquoted # starts a comment, so a trailing note is not part of the token", async () => {
		await fs.writeFile(path.join(secretsDir, "commented.env"), "TOKEN=abc123 # David's key\n");
		const secrets = await loadSecrets(secretsDir, "commented");
		assert.equal(secrets.TOKEN, "abc123");
	});
});
