import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createCache } from "./cache.js";
import { PERSPECTIVES, runResearch, validatePerspectives } from "./core.js";
import { mockProviders, providersFromEnv } from "./providers.js";
import { loadSources } from "./sources.js";

export const HELP = `research-orchestrator: ask several AI models the same question and see where they agree.

USAGE
  research-orchestrator "your research question" [options]

OPTIONS
  --mock                    use two offline mock providers (no API key, no network)
  --providers a,b           only use these providers (names as printed when none match)
  --perspectives a,b        only use these built-in perspectives: ${PERSPECTIVES.map((p) => p.id).join(", ")}
  --perspectives-file FILE  custom perspectives: a JSON array of {id, label, instruction} (max 6)
  --sources DIR             give the models the .md/.txt files in DIR and verify their quotes
  --out DIR                 where to write results (default: research-output)
  --concurrency N           calls in flight at once, 1-10 (default 3)
  --max-calls N             refuse to start if the run would make more than N model calls
  --cache                   reuse earlier answers from ./.research-cache (also resumes an interrupted run)
  --cache-dir DIR           cache somewhere else (implies --cache)
  --no-report               do not write report.html
  -h, --help                show this help
  -v, --version             show the version

PROVIDERS (from environment variables)
  OPENAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY (adds two models), ANTHROPIC_API_KEY,
  GEMINI_API_KEY, and OLLAMA_MODEL for a local Ollama server (OLLAMA_HOST optional).
  Model names can be overridden with OPENAI_MODEL, GROQ_MODEL, MISTRAL_MODEL,
  MISTRAL_SMALL_MODEL, ANTHROPIC_MODEL and GEMINI_MODEL.

Exit status: 0 success, 1 the run failed, 2 usage error.
`;

class UsageError extends Error {}

function integer(value, name, { min, max }) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  return Number(value);
}

export async function readVersion() {
  const file = new URL("../package.json", import.meta.url);
  return JSON.parse(await fs.readFile(file, "utf8")).version;
}

/** Turns command-line arguments into a plan, or throws UsageError. Does no network or disk writing. */
export async function planFromArgs(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mock: { type: "boolean" },
        providers: { type: "string" },
        perspectives: { type: "string" },
        "perspectives-file": { type: "string" },
        sources: { type: "string" },
        out: { type: "string" },
        concurrency: { type: "string" },
        "max-calls": { type: "string" },
        cache: { type: "boolean" },
        "cache-dir": { type: "string" },
        "no-report": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      }
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { action: values.help ? "help" : "version" };

  const topic = positionals.join(" ").trim();
  if (!topic) throw new UsageError("A research question is required");

  let providers = values.mock ? mockProviders() : providersFromEnv(env);
  if (!providers.length) throw new UsageError("No providers configured. Use --mock, or set OPENAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or OLLAMA_MODEL.");
  if (values.providers) {
    const wanted = values.providers.split(",").map((name) => name.trim()).filter(Boolean);
    const available = providers.map((provider) => provider.name);
    const unknown = wanted.filter((name) => !available.includes(name));
    if (unknown.length) throw new UsageError(`Unknown provider ${unknown.join(", ")}. Available: ${available.join(", ")}`);
    providers = providers.filter((provider) => wanted.includes(provider.name));
  }

  if (values.perspectives && values["perspectives-file"]) throw new UsageError("Use either --perspectives or --perspectives-file, not both");
  let perspectives = PERSPECTIVES;
  if (values.perspectives) {
    const wanted = values.perspectives.split(",").map((id) => id.trim()).filter(Boolean);
    const unknown = wanted.filter((id) => !PERSPECTIVES.some((p) => p.id === id));
    if (unknown.length) throw new UsageError(`Unknown perspective ${unknown.join(", ")}. Built in: ${PERSPECTIVES.map((p) => p.id).join(", ")}`);
    perspectives = PERSPECTIVES.filter((p) => wanted.includes(p.id));
  }
  if (values["perspectives-file"]) {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(values["perspectives-file"], "utf8"));
    } catch (error) {
      throw new UsageError(`Could not read perspectives file: ${error.message}`);
    }
    try {
      perspectives = validatePerspectives(raw);
    } catch (error) {
      throw new UsageError(error.message);
    }
  }

  let sources = [];
  if (values.sources) {
    try {
      sources = await loadSources(values.sources);
    } catch (error) {
      throw new UsageError(error.message);
    }
  }

  const outputRoot = values.out ?? "research-output";
  const cacheDir = values["cache-dir"] ?? (values.cache ? ".research-cache" : null);
  return {
    action: "run",
    topic,
    providers,
    perspectives,
    sources,
    outputRoot,
    concurrency: values.concurrency ? integer(values.concurrency, "--concurrency", { min: 1, max: 10 }) : 3,
    maxCalls: values["max-calls"] ? integer(values["max-calls"], "--max-calls", { min: 1, max: 100000 }) : null,
    cache: cacheDir ? createCache(path.resolve(cacheDir)) : null,
    report: !values["no-report"]
  };
}

/** Runs the CLI with injected I/O so it can be tested. Returns the exit status. */
export async function runCli(argv, { env = process.env, stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text) } = {}) {
  let plan;
  try {
    plan = await planFromArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr(`research-orchestrator: ${error.message}\nTry --help.\n`);
    return 2;
  }
  if (plan.action === "help") { stdout(HELP); return 0; }
  if (plan.action === "version") { stdout(`${await readVersion()}\n`); return 0; }

  try {
    const { action, topic, ...options } = plan;
    const result = await runResearch(topic, options);
    const failed = result.responses.filter((item) => item.status !== "ok").length;
    const cached = result.responses.filter((item) => item.cached).length;
    stdout(`Research written to ${result.outputDir}\n`);
    if (result.reportFile) stdout(`Report: ${path.join(result.outputDir, result.reportFile)}\n`);
    if (cached) stdout(`${cached} answer(s) came from the cache.\n`);
    if (failed) stderr(`${failed} of ${result.responses.length} calls failed; see the response files.\n`);
    return 0;
  } catch (error) {
    stderr(`Research failed: ${error.message}\n`);
    return 1;
  }
}
