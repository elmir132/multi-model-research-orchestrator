import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPrompt, cell, claimSimilarity, compareResponses, hasNegation, runResearch, slugify, synthesize } from "../src/core.js";
import { MockProvider, OpenAICompatibleProvider, mockProviders, providersFromEnv } from "../src/providers.js";

test("slugify creates safe, bounded directory names", () => {
  assert.equal(slugify("  Hello, Research World!  "), "hello-research-world");
  assert.ok(slugify("x".repeat(100)).length <= 60);
});

test("prompts require evidence and disclose assumptions", () => {
  const prompt = buildPrompt("Should cities regulate utility disclosures?", { label: "Critical analysis", instruction: "Challenge assumptions." });
  assert.match(prompt, /ONLY valid JSON/);
  assert.match(prompt, /Do not invent citations/);
});

test("mock workflow writes every provider-perspective pair and a manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-orchestrator-"));
  const result = await runResearch("Can this workflow be audited?", { providers: [new MockProvider("alpha"), new MockProvider("beta")], outputRoot: root });
  const files = await fs.readdir(result.outputDir);
  assert.equal(files.filter((file) => file.endsWith(".md")).length, 7);
  assert.equal(result.responses.length, 6);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.outputDir, "manifest.json"), "utf8")).responses.length, 6);
});

test("synthesis reports a real disagreement", () => {
  const responses = [
    { perspective: "technical", provider: "a", status: "ok", analysis: { claim: "The system is feasible and reliable", confidence: 0.8 } },
    { perspective: "technical", provider: "b", status: "ok", analysis: { claim: "The system is risky and unreliable", confidence: 0.4 } }
  ];
  assert.equal(claimSimilarity(responses[0].analysis.claim, responses[1].analysis.claim), 0.2);
  assert.equal(compareResponses(responses)[0].comparisons[0].verdict, "disagreement");
  assert.match(synthesize("Question", responses), /disagreement/);
});

test("providersFromEnv exposes only configured OpenAI-compatible providers", () => {
  const providers = providersFromEnv({ OPENAI_API_KEY: "one", OPENAI_MODEL: "model-a", GEMINI_API_KEY: "ignored", GROQ_API_KEY: "two" });
  assert.deepEqual(providers.map((provider) => provider.name), ["openai", "groq"]);
});

const ok = (perspective, provider, claim, confidence = 0.8) => ({ perspective, provider, status: "ok", analysis: { claim, confidence } });

test("a negated claim is a disagreement even when the wording overlaps", () => {
  const responses = [
    ok("technical", "a", "The policy is feasible and effective"),
    ok("technical", "b", "The policy is not feasible and not effective")
  ];
  const [pair] = compareResponses(responses)[0].comparisons;
  assert.ok(pair.score >= 0.5, "wording overlap is high");
  assert.equal(pair.verdict, "disagreement");
  assert.match(pair.reason, /negated/);
});

test("matching polarity with similar wording is agreement", () => {
  const [pair] = compareResponses([
    ok("critical", "a", "The main risk is mistaking model agreement for evidence"),
    ok("critical", "b", "The main risk is mistaking model agreement for evidence or truth")
  ])[0].comparisons;
  assert.equal(pair.verdict, "agreement");
});

test("negation detection handles contractions", () => {
  assert.equal(hasNegation("It doesn't scale"), true);
  assert.equal(hasNegation("It can't work"), true);
  assert.equal(hasNegation("It scales well"), false);
});

test("claims table lists every provider, not just the last one", () => {
  const text = synthesize("Q", [
    ok("technical", "alpha", "Claim from alpha", 0.9),
    ok("technical", "beta", "Claim from beta", 0.4)
  ]);
  assert.match(text, /\| technical \| alpha \| Claim from alpha \| 0\.90 \|/);
  assert.match(text, /\| technical \| beta \| Claim from beta \| 0\.40 \|/);
});

test("table cells escape pipes and newlines from model output", () => {
  assert.equal(cell("a | b\nc"), "a \\| b c");
  const text = synthesize("Q", [ok("technical", "a", "x | y\nz"), ok("technical", "b", "other")]);
  const row = text.split("\n").find((line) => line.includes("x \\| y z"));
  assert.ok(row, "escaped claim appears on a single table row");
});

test("synthesis file is numbered after the response files and reported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-orchestrator-"));
  const result = await runResearch("Name check", { providers: mockProviders(), outputRoot: root });
  assert.equal(result.synthesisFile, "07-synthesis.md");
  const files = await fs.readdir(result.outputDir);
  assert.ok(files.includes("07-synthesis.md"));
  assert.equal(files.filter((file) => file.startsWith("04-")).length, 1);
});

test("the offline demo shows both an agreement and a disagreement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-orchestrator-"));
  const { outputDir, synthesisFile } = await runResearch("Demo", { providers: mockProviders(), outputRoot: root });
  const text = await fs.readFile(path.join(outputDir, synthesisFile), "utf8");
  assert.match(text, /\| disagreement \(/);
  assert.match(text, /\| agreement \(/);
});
