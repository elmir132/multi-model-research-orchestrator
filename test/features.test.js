import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPrompt, parseAnalysis, PERSPECTIVES, runPool, runResearch, synthesize, validatePerspectives } from "../src/core.js";
import { createCache } from "../src/cache.js";
import { esc, renderReport } from "../src/report.js";
import { loadSources, verifyQuotes } from "../src/sources.js";
import { AnthropicProvider, GeminiProvider, OllamaProvider, OpenAICompatibleProvider, providersFromEnv } from "../src/providers.js";
import { HELP, runCli } from "../src/cli.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-test-"));
const answer = (claim = "A claim") => JSON.stringify({ claim, confidence: 0.7, evidenceToVerify: ["x"], risks: ["y"], recommendation: "do z" });

class FakeProvider {
  constructor(name, { delay = 0, text = answer(`claim from ${name}`), usage = null, fail = false } = {}) {
    Object.assign(this, { name, model: `${name}-model`, delay, text, usage, fail, calls: 0 });
  }
  async completeWithUsage() {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.fail) throw new Error("boom");
    return { text: this.text, usage: this.usage };
  }
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
function capture(body, status = 200) {
  const seen = {};
  const fetchImpl = async (url, options) => { Object.assign(seen, { url, options, body: JSON.parse(options.body) }); return reply(status, body); };
  return { seen, fetchImpl };
}

// ---------- providers ----------

test("Anthropic provider uses the Messages API and reads text and usage", async () => {
  const { seen, fetchImpl } = capture({ content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }], usage: { input_tokens: 11, output_tokens: 4 } });
  const provider = new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl, retries: 0 });
  assert.deepEqual(await provider.completeWithUsage("q"), { text: "hello world", usage: { inputTokens: 11, outputTokens: 4 } });
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.options.headers["x-api-key"], "k");
  assert.equal(seen.options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(seen.body.messages, [{ role: "user", content: "q" }]);
  assert.ok(seen.body.max_tokens > 0);
  assert.equal("temperature" in seen.body, false);
});

test("Gemini provider keeps the key out of the URL and reads text and usage", async () => {
  const { seen, fetchImpl } = capture({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } });
  const provider = new GeminiProvider({ apiKey: "secret-key", model: "gemini-test", fetchImpl, retries: 0 });
  assert.deepEqual(await provider.completeWithUsage("q"), { text: "ab", usage: { inputTokens: 5, outputTokens: 2 } });
  assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.ok(!seen.url.includes("secret-key"));
  assert.equal(seen.options.headers["x-goog-api-key"], "secret-key");
});

test("Ollama provider talks to a local server without a key", async () => {
  const { seen, fetchImpl } = capture({ message: { content: "local answer" }, prompt_eval_count: 7, eval_count: 3 });
  const provider = new OllamaProvider({ model: "llama-test", fetchImpl, retries: 0 });
  assert.deepEqual(await provider.completeWithUsage("q"), { text: "local answer", usage: { inputTokens: 7, outputTokens: 3 } });
  assert.equal(seen.url, "http://localhost:11434/api/chat");
  assert.equal(seen.body.stream, false);
  assert.equal(seen.options.headers.authorization, undefined);
});

test("error bodies from every API shape are surfaced", async () => {
  const gemini = new GeminiProvider({ apiKey: "k", model: "m", retries: 0, fetchImpl: async () => reply(400, { error: { message: "bad key" } }) });
  await assert.rejects(gemini.complete("q"), (e) => e.message === "gemini returned 400: bad key");
  const ollama = new OllamaProvider({ model: "m", retries: 0, fetchImpl: async () => reply(404, { error: "model not found" }) });
  await assert.rejects(ollama.complete("q"), (e) => e.message === "ollama returned 404: model not found");
});

test("OpenAI-compatible providers now report token usage too", async () => {
  const { fetchImpl } = capture({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 9, completion_tokens: 1 } });
  const provider = new OpenAICompatibleProvider({ name: "t", baseUrl: "https://x.test/v1", apiKey: "k", model: "m", fetchImpl, retries: 0 });
  assert.deepEqual((await provider.completeWithUsage("q")).usage, { inputTokens: 9, outputTokens: 1 });
  assert.equal(await provider.complete("q"), "ok");
});

test("providersFromEnv adds Anthropic, Gemini and Ollama only when configured", () => {
  assert.deepEqual(providersFromEnv({}).map((p) => p.name), []);
  const all = providersFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OLLAMA_MODEL: "llama" });
  assert.deepEqual(all.map((p) => p.name), ["anthropic", "gemini", "ollama"]);
  assert.equal(providersFromEnv({ OLLAMA_HOST: "http://elsewhere:1" }).length, 0);
  assert.equal(providersFromEnv({ OLLAMA_MODEL: "m", OLLAMA_HOST: "http://box:11434" })[0].baseUrl, "http://box:11434");
  assert.equal(providersFromEnv({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "custom" })[0].model, "custom");
});

// ---------- concurrency, limits, cache ----------

test("runPool never exceeds the concurrency limit and finishes everything", async () => {
  let active = 0;
  let peak = 0;
  const done = [];
  await runPool([...Array(9).keys()], 3, async (item) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1; done.push(item);
  });
  assert.equal(done.length, 9);
  assert.equal(peak, 3);
});

test("responses keep provider order even when slow providers finish last", async () => {
  const root = await tmp();
  const slow = new FakeProvider("slow", { delay: 30 });
  const fast = new FakeProvider("fast");
  const result = await runResearch("Order check", { providers: [slow, fast], outputRoot: root, concurrency: 6 });
  assert.deepEqual(result.responses.map((r) => r.provider), ["slow", "slow", "slow", "fast", "fast", "fast"]);
  const files = (await fs.readdir(result.outputDir)).filter((f) => f.endsWith(".md")).sort();
  assert.equal(files[0], "01-slow-technical.md");
  assert.equal(files[3], "04-fast-technical.md");
  assert.equal(files.at(-1), "07-synthesis.md");
});

test("maxCalls refuses before making any call", async () => {
  const root = await tmp();
  const provider = new FakeProvider("p");
  await assert.rejects(runResearch("Too big", { providers: [provider], outputRoot: root, maxCalls: 2 }), /would make 3 model calls.*limit of 2/);
  assert.equal(provider.calls, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test("the cache answers a repeat run without calling the provider", async () => {
  const root = await tmp();
  const cache = createCache(path.join(root, "cache"));
  const first = new FakeProvider("p", { usage: { inputTokens: 1, outputTokens: 2 } });
  await runResearch("Cache check", { providers: [first], outputRoot: path.join(root, "a"), cache });
  assert.equal(first.calls, 3);
  const second = new FakeProvider("p", { usage: { inputTokens: 1, outputTokens: 2 } });
  const result = await runResearch("Cache check", { providers: [second], outputRoot: path.join(root, "b"), cache });
  assert.equal(second.calls, 0);
  assert.ok(result.responses.every((r) => r.cached === true && r.status === "ok"));
  assert.deepEqual(result.responses[0].usage, { inputTokens: 1, outputTokens: 2 });
});

test("failed calls are not cached and a different model is a different key", async () => {
  const root = await tmp();
  const cache = createCache(path.join(root, "cache"));
  const broken = new FakeProvider("p", { fail: true });
  const bad = await runResearch("Fail check", { providers: [broken], outputRoot: path.join(root, "a"), cache });
  assert.ok(bad.responses.every((r) => r.status === "error"));
  const healed = new FakeProvider("p");
  await runResearch("Fail check", { providers: [healed], outputRoot: path.join(root, "b"), cache });
  assert.equal(healed.calls, 3);
  const otherModel = new FakeProvider("p");
  otherModel.model = "different";
  await runResearch("Fail check", { providers: [otherModel], outputRoot: path.join(root, "c"), cache });
  assert.equal(otherModel.calls, 3);
});

test("the manifest records latency, usage, cache state and settings", async () => {
  const root = await tmp();
  const result = await runResearch("Manifest check", { providers: [new FakeProvider("p", { usage: { inputTokens: 4, outputTokens: 5 } })], outputRoot: root, concurrency: 2 });
  const manifest = JSON.parse(await fs.readFile(path.join(result.outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.settings.concurrency, 2);
  assert.deepEqual(manifest.settings.perspectives, ["technical", "practical", "critical"]);
  assert.ok(manifest.responses.every((r) => Number.isFinite(r.latencyMs) && r.cached === false));
  assert.deepEqual(manifest.responses[0].usage, { inputTokens: 4, outputTokens: 5 });
});

// ---------- perspectives ----------

test("custom perspectives are validated", () => {
  const good = [{ id: "legal", label: "Legal view", instruction: "Check the law." }];
  assert.deepEqual(validatePerspectives(good), good);
  assert.throws(() => validatePerspectives([]), /non-empty/);
  assert.throws(() => validatePerspectives([{ id: "Bad Id", label: "x", instruction: "y" }]), /id must be/);
  assert.throws(() => validatePerspectives([...good, ...good]), /duplicate id/);
  assert.throws(() => validatePerspectives([{ id: "a", label: "", instruction: "y" }]), /label/);
  assert.throws(() => validatePerspectives([{ id: "a", label: "x", instruction: "y".repeat(401) }]), /instruction/);
  assert.throws(() => validatePerspectives(Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, label: "l", instruction: "i" }))), /at most 6/);
});

test("a run can use custom perspectives", async () => {
  const root = await tmp();
  const perspectives = validatePerspectives([{ id: "legal", label: "Legal view", instruction: "Check the law." }]);
  const result = await runResearch("Custom", { providers: [new FakeProvider("p")], outputRoot: root, perspectives });
  assert.deepEqual(result.responses.map((r) => r.perspective), ["legal"]);
  assert.equal(result.synthesisFile, "02-synthesis.md");
});

// ---------- sources and quote verification ----------

test("prompts include the source documents and ask for exact quotes only when sources exist", () => {
  const plain = buildPrompt("Q", PERSPECTIVES[0]);
  assert.ok(!plain.includes("quotes"));
  const withSources = buildPrompt("Q", PERSPECTIVES[0], [{ name: "law.md", text: "Rent may rise 5% a year." }]);
  assert.match(withSources, /\[document: law\.md\]/);
  assert.match(withSources, /Rent may rise 5% a year\./);
  assert.match(withSources, /"quotes"/);
});

test("parseAnalysis keeps well-formed quotes and drops malformed ones", () => {
  const a = parseAnalysis(JSON.stringify({ claim: "c", recommendation: "r", quotes: [{ source: "a.md", quote: "q" }, { source: 1 }, null, "x"] }));
  assert.deepEqual(a.quotes, [{ source: "a.md", quote: "q" }]);
  assert.deepEqual(parseAnalysis("not json").quotes, []);
});

test("verifyQuotes accepts exact text, ignores whitespace, and rejects the rest", () => {
  const sources = [{ name: "law.md", text: "Rent may rise\n5% a year,   no more." }];
  const result = verifyQuotes([
    { source: "law.md", quote: "Rent may rise 5% a year," },
    { source: "law.md", quote: "rent may rise 5% a year" },
    { source: "law.md", quote: "Rent may rise 9% a year" },
    { source: "other.md", quote: "Rent" }
  ], sources);
  assert.equal(result.checked, 4);
  assert.equal(result.verified, 1);
  assert.deepEqual(result.failed.map((f) => f.reason), ["quote not found in source", "quote not found in source", "unknown source"]);
});

test("loadSources reads md and txt files and enforces limits", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "b.txt"), "second");
  await fs.writeFile(path.join(dir, "a.md"), "first");
  await fs.writeFile(path.join(dir, "ignore.pdf"), "x");
  assert.deepEqual((await loadSources(dir)).map((s) => s.name), ["a.md", "b.txt"]);
  const empty = await tmp();
  await assert.rejects(loadSources(empty), /No \.md or \.txt/);
  await fs.writeFile(path.join(dir, "big.md"), "x".repeat(70000));
  await assert.rejects(loadSources(dir), /limit is 60000/);
});

test("a run with sources verifies quotes and shows them in the synthesis and report", async () => {
  const root = await tmp();
  const sources = [{ name: "law.md", text: "Landlords must disclose utility debt before signing." }];
  const text = JSON.stringify({ claim: "Disclosure is required", confidence: 0.8, evidenceToVerify: [], risks: [], recommendation: "Check it",
    quotes: [{ source: "law.md", quote: "must disclose utility debt" }, { source: "law.md", quote: "must pay a fine" }] });
  const result = await runResearch("Sources", { providers: [new FakeProvider("p", { text })], outputRoot: root, sources, perspectives: [PERSPECTIVES[0]] });
  assert.deepEqual(result.responses[0].analysis.verification.verified, 1);
  const synthesis = await fs.readFile(path.join(result.outputDir, result.synthesisFile), "utf8");
  assert.match(synthesis, /## Quote verification/);
  assert.match(synthesis, /\| technical \| p \| 1\/2 \|/);
  assert.match(synthesis, /does not show that the model understood it correctly/);
  const html = await fs.readFile(path.join(result.outputDir, "report.html"), "utf8");
  assert.match(html, /Quotes verified: 1\/2/);
  const manifest = JSON.parse(await fs.readFile(path.join(result.outputDir, "manifest.json"), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("Landlords must disclose"), false, "source text is not copied into the manifest settings");
});

test("without sources the synthesis has no verification section", () => {
  const text = synthesize("Q", [{ perspective: "technical", provider: "a", status: "ok", analysis: { claim: "c", confidence: 0.5 } }]);
  assert.ok(!text.includes("Quote verification"));
});

// ---------- HTML report ----------

test("esc neutralises HTML metacharacters", () => {
  assert.equal(esc(`<script>alert("x")</script> & '`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;");
});

test("the report escapes model output and has no script of its own", async () => {
  const root = await tmp();
  const evil = answer("<script>alert(1)</script> & <img src=x onerror=alert(2)>");
  const result = await runResearch("<b>Topic</b>", { providers: [new FakeProvider("a", { text: evil }), new FakeProvider("b")], outputRoot: root });
  const html = await fs.readFile(path.join(result.outputDir, "report.html"), "utf8");
  assert.ok(!html.includes("<script"), "no script tag at all");
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>Topic"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!/https?:\/\//.test(html.replace(/<title>[\s\S]*?<\/title>/, "")), "loads nothing from the network");
});

test("report can be switched off and shows errors, tokens and cache state", async () => {
  const root = await tmp();
  const off = await runResearch("No report", { providers: [new FakeProvider("a")], outputRoot: path.join(root, "x"), report: false });
  assert.equal(off.reportFile, null);
  assert.ok(!(await fs.readdir(off.outputDir)).includes("report.html"));
  const on = await runResearch("Report", { providers: [new FakeProvider("a", { usage: { inputTokens: 10, outputTokens: 5 } }), new FakeProvider("b", { fail: true })], outputRoot: path.join(root, "y") });
  const html = await fs.readFile(path.join(on.outputDir, "report.html"), "utf8");
  assert.match(html, /Provider error: boom/);
  assert.match(html, /45/);              // 3 calls x 15 tokens
  assert.match(html, /3\/6/);
});

test("renderReport copes with a single provider (no comparisons)", () => {
  const html = renderReport({ topic: "T", generatedAt: "now", perspectives: [PERSPECTIVES[0]], comparisons: [{ perspective: "technical", status: "needs at least two providers", comparisons: [] }],
    responses: [{ perspective: "technical", provider: "a", status: "ok", analysis: { claim: "c", confidence: null, recommendation: "r", risks: [], evidenceToVerify: [] } }] });
  assert.match(html, /needs at least two providers/);
});

// ---------- CLI ----------

function io() {
  const out = []; const err = [];
  return { out, err, options: { env: {}, stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

test("CLI prints help and the version", async () => {
  const a = io();
  assert.equal(await runCli(["--help"], a.options), 0);
  assert.equal(a.out.join(""), HELP);
  for (const flag of ["--mock", "--providers", "--perspectives-file", "--sources", "--max-calls", "--cache", "--concurrency", "ANTHROPIC_API_KEY", "OLLAMA_MODEL"]) assert.ok(HELP.includes(flag), flag);
  const b = io();
  assert.equal(await runCli(["-v"], b.options), 0);
  assert.match(b.out.join(""), /^\d+\.\d+\.\d+\n$/);
});

test("CLI usage errors exit with status 2 and say why", async () => {
  const cases = [
    [[], /question is required/],
    [["q"], /No providers configured/],
    [["q", "--mock", "--providers", "nope"], /Unknown provider nope. Available: mock-optimist, mock-skeptic/],
    [["q", "--mock", "--perspectives", "technical,wat"], /Unknown perspective wat/],
    [["q", "--mock", "--concurrency", "0"], /--concurrency must be a whole number from 1 to 10/],
    [["q", "--mock", "--max-calls", "abc"], /--max-calls must be a whole number/],
    [["q", "--mock", "--perspectives", "technical", "--perspectives-file", "x.json"], /not both/],
    [["q", "--mock", "--perspectives-file", "/nonexistent.json"], /Could not read perspectives file/],
    [["q", "--mock", "--sources", "/nonexistent-dir"], /ENOENT|no such file/i],
    [["q", "--mock", "--bogus"], /Unknown option/]
  ];
  for (const [argv, pattern] of cases) {
    const r = io();
    assert.equal(await runCli(argv, r.options), 2, argv.join(" "));
    assert.match(r.err.join(""), pattern, argv.join(" "));
  }
});

test("CLI mock run writes the files and the report, and can pick providers and perspectives", async () => {
  const root = await tmp();
  const r = io();
  assert.equal(await runCli(["Does it work?", "--mock", "--out", root, "--providers", "mock-skeptic", "--perspectives", "technical,critical"], r.options), 0);
  const dir = path.join(root, "does-it-work");
  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ["01-mock-skeptic-technical.md", "02-mock-skeptic-critical.md", "03-synthesis.md", "manifest.json", "report.html"]);
  assert.match(r.out.join(""), /Report: .*report\.html/);
});

test("CLI --no-report, --max-calls and --perspectives-file", async () => {
  const root = await tmp();
  const file = path.join(root, "p.json");
  await fs.writeFile(file, JSON.stringify([{ id: "legal", label: "Legal", instruction: "Check the law." }]));
  const a = io();
  assert.equal(await runCli(["Q one", "--mock", "--out", root, "--perspectives-file", file, "--no-report"], a.options), 0);
  assert.deepEqual((await fs.readdir(path.join(root, "q-one"))).sort(), ["01-mock-optimist-legal.md", "02-mock-skeptic-legal.md", "03-synthesis.md", "manifest.json"]);
  const b = io();
  assert.equal(await runCli(["Q two", "--mock", "--out", root, "--max-calls", "5"], b.options), 1);
  assert.match(b.err.join(""), /would make 6 model calls/);
  assert.ok(!(await fs.readdir(root)).includes("q-two"));
});

test("CLI --cache reports reused answers on a second run", async () => {
  const root = await tmp();
  const cacheDir = path.join(root, "cache");
  const first = io();
  assert.equal(await runCli(["Cached", "--mock", "--out", root, "--cache-dir", cacheDir], first.options), 0);
  assert.ok(!first.out.join("").includes("from the cache"));
  const second = io();
  assert.equal(await runCli(["Cached", "--mock", "--out", root, "--cache-dir", cacheDir], second.options), 0);
  assert.match(second.out.join(""), /6 answer\(s\) came from the cache/);
});

test("CLI --sources loads the folder and runs with quote verification", async () => {
  const root = await tmp();
  const sources = path.join(root, "src");
  await fs.mkdir(sources);
  await fs.writeFile(path.join(sources, "doc.md"), "Some source text.");
  const r = io();
  assert.equal(await runCli(["Q", "--mock", "--out", root, "--sources", sources], r.options), 0);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "q", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.settings.sources, [{ name: "doc.md", characters: 17 }]);
});

// ---------- evaluation data ----------

test("the labelled claim pairs are balanced and well formed", async () => {
  const { pairs } = JSON.parse(await fs.readFile(new URL("../eval/claim_pairs.json", import.meta.url), "utf8"));
  assert.equal(pairs.length, 40);
  assert.equal(pairs.filter((p) => p.label === "agree").length, 20);
  assert.ok(pairs.every((p) => ["agree", "disagree"].includes(p.label) && p.a && p.b && p.kind));
  assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length);
});
