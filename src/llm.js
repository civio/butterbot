import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a team, reachable via Slack.
Answer concisely. Format responses as Slack mrkdwn: *bold*, _italic_, \`code\`,
bullet lists with "-". Do not use Markdown headings, tables or [text](url) links.`;

// Keep at most this many messages (user + assistant) per channel, in process
// memory only. Bounds the request size; no persistence by design.
const MAX_HISTORY = 40;

export class LlmClient {
	constructor({ baseUrl, modelId, contextWindow, maxTokens, systemPrompt }) {
		this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
		this.model = {
			id: modelId,
			name: `${modelId} (local)`,
			api: "anthropic-messages",
			provider: "local",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			// Flags for Anthropic-compatible servers (LM Studio & co.) that don't
			// implement Anthropic-only extensions.
			compat: {
				supportsEagerToolInputStreaming: false,
				supportsLongCacheRetention: false,
				supportsCacheControlOnTools: false,
				supportsToolReferences: false,
				allowEmptySignature: true,
			},
		};
		this.models = createModels();
		this.models.setProvider(
			createProvider({
				id: "local",
				name: "Local LLM",
				baseUrl,
				// Local servers ignore the key, but the transport requires one.
				auth: {
					apiKey: {
						name: "Local LLM",
						resolve: async () => ({ auth: { apiKey: "local" }, source: "keyless local server" }),
					},
				},
				models: [this.model],
				api: anthropicMessagesApi(),
			}),
		);
		this.histories = new Map();
	}

	history(channelId) {
		let history = this.histories.get(channelId);
		if (!history) {
			history = [];
			this.histories.set(channelId, history);
		}
		return history;
	}

	async reply(channelId, text) {
		const history = this.history(channelId);
		history.push({ role: "user", content: text, timestamp: Date.now() });
		while (history.length > MAX_HISTORY) history.shift();

		const response = await this.models.completeSimple(this.model, {
			systemPrompt: this.systemPrompt,
			messages: [...history],
		});
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			history.pop(); // keep the failed exchange out of the context
			throw new Error(response.errorMessage || `LLM request failed (${response.stopReason})`);
		}

		history.push(response);
		return response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
	}
}
