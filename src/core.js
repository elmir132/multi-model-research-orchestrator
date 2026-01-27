import fs from "node:fs/promises";
import path from "node:path";
import { cacheKey } from "./cache.js";
import { renderReport } from "./report.js";
import { sourcesBlock, verifyQuotes } from "./sources.js";

export const PERSPECTIVES = [
  {
    id: "technical",
    label: "Technical analysis",
    instruction: "Evaluate feasibility, evidence quality, implementation constraints, and failure modes."
  },
  {
    id: "practical",
    label: "Practical analysis",
    instruction: "Evaluate users, incentives, adoption barriers, operational reality, and measurable outcomes."
  },
  {
    id: "critical",
    label: "Critical analysis",
    instruction: "Challenge assumptions, identify risks, affected stakeholders, and what would falsify the idea."
  }
];

/** Checks a custom list of perspectives (from a JSON file) and returns clean copies. */
export function validatePerspectives(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("Perspectives must be a non-empty array");
  if (list.length > 6) throw new Error("Use at most 6 perspectives");
  const seen = new Set();
  return list.map((item, index) => {
    const where = `perspective ${index + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${where} must be an object`);
    const { id, label, instruction } = item;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,30}$/.test(id)) throw new Error(`${where}: id must be 1-30 characters from a-z, 0-9 and "-"`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
    seen.add(id);
    if (typeof label !== "string" || !label.trim() || label.length > 60) throw new Error(`${where}: label must be 1-60 characters`);
    if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 400) throw new Error(`${where}: instruction must be 1-400 characters`);
    return { id, label: label.trim(), instruction: instruction.trim() };
  });
}

export function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "research";
}

export function buildPrompt(topic, perspective, sources = []) {
  const quoteShape = sources.length ? ",\"quotes\":[{\"source\":\"file name\",\"quote\":\"text copied exactly from that source\"}]" : "";
  return [
    `Research question: ${topic}`,
    `Perspective: ${perspective.label}`,
    perspective.instruction,
    ...(sources.length ? [sourcesBlock(sources)] : []),
    `Return ONLY valid JSON with this shape: {"claim":"...","confidence":0.0,"evidenceToVerify":["..."],"risks":["..."],"recommendation":"..."${quoteShape}}.`,
    "confidence must be a number from 0 to 1. Separate known facts from assumptions. Do not invent citations or claim that mock data is real."
  ].join("\n\n");
}

export function parseAnalysis(text) {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? text;
  try {
    const value = JSON.parse(candidate);
    if (typeof value.claim !== "string" || typeof value.recommendation !== "string") throw new Error("missing claim or recommendation");
    return {
      claim: value.claim,
      confidence: Number.isFinite(value.confidence) ? Math.min(1, Math.max(0, value.confidence)) : null,
      evidenceToVerify: Array.isArray(value.evidenceToVerify) ? value.evidenceToVerify.map(String) : [],
      risks: Array.isArray(value.risks) ? value.risks.map(String) : [],
      recommendation: value.recommendation,
      quotes: Array.isArray(value.quotes)
        ? value.quotes.filter((item) => item && typeof item.source === "string" && typeof item.quote === "string").map((item) => ({ source: item.source, quote: item.quote }))
        : []
    };
  } catch {
    return { claim: text.trim(), confidence: null, evidenceToVerify: [], risks: [], recommendation: "Review the unstructured response manually.", quotes: [] };
  }
}

const STOP_WORDS = new Set("a an and are as at be by for from in is it of on or that the their this to was with".split(" "));
// Negations are kept even though they are short: dropping them made "feasible" and
// "not feasible" look identical.
const NEGATIONS = new Set(["not", "no", "never", "cannot", "without", "neither", "nor", "unlikely"]);

function words(text) {
  return text.toLowerCase().replace(/n['\u2019]t\b/g, " not").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}

function tokens(text) {
  return new Set(words(text).filter((word) => NEGATIONS.has(word) || (word.length > 3 && !STOP_WORDS.has(word))));
}

export function hasNegation(text) {
  return words(text).some((word) => NEGATIONS.has(word));
}

export function claimSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  return [...a].filter((word) => b.has(word)).length / union.size;
}

export function compareResponses(responses) {
  const byPerspective = new Map();
  for (const response of responses.filter((item) => item.status === "ok")) {
    if (!byPerspective.has(response.perspective)) byPerspective.set(response.perspective, []);
    byPerspective.get(response.perspective).push(response);
  }
  return [...byPerspective.entries()].map(([perspective, items]) => {
    if (items.length < 2) return { perspective, status: "needs at least two providers", comparisons: [] };
    const comparisons = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const leftClaim = items[i].analysis.claim;
        const rightClaim = items[j].analysis.claim;
        const score = claimSimilarity(leftClaim, rightClaim);
        const oppositePolarity = hasNegation(leftClaim) !== hasNegation(rightClaim);
        const disagree = oppositePolarity || score < 0.25;
        comparisons.push({
          left: items[i].provider,
          right: items[j].provider,
          score: Number(score.toFixed(2)),
          verdict: disagree ? "disagreement" : "agreement",
          reason: oppositePolarity ? "one claim is negated, the other is not" : disagree ? "low wording overlap" : "similar wording"
        });
      }
    }
    return { perspective, status: "compared", comparisons };
  });
}

// Model output is untrusted text: a pipe or newline would break the table.
export function cell(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function markdownTable(rows, headers) {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ].join("\n");
}

export function synthesize(topic, responses) {
  const comparisons = compareResponses(responses);
  const successful = responses.filter((item) => item.status === "ok");
  const providerRows = [...new Set(responses.map((item) => item.provider))].map((provider) => [provider, [...new Set(responses.filter((item) => item.provider === provider).map((item) => item.perspective))].join(", ")]);
  const comparisonRows = comparisons.flatMap((item) => item.comparisons.length
    ? item.comparisons.map((pair) => [item.perspective, pair.left, pair.right, `${pair.verdict} (${pair.reason})`, String(pair.score)])
    : [[item.perspective, "—", "—", item.status, "—"]]);
  const claimRows = successful.map((item) => [item.perspective, item.provider, item.analysis.claim, item.analysis.confidence === null ? "—" : item.analysis.confidence.toFixed(2)]);
  const verified = successful.filter((item) => item.analysis.verification);
  const verificationSection = verified.length ? [
    "## Quote verification",
    markdownTable(verified.map((item) => {
      const v = item.analysis.verification;
      return [item.perspective, item.provider, `${v.verified}/${v.checked}`, v.failed.map((f) => `${f.reason}: "${f.quote.slice(0, 80)}"`).join("; ") || "—"];
    }), ["Perspective", "Provider", "Quotes verified", "Not verified"]),
    "",
    "A verified quote shows that the text exists in the named source file. It does not show that the model understood it correctly.",
    ""
  ] : [];
  return [
    `# Synthesis: ${topic}`,
    "",
    "## Provider coverage",
    markdownTable(providerRows, ["Provider", "Perspectives answered"]),
    "",
    "## Agreement and disagreement",
    markdownTable(comparisonRows, ["Perspective", "Provider A", "Provider B", "Result", "Similarity"]),
    "",
    "## Claims by perspective",
    markdownTable(claimRows, ["Perspective", "Provider", "Claim", "Confidence"]),
    "",
    ...verificationSection,
    "## Limitations",
    "Agreement is a wording heuristic: word overlap plus a check for negation. It misses antonyms and paraphrases and can flag an unrelated negation. It is not a truth score. This synthesis is not a fact checker; verify claims against primary sources and record citations separately.",
    "",
    `Successful responses: ${successful.length}/${responses.length}.`
  ].join("\n");
}

// Runs `worker(item, index)` over the items with at most `limit` in flight at once.
export async function runPool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

/**
 * Asks every provider every perspective and writes the answers, a synthesis, a manifest and
 * (by default) an HTML report.
 *
 * Options: providers, outputRoot, perspectives (default: the three built in), concurrency
 * (default 3), maxCalls (refuse to start if the run would make more calls), cache (an object
 * from createCache), sources (documents from loadSources; quotes are then verified),
 * report (default true).
 */
export async function runResearch(topic, { providers, outputRoot = "research-output", perspectives = PERSPECTIVES, concurrency = 3, maxCalls = null, cache = null, sources = [], report = true } = {}) {
  if (!topic?.trim()) throw new Error("A research question is required");
  if (!providers?.length) throw new Error("At least one provider is required");
  if (!perspectives?.length) throw new Error("At least one perspective is required");

  const jobs = providers.flatMap((provider) => perspectives.map((perspective) => ({ provider, perspective })));
  if (maxCalls !== null && jobs.length > maxCalls) {
    throw new Error(`This run would make ${jobs.length} model calls (${providers.length} providers x ${perspectives.length} perspectives), above the limit of ${maxCalls}`);
  }

  const outputDir = path.join(outputRoot, slugify(topic));
  await fs.mkdir(outputDir, { recursive: true });
  const responses = new Array(jobs.length);

  await runPool(jobs, concurrency, async ({ provider, perspective }, index) => {
    const result = { perspective: perspective.id, provider: provider.name };
    const prompt = buildPrompt(topic, perspective, sources);
    const started = performance.now();
    try {
      const key = cache ? cacheKey(provider, prompt) : null;
      const hit = cache ? await cache.get(key) : null;
      let answer;
      if (hit) {
        answer = hit;
        result.cached = true;
      } else {
        answer = provider.completeWithUsage ? await provider.completeWithUsage(prompt) : { text: await provider.complete(prompt), usage: null };
        if (cache) await cache.set(key, { text: answer.text, usage: answer.usage ?? null });
        result.cached = false;
      }
      result.status = "ok";
      result.text = answer.text;
      result.usage = answer.usage ?? null;
      result.analysis = parseAnalysis(answer.text);
      if (sources.length) result.analysis.verification = verifyQuotes(result.analysis.quotes, sources);
    } catch (error) {
      result.status = "error";
      result.error = error.message;
    }
    result.latencyMs = Math.round(performance.now() - started);
    responses[index] = result;
    const suffix = result.status === "ok" ? result.text : `Provider error: ${result.error}`;
    await fs.writeFile(path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${provider.name}-${perspective.id}.md`), `# ${perspective.label}\n\n**Provider:** ${provider.name}\n**Status:** ${result.status}\n\n${suffix}\n`);
  });

  const generatedAt = new Date().toISOString();
  const synthesisFile = `${String(responses.length + 1).padStart(2, "0")}-synthesis.md`;
  await fs.writeFile(path.join(outputDir, synthesisFile), `${synthesize(topic, responses)}\n`);
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({
    topic,
    generatedAt,
    settings: { concurrency, maxCalls, perspectives: perspectives.map((item) => item.id), sources: sources.map((item) => ({ name: item.name, characters: item.text.length })) },
    responses
  }, null, 2) + "\n");
  let reportFile = null;
  if (report) {
    reportFile = "report.html";
    await fs.writeFile(path.join(outputDir, reportFile), renderReport({ topic, generatedAt, responses, perspectives, comparisons: compareResponses(responses) }));
  }
  return { outputDir, responses, synthesisFile, reportFile };
}
