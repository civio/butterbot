import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { quote, renderEnv } from "../src/setup/env.js";

// What the wizard writes into, cut down to the shapes that matter here.
const EXAMPLE = [
	"# Copy to .env and fill in.",
	"",
	"# --- Slack ---",
	"export BUTTERBOT_SLACK_APP_TOKEN=xapp-...",
	"export BUTTERBOT_SLACK_BOT_TOKEN=xoxb-...",
	"",
	"# Only if the local server checks one.",
	"# export BUTTERBOT_LOCAL_API_KEY=",
	"export BUTTERBOT_MODEL=",
	"",
].join("\n");

describe("renderEnv", () => {
	test("fills values in, keeping the comments that explain them", () => {
		const written = renderEnv(EXAMPLE, { BUTTERBOT_SLACK_BOT_TOKEN: "xoxb-real", BUTTERBOT_MODEL: "google/gemma-4-26b-a4b" });
		assert.match(written, /^export BUTTERBOT_SLACK_BOT_TOKEN=xoxb-real$/m);
		assert.match(written, /^export BUTTERBOT_MODEL=google\/gemma-4-26b-a4b$/m);
		assert.match(written, /^# --- Slack ---$/m, "the section headings survive");
		assert.match(written, /^# Only if the local server checks one\.$/m);
	});

	test("leaves alone what it wasn't given", () => {
		const written = renderEnv(EXAMPLE, { BUTTERBOT_MODEL: "m" });
		assert.match(written, /^export BUTTERBOT_SLACK_APP_TOKEN=xapp-\.\.\.$/m);
		assert.match(written, /^# export BUTTERBOT_LOCAL_API_KEY=$/m, "still commented out");
	});

	test("uncomments a variable that gets a value", () => {
		const written = renderEnv(EXAMPLE, { BUTTERBOT_LOCAL_API_KEY: "lms-secret" });
		assert.match(written, /^export BUTTERBOT_LOCAL_API_KEY=lms-secret$/m);
		assert.doesNotMatch(written, /^#\s*export BUTTERBOT_LOCAL_API_KEY/m);
	});

	test("appends a variable the template doesn't mention", () => {
		const written = renderEnv(EXAMPLE, { BUTTERBOT_PROVIDER: "anthropic" });
		assert.match(written, /^export BUTTERBOT_PROVIDER=anthropic$/m);
		assert.match(written, /# Added by npm run setup\.\nexport BUTTERBOT_PROVIDER=anthropic/);
	});

	test("skips what has no value, rather than blanking it", () => {
		const written = renderEnv(EXAMPLE, { BUTTERBOT_MODEL: "m", ANTHROPIC_API_KEY: undefined });
		assert.doesNotMatch(written, /ANTHROPIC_API_KEY/, "an unasked-for key is not invented");
	});

	test("an empty value is a value: it clears the variable", () => {
		// How a base URL left over from an earlier run stops being passed to a
		// cloud provider, which refuses the flag.
		const written = renderEnv("export BUTTERBOT_BASE_URL=http://localhost:1234\n", { BUTTERBOT_BASE_URL: "" });
		assert.match(written, /^export BUTTERBOT_BASE_URL=''$/m);
	});

	// A second run reads back what the first one wrote, so the two have to agree.
	test("a rendered file is a template for the next run", () => {
		const first = renderEnv(EXAMPLE, { BUTTERBOT_MODEL: "one", BUTTERBOT_PROVIDER: "local" });
		const second = renderEnv(first, { BUTTERBOT_MODEL: "two" });
		assert.match(second, /^export BUTTERBOT_MODEL=two$/m);
		assert.match(second, /^export BUTTERBOT_PROVIDER=local$/m);
		assert.equal(second.match(/BUTTERBOT_PROVIDER/g).length, 1, "not appended a second time");
	});
});

describe("quote", () => {
	test("leaves the values setup actually collects unquoted", () => {
		for (const value of ["xoxb-1234-abcd", "google/gemma-4-26b-a4b", "http://localhost:1234", "./workspace-example"]) {
			assert.equal(quote(value), value);
		}
	});

	test("quotes a path with a space in it, so sourcing the file doesn't split it", () => {
		assert.equal(quote("./my workspace"), "'./my workspace'");
	});

	test("quotes what would otherwise be read as shell syntax", () => {
		assert.equal(quote("a$b"), "'a$b'");
		assert.equal(quote("a#b"), "'a#b'");
		assert.equal(quote(""), "''");
	});

	test("refuses a value it can't write for both readers of the file", () => {
		assert.throws(() => quote("it's"), /single quote/);
	});
});
