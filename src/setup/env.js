// Writing the .env the setup wizard collects. Kept apart from wizard.js so the
// part with the rules in it can be tested without a terminal attached.

// Characters that need no quoting in either reader of this file. Anything else
// gets quoted; see quote() for why the set is this conservative.
const UNQUOTED = /^[A-Za-z0-9_.:/@%+,^=-]+$/;

// Matches an assignment line, set or commented out, with or without `export`.
const ASSIGNMENT = /^#?\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/;

/**
 * Quotes a value for a file that is read two ways: sourced by sh, which is how
 * `npm start` picks it up, and parsed by dotenv for the per-user secrets. Single
 * quotes are the one form both take literally — but a value containing a single
 * quote itself has no form they agree on (sh's `'\''` idiom is not dotenv's), so
 * rather than write something that reads back differently depending on who
 * opens it, this refuses. The prompts reject those values on the way in.
 */
export function quote(value) {
	if (UNQUOTED.test(value)) return value;
	if (value.includes("'")) {
		throw new Error(`Cannot write ${JSON.stringify(value)} to .env: values may not contain a single quote.`);
	}
	return `'${value}'`;
}

/**
 * Fills `values` into a copy of `template` — .env.example on a first run, the
 * existing .env on a later one.
 *
 * Editing a template rather than emitting the keys is what keeps the comments
 * explaining each variable, and what lets a second run leave alone everything
 * the wizard doesn't ask about. A variable the template has commented out is
 * uncommented when it gets a value; one the template doesn't mention at all is
 * appended.
 */
export function renderEnv(template, values) {
	const pending = new Map(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
	const lines = template.split("\n").map((line) => {
		const name = line.match(ASSIGNMENT)?.[1];
		if (!name || !pending.has(name)) return line;
		const value = pending.get(name);
		pending.delete(name);
		return `export ${name}=${quote(value)}`;
	});

	if (pending.size) {
		if (lines.at(-1) !== "") lines.push("");
		lines.push("# Added by npm run setup.");
		for (const [name, value] of pending) lines.push(`export ${name}=${quote(value)}`);
		lines.push("");
	}
	return lines.join("\n");
}
