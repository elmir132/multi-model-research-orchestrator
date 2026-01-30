// Measures how often the wording heuristic in src/core.js matches hand-labelled claim pairs.
// Usage: node scripts/eval-agreement.js            (prints a report and writes eval/results.json)
import fs from "node:fs/promises";
import { compareResponses } from "../src/core.js";

const input = JSON.parse(await fs.readFile(new URL("../eval/claim_pairs.json", import.meta.url), "utf8"));

const ok = (provider, claim) => ({ perspective: "eval", provider, status: "ok", analysis: { claim, confidence: null } });
const results = input.pairs.map((pair) => {
  const [comparison] = compareResponses([ok("a", pair.a), ok("b", pair.b)])[0].comparisons;
  const predicted = comparison.verdict === "disagreement" ? "disagree" : "agree";
  return { ...pair, predicted, reason: comparison.reason, score: comparison.score, correct: predicted === pair.label };
});

// "disagree" is the positive class: the useful signal is catching real disagreement.
const count = (predicate) => results.filter(predicate).length;
const tp = count((r) => r.label === "disagree" && r.predicted === "disagree");
const fp = count((r) => r.label === "agree" && r.predicted === "disagree");
const fn = count((r) => r.label === "disagree" && r.predicted === "agree");
const tn = count((r) => r.label === "agree" && r.predicted === "agree");
const ratio = (a, b) => (b === 0 ? null : Number((a / b).toFixed(3)));
const precision = ratio(tp, tp + fp);
const recall = ratio(tp, tp + fn);

const byKind = {};
for (const r of results) {
  byKind[r.kind] ??= { pairs: 0, correct: 0 };
  byKind[r.kind].pairs += 1;
  byKind[r.kind].correct += r.correct ? 1 : 0;
}

const summary = {
  note: input.description,
  pairs: results.length,
  accuracy: ratio(count((r) => r.correct), results.length),
  disagreement: { precision, recall },
  confusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
  byKind,
  misses: results.filter((r) => !r.correct).map(({ id, kind, label, predicted, reason, score, a, b }) => ({ id, kind, label, predicted, reason, score, a, b }))
};

await fs.writeFile(new URL("../eval/results.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`pairs: ${summary.pairs}   accuracy: ${summary.accuracy}`);
console.log(`disagreement precision: ${precision}   recall: ${recall}`);
console.log(`confusion (disagree = positive): TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`);
for (const [kind, v] of Object.entries(byKind)) console.log(`  ${kind.padEnd(24)} ${v.correct}/${v.pairs}`);
console.log(`misses: ${summary.misses.length} (see eval/results.json)`);
