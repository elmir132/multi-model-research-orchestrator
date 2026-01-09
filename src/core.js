import fs from "node:fs/promises";
import path from "node:path";

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

export function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "research";
}

export function buildPrompt(topic, perspective) {
  return [
    `Research question: ${topic}`,
    `Perspective: ${perspective.label}`,
    perspective.instruction,
    "Return ONLY valid JSON with this shape: {\"claim\":\"...\",\"confidence\":0.0,\"evidenceToVerify\":[\"...\"],\"risks\":[\"...\"],\"recommendation\":\"...\"}.",
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
      recommendation: value.recommendation
    };
  } catch {
    return { claim: text.trim(), confidence: null, evidenceToVerify: [], risks: [], recommendation: "Review the unstructured response manually." };
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
    "## Limitations",
    "Agreement is a wording heuristic: word overlap plus a check for negation. It misses antonyms and paraphrases and can flag an unrelated negation. It is not a truth score. This synthesis is not a fact checker; verify claims against primary sources and record citations separately.",
    "",
    `Successful responses: ${successful.length}/${responses.length}.`
  ].join("\n");
}

export async function runResearch(topic, { providers, outputRoot = "research-output" } = {}) {
  if (!topic?.trim()) throw new Error("A research question is required");
  if (!providers?.length) throw new Error("At least one provider is required");

  const outputDir = path.join(outputRoot, slugify(topic));
  await fs.mkdir(outputDir, { recursive: true });
  const responses = [];

  for (const provider of providers) {
    for (const perspective of PERSPECTIVES) {
      const result = { perspective: perspective.id, provider: provider.name };
      try {
        const text = await provider.complete(buildPrompt(topic, perspective));
        result.status = "ok";
        result.text = text;
        result.analysis = parseAnalysis(text);
      } catch (error) {
        result.status = "error";
        result.error = error.message;
      }
      responses.push(result);
      const suffix = result.status === "ok" ? result.text : `Provider error: ${result.error}`;
      await fs.writeFile(path.join(outputDir, `${String(responses.length).padStart(2, "0")}-${provider.name}-${perspective.id}.md`), `# ${perspective.label}\n\n**Provider:** ${provider.name}\n**Status:** ${result.status}\n\n${suffix}\n`);
    }
  }

  const synthesisFile = `${String(responses.length + 1).padStart(2, "0")}-synthesis.md`;
  await fs.writeFile(path.join(outputDir, synthesisFile), `${synthesize(topic, responses)}\n`);
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ topic, generatedAt: new Date().toISOString(), responses }, null, 2) + "\n");
  return { outputDir, responses, synthesisFile };
}
