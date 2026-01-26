// Everything that came from a model or a file is untrusted: escape it before it goes
// into HTML. The report contains no script and loads nothing from the network.
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const list = (items) => (items?.length ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "<p class=\"muted\">none given</p>");

function sum(values) {
  const known = values.filter((value) => Number.isFinite(value));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export function renderReport({ topic, generatedAt, responses, perspectives, comparisons }) {
  const ok = responses.filter((item) => item.status === "ok");
  const providers = [...new Set(responses.map((item) => item.provider))];
  const tokens = sum(responses.map((item) => (item.usage ? (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0) : NaN)));
  const latency = sum(responses.map((item) => item.latencyMs));

  const stats = [
    ["Providers", providers.length],
    ["Perspectives", perspectives.length],
    ["Answers", `${ok.length}/${responses.length}`],
    ["Tokens", tokens === null ? "n/a" : tokens.toLocaleString("en-US")],
    ["Model time", latency === null ? "n/a" : `${(latency / 1000).toFixed(1)} s`]
  ].map(([label, value]) => `<div class="stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`).join("");

  const sections = perspectives.map((perspective) => {
    const compared = comparisons.find((item) => item.perspective === perspective.id);
    const pairs = compared?.comparisons?.length
      ? `<table><thead><tr><th>Provider A</th><th>Provider B</th><th>Result</th><th>Similarity</th></tr></thead><tbody>${compared.comparisons.map((pair) =>
        `<tr><td>${esc(pair.left)}</td><td>${esc(pair.right)}</td><td class="${pair.verdict}">${esc(pair.verdict)} <span class="muted">(${esc(pair.reason)})</span></td><td>${esc(pair.score)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">${esc(compared?.status ?? "no successful answers")}</p>`;
    const cards = responses.filter((item) => item.perspective === perspective.id).map((item) => {
      if (item.status !== "ok") return `<article class="card err"><h4>${esc(item.provider)}</h4><p>Provider error: ${esc(item.error)}</p></article>`;
      const a = item.analysis;
      const conf = a.confidence === null ? "" : `<div class="bar" title="confidence ${a.confidence.toFixed(2)}"><span style="width:${Math.round(a.confidence * 100)}%"></span></div><div class="muted">confidence ${a.confidence.toFixed(2)}</div>`;
      const v = a.verification;
      const verification = v ? `<p class="${v.failed.length ? "bad" : "good"}">Quotes verified: ${v.verified}/${v.checked}</p>${v.failed.length ? `<ul class="bad">${v.failed.map((f) => `<li>${esc(f.reason)}: "${esc(f.quote.slice(0, 120))}" (${esc(f.source)})</li>`).join("")}</ul>` : ""}` : "";
      const meta = [item.cached ? "cached" : null, Number.isFinite(item.latencyMs) ? `${item.latencyMs} ms` : null, item.usage ? `${(item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0)} tokens` : null].filter(Boolean).join(" · ");
      return `<article class="card"><h4>${esc(item.provider)} <span class="muted">${esc(meta)}</span></h4><p class="claim">${esc(a.claim)}</p>${conf}<h5>Recommendation</h5><p>${esc(a.recommendation)}</p><h5>Risks</h5>${list(a.risks)}<h5>Evidence to verify</h5>${list(a.evidenceToVerify)}${verification}</article>`;
    }).join("");
    return `<section><h2>${esc(perspective.label)}</h2><h3>Agreement</h3>${pairs}<div class="cards">${cards}</div></section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(topic)} - research report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;--good:#1a7f37;--bad:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--card:#161b22;--good:#3fb950;--bad:#f85149;--accent:#58a6ff}}
body{font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:14px;margin:12px 0 6px;color:var(--muted)}h4{margin:0 0 6px}h5{margin:10px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.muted{color:var(--muted);font-size:13px}.stats{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.stat{border:1px solid var(--line);border-radius:8px;padding:10px 16px;background:var(--card)}.n{font-size:20px;font-weight:600}.l{font-size:12px;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}th{background:var(--card)}td.agreement{color:var(--good);font-weight:600}td.disagreement{color:var(--bad);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px}.card{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--card)}.card.err{border-color:var(--bad)}.claim{font-weight:600}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent)}ul{margin:2px 0 0;padding-left:20px}.good{color:var(--good)}.bad{color:var(--bad)}
footer{margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body>
<h1>${esc(topic)}</h1>
<div class="muted">Generated ${esc(generatedAt)}. Providers: ${esc(providers.join(", "))}</div>
<div class="stats">${stats}</div>
${sections}
<footer class="muted">Agreement is a wording heuristic (word overlap plus a negation check). It misses paraphrases and antonyms and is not a truth score. Model answers are unverified drafts; check claims against primary sources.</footer>
</body></html>
`;
}
