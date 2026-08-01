import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createModel } from "../src/llm.js";

const local = () =>
	createModel({
		provider: "local",
		modelId: "google/gemma-4-26b-a4b",
		baseUrl: "http://localhost:1234",
		contextWindow: 64000,
		maxTokens: 8192,
	});

describe("local provider", () => {
	test("declares the metadata a local server can't supply", () => {
		const { model } = local();
		assert.equal(model.id, "google/gemma-4-26b-a4b");
		assert.equal(model.provider, "local");
		assert.equal(model.api, "anthropic-messages");
		assert.equal(model.baseUrl, "http://localhost:1234");
		assert.equal(model.contextWindow, 64000);
		assert.equal(model.maxTokens, 8192);
	});

	test("turns off the Anthropic-only extensions a compatible server won't have", () => {
		const { model } = local();
		assert.equal(model.compat.supportsEagerToolInputStreaming, false);
		assert.equal(model.compat.supportsCacheControlOnTools, false);
		assert.equal(model.compat.allowEmptySignature, true);
	});

	test("resolves a key, since the transport insists on one", async () => {
		const { models, model } = local();
		const auth = await models.getAuth(model);
		assert.ok(auth, "a keyless local server still has to look configured");
	});

	test("sends the configured key when the server checks one", async () => {
		const { models, model } = createModel({
			provider: "local",
			modelId: "google/gemma-4-26b-a4b",
			baseUrl: "http://localhost:1234",
			contextWindow: 64000,
			maxTokens: 8192,
			apiKey: "lms-secret",
		});
		const auth = await models.getAuth(model);
		assert.equal(auth.auth.apiKey, "lms-secret");
		assert.equal(auth.source, "DAD_LOCAL_API_KEY");
	});

	test("falls back to the placeholder when no key is configured", async () => {
		const { models, model } = local();
		const auth = await models.getAuth(model);
		assert.equal(auth.auth.apiKey, "local");
	});
});

describe("cloud providers", () => {
	test("takes model metadata from the catalog", () => {
		const { model } = createModel({ provider: "anthropic", modelId: "claude-opus-4-5" });
		assert.equal(model.provider, "anthropic");
		assert.ok(model.contextWindow > 100000, "the catalog supplies the context window");
		assert.ok(model.cost.input > 0, "and the pricing");
	});

	test("an unknown provider lists what is available", () => {
		assert.throws(() => createModel({ provider: "acme", modelId: "x" }), (error) => {
			assert.match(error.message, /Unknown provider "acme"/);
			assert.match(error.message, /anthropic/);
			return true;
		});
	});

	test("an unknown model lists that provider's models", () => {
		assert.throws(() => createModel({ provider: "anthropic", modelId: "claude-nope" }), (error) => {
			assert.match(error.message, /Unknown model "claude-nope"/);
			assert.match(error.message, /claude-/);
			return true;
		});
	});
});
