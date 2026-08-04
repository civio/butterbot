/**
 * Standard Markdown → Slack mrkdwn.
 *
 * The model writes Markdown and the harness translates it, rather than the
 * system prompt asking for Slack's dialect and hoping: smaller models ignore
 * that instruction often enough to be a nuisance, and the transport's markup
 * is not the model's problem anyway.
 *
 * Only the differences are touched — `code`, ```blocks```, `- ` bullets and
 * `> ` quotes already mean the same thing in both.
 */
export function toMrkdwn(text) {
	if (!text) return text;
	// Code is copied through verbatim: inside it, `**` and `[x](y)` are the
	// literal characters someone asked to see, not formatting.
	return text
		.split(/(```[\s\S]*?```|`[^`\n]*`)/)
		.map((segment, index) => (index % 2 ? fence(segment) : convert(segment)))
		.join("");
}

// Slack has no info string: ```js renders the "js" as the first line of code.
const fence = (segment) => segment.replace(/^```[^\n`]+\n/, "```\n");

function convert(text) {
	return (
		text
			// Links first, so emphasis inside a label never becomes a stray marker
			// in the middle of a <url|label>. Images lose the image, keeping the link.
			.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) =>
				label ? `<${url}|${label}>` : `<${url}>`,
			)
			// Line markers. The rule goes before the bullet rewrite, which would
			// otherwise eat the first "*" of "* * *".
			.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "──────────") // horizontal rule
			.replace(/^(\s*)[*+][ \t]+/gm, "$1- ") // bullets: Slack only renders "-"
			// Emphasis, widest marker first so the narrower rules see clean input.
			.replace(/\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/g, "_*$1*_")
			// Italic before bold: matching a lone "*" means requiring that its
			// neighbours are not "*", which is exactly what leaves "**bold**" alone.
			// The \w in the lookarounds also spares 3 * 4 and file*.txt.
			// Underscores inside would give Slack a second pair to close on, and
			// _insufficient_funds_ comes out italic on the first word only. Left as
			// asterisks it reads as bold: the wrong emphasis, but not mangled text.
			.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, (match, body) =>
				body.includes("_") ? match : `_${body}_`,
			)
			.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "*$1*")
			.replace(/(?<!\w)__(?!\s)([^_\n]+?)(?<!\s)__(?!\w)/g, "*$1*")
			.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "~$1~")
			// Headings last: Slack has none, so the line is bolded whole — and
			// running after the emphasis rules keeps them from reading that bold
			// back as a pair of italics. Bold inside is dropped as redundant.
			.replace(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (match, title) => `*${title.replaceAll("*", "")}*`)
	);
}
