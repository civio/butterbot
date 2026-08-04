import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toMrkdwn } from "../src/mrkdwn.js";

describe("toMrkdwn", () => {
	test("bold becomes Slack's single asterisk", () => {
		assert.equal(toMrkdwn("that donor is **not** recurring"), "that donor is *not* recurring");
		assert.equal(toMrkdwn("__two__ underscores are bold too"), "*two* underscores are bold too");
	});

	test("italic becomes underscores", () => {
		assert.equal(toMrkdwn("*maybe* later"), "_maybe_ later");
		assert.equal(toMrkdwn("_already_ right"), "_already_ right");
		assert.equal(
			toMrkdwn("motivo: *insufficient_funds*"),
			"motivo: *insufficient_funds*",
			"an underscore inside would break the italic pairing, so bold it stays",
		);
	});

	test("bold and italic together nest the Slack way", () => {
		assert.equal(toMrkdwn("***very*** urgent"), "_*very*_ urgent");
	});

	test("links become <url|label>", () => {
		assert.equal(toMrkdwn("see [the invoice](https://stripe.com/i/1)"), "see <https://stripe.com/i/1|the invoice>");
		assert.equal(toMrkdwn('[titled](https://civio.es "hover")'), "<https://civio.es|titled>");
		assert.equal(toMrkdwn("![chart](https://civio.es/c.png)"), "<https://civio.es/c.png|chart>");
		assert.equal(toMrkdwn("<https://civio.es>"), "<https://civio.es>", "an autolink is already Slack's form");
	});

	test("headings become bold lines", () => {
		assert.equal(toMrkdwn("## Failed payments\ntwo of them"), "*Failed payments*\ntwo of them");
		assert.equal(toMrkdwn("### Closing ###"), "*Closing*", "closing hashes are dropped");
		assert.equal(toMrkdwn("## **Failed** payments"), "*Failed payments*", "bold inside is redundant");
	});

	test("bullets are normalised to the one Slack renders", () => {
		assert.equal(toMrkdwn("* one\n+ two\n- three"), "- one\n- two\n- three");
		assert.equal(toMrkdwn("- top\n  * nested"), "- top\n  - nested", "indentation is kept");
	});

	test("strikethrough and horizontal rules", () => {
		assert.equal(toMrkdwn("~~cancelled~~"), "~cancelled~");
		assert.equal(toMrkdwn("above\n---\nbelow"), "above\n──────────\nbelow");
	});

	test("code is copied through untouched", () => {
		assert.equal(toMrkdwn("run `a ** b` first"), "run `a ** b` first");
		assert.equal(
			toMrkdwn("```js\nconst x = [a](b);\n```"),
			"```\nconst x = [a](b);\n```",
			"the language tag would render as code",
		);
		assert.equal(
			toMrkdwn("**before**\n```\n**inside**\n```\n**after**"),
			"*before*\n```\n**inside**\n```\n*after*",
			"conversion resumes on either side of a block",
		);
	});

	test("leaves text that only looks like markup alone", () => {
		assert.equal(toMrkdwn("3 * 4 * 5"), "3 * 4 * 5");
		assert.equal(toMrkdwn("snake_case_name"), "snake_case_name");
		assert.equal(toMrkdwn("2 ** 8 is 256"), "2 ** 8 is 256");
	});

	test("handles empty and missing input", () => {
		assert.equal(toMrkdwn(""), "");
		assert.equal(toMrkdwn(undefined), undefined);
	});
});
