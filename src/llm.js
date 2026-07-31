// Originally based on the model resolution in pi-mom's src/agent.ts (MIT,
// © Mario Zechner), and specifically on Civio's local-model support added to
// our pi-mono fork in efa6045c; reworked here to register the local provider
// programmatically instead of through ~/.pi/mom/models.json:
// https://github.com/earendil-works/pi/blob/v0.70.6/packages/mom/src/agent.ts

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Registers a local Anthropic-compatible endpoint (LM Studio & co.).
 *
 * A local server has no catalog to look up, so the metadata a cloud provider
 * ships with its models is asserted here instead. `contextWindow` in
 * particular is declared, not discovered: if the server loaded the model with
 * a smaller window, nothing here will notice.
 */
function createLocalModel({ baseUrl, modelId, contextWindow, maxTokens }) {
	const model = {
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
		// Flags for Anthropic-compatible servers that don't implement
		// Anthropic-only extensions.
		compat: {
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: false,
			supportsCacheControlOnTools: false,
			supportsToolReferences: false,
			allowEmptySignature: true,
		},
	};
	const models = createModels();
	models.setProvider(
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
			models: [model],
			api: anthropicMessagesApi(),
		}),
	);
	return { models, model };
}

/** Looks a model up in pi-ai's built-in catalog (anthropic, openai, google, …). */
function createCloudModel({ provider, modelId }) {
	const models = builtinModels();
	const model = models.getModel(provider, modelId);
	if (model) return { models, model };

	const available = models.getModels(provider).map((m) => m.id);
	if (!available.length) {
		const providers = models
			.getProviders()
			.map((p) => p.id)
			.sort();
		throw new Error(`Unknown provider "${provider}". Available: local, ${providers.join(", ")}`);
	}
	const shown = available.slice(0, 15).join(", ");
	throw new Error(
		`Unknown model "${modelId}" for provider "${provider}". Available: ${shown}` +
			(available.length > 15 ? `, … (${available.length} total)` : ""),
	);
}

export function createModel({ provider, modelId, baseUrl, contextWindow, maxTokens }) {
	return provider === "local"
		? createLocalModel({ baseUrl, modelId, contextWindow, maxTokens })
		: createCloudModel({ provider, modelId });
}
