// Per-user secrets for skill scripts — API tokens and keys — kept outside the
// workspace and handed to commands only for the message being answered.
//
// They used to live at <workspace>/users/<name>/.env, which the sandbox can
// read: any question, from anyone, could be answered by helping itself to
// someone else's keys, and eventually was. Loading them here, from a directory
// the sandbox never sees, means a request carries the credentials of the
// person who made it and no one else's — the one thing no instruction in a
// prompt could enforce.
//
// What this does not do is keep the model away from the keys it has been given
// legitimately: they are in the environment of a shell it drives, and a shell
// can read its own environment. That is the accepted trade for letting it
// improvise an API call rather than only run prewritten scripts.

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseEnv } from "dotenv";

// The name comes from a Slack profile, so treat it as someone else's input:
// only a plain handle is accepted. Traversal is not the worry — `.env` is
// always appended, so even ".." names a file rather than a directory — but a
// name with a separator in it would silently miss and read as "no secrets",
// which is exactly the failure worth being loud about.
const SLACK_HANDLE = /^[a-z0-9._-]+$/i;

// The baseline everyone gets, so the read-only access most questions need is
// written once instead of copied into a file per person. A Slack user actually
// named "shared" would own it; nobody is.
const SHARED_FILE = "shared.env";

/**
 * The secrets for one Slack user as KEY → value: the shared file with their
 * own laid over it, so a personal file adds what only they have and can
 * replace a shared value with a stronger one — the read-write token where
 * everyone else has read-only.
 *
 * A missing file at either level means nothing from that level, which is the
 * normal case: most people never need one of their own.
 */
export async function loadSecrets(secretsDir, userName) {
	const shared = await readEnvFile(path.join(secretsDir, SHARED_FILE));
	if (!userName || !SLACK_HANDLE.test(userName)) {
		if (userName) console.warn(`secrets: ignoring unusable user name "${userName}"`);
		return shared;
	}
	return { ...shared, ...(await readEnvFile(path.join(secretsDir, `${userName}.env`))) };
}

/**
 * One file as KEY → value, or nothing if it isn't there.
 *
 * Parsed with dotenv rather than by hand: it is the format these files are
 * written in, so its rules — quoting, `export` prefixes, `#` starting a
 * comment anywhere outside quotes — are the ones an admin editing them will
 * expect. We parse at all, rather than pointing `docker exec --env-file` at
 * the file, because the host executor wants the pairs as an object either
 * way, and because Docker reads a bare `KEY` line as "copy this one from the
 * calling process's environment" — not a rule worth having near a harness
 * holding a Slack bot token.
 */
async function readEnvFile(file) {
	try {
		return parseEnv(await fs.readFile(file, "utf8"));
	} catch (error) {
		// Nobody has a file until someone writes one; anything else is worth a
		// line in the log, since the symptom downstream is a missing token.
		if (error.code !== "ENOENT") console.warn(`secrets: cannot read ${file}: ${error.message}`);
		return {};
	}
}
