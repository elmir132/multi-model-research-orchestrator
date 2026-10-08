#!/usr/bin/env node
import { runResearch } from "../src/core.js";
import { mockProviders, providersFromEnv } from "../src/providers.js";

const args = process.argv.slice(2);
const mock = args.includes("--mock");
const topic = args.filter((arg) => arg !== "--mock").join(" ").trim();

if (!topic) {
  console.error('Usage: research-orchestrator "your research question" [--mock]');
  process.exit(2);
}

const providers = mock ? mockProviders() : providersFromEnv();
if (!providers.length) {
  console.error("No provider credentials found. Use --mock or configure OPENAI_API_KEY, GROQ_API_KEY or MISTRAL_API_KEY.");
  process.exit(2);
}

try {
  const result = await runResearch(topic, { providers });
  console.log(`Research written to ${result.outputDir}`);
} catch (error) {
  console.error(`Research failed: ${error.message}`);
  process.exit(1);
}
