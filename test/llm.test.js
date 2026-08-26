import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import { createModel, localModelError } from "../src/llm.js";

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
		assert.equal(auth.source, "BUTTERBOT_LOCAL_API_KEY");
	});

	test("falls back to the placeholder when no key is configured", async () => {
		const { models, model } = local();
		const auth = await models.getAuth(model);
		assert.equal(auth.auth.apiKey, "local");
	});
});

describe("localModelError", () => {
	// A stand-in local server offering GET /v1/models, on an ephemeral port.
	const serving = async (handler) => {
		const server = http.createServer(handler);
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
	};
	const modelList = (ids) => (request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
	};

	test("accepts a model the server lists", async () => {
		const server = await serving(modelList(["google/gemma-4-12b", "google/gemma-4-26b-a4b"]));
		try {
			assert.equal(await localModelError({ id: "google/gemma-4-26b-a4b", baseUrl: server.baseUrl }), null);
		} finally {
			server.close();
		}
	});

	test("names the available models when the id isn't served", async () => {
		// Some servers answer for an unknown id with whatever is loaded, so this
		// mismatch must be caught before it turns into silently wrong replies.
		const server = await serving(modelList(["gemma-4-26b-a4b-it-mlx"]));
		try {
			const problem = await localModelError({ id: "google/gemma-4-26b-a4b", baseUrl: server.baseUrl });
			assert.match(problem, /"google\/gemma-4-26b-a4b" not found/);
			assert.match(problem, /gemma-4-26b-a4b-it-mlx/);
		} finally {
			server.close();
		}
	});

	test("passes a server that doesn't offer a model list", async () => {
		const server = await serving((request, response) => {
			response.statusCode = 404;
			response.end("not found");
		});
		try {
			assert.equal(await localModelError({ id: "anything", baseUrl: server.baseUrl }), null);
		} finally {
			server.close();
		}
	});

	test("passes an unreachable server, whose problem reports better elsewhere", async () => {
		assert.equal(await localModelError({ id: "anything", baseUrl: "http://127.0.0.1:1" }), null);
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
