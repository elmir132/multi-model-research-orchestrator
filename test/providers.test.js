import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, providersFromEnv } from "../src/providers.js";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function provider(fetchImpl, options = {}) {
  return new OpenAICompatibleProvider({ name: "test", baseUrl: "https://example.test/v1", apiKey: "secret", model: "test-model", retries: 0, fetchImpl, ...options });
}

test("provider sends an authenticated chat request and returns text", async () => {
  let request;
  const value = await provider(async (url, options) => { request = { url, options }; return response(200, { choices: [{ message: { content: "answer" } }] }); }).complete("question");
  assert.equal(value, "answer");
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer secret");
});

test("provider surfaces HTTP errors", async () => {
  await assert.rejects(provider(async () => response(400, { error: { message: "bad request" } })).complete("question"), /returned 400: bad request/);
});

test("provider rejects empty responses", async () => {
  await assert.rejects(provider(async () => response(200, { choices: [] })).complete("question"), /returned no text/);
});

test("provider applies a request timeout", async () => {
  const abortingFetch = async (_url, options) => {
    assert.ok(options.signal);
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(provider(abortingFetch, { timeoutMs: 5 }).complete("question"), /request failed: timed out/);
});

test("provider retries a rate-limited request", async () => {
  let calls = 0;
  const value = await provider(async () => {
    calls += 1;
    return calls === 1 ? response(429, { error: { message: "slow down" } }) : response(200, { choices: [{ message: { content: "recovered" } }] });
  }, { retries: 1, sleep: async () => {} }).complete("question");
  assert.equal(value, "recovered");
  assert.equal(calls, 2);
});

test("HTTP errors are not wrapped twice", async () => {
  await assert.rejects(
    provider(async () => response(400, { error: { message: "bad request" } })).complete("question"),
    (error) => error.message === "test returned 400: bad request"
  );
});

test("one Mistral key configures a medium and a small provider", () => {
  const providers = providersFromEnv({ MISTRAL_API_KEY: "secret" });
  assert.deepEqual(providers.map((p) => [p.name, p.model, p.baseUrl]), [
    ["mistral", "mistral-medium-latest", "https://api.mistral.ai/v1"],
    ["mistral-small", "mistral-small-latest", "https://api.mistral.ai/v1"]
  ]);
});

test("Mistral models can be overridden and no key means no Mistral providers", () => {
  const [medium, small] = providersFromEnv({ MISTRAL_API_KEY: "k", MISTRAL_MODEL: "a", MISTRAL_SMALL_MODEL: "b" });
  assert.equal(medium.model, "a");
  assert.equal(small.model, "b");
  assert.deepEqual(providersFromEnv({}).map((p) => p.name), []);
});
