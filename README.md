# Multi-Model Research Orchestrator

A small, provider-agnostic CLI for comparing independent AI perspectives on one research question and exposing where configured providers agree or disagree.

It turns an informal “ask several models” workflow into a reproducible artifact:

```text
question → every provider answers every perspective → comparison tables
                                                  → saved manifest + synthesis
```

The project was extracted from an earlier local multi-model research setup and rewritten for publication. It contains no credentials, no private MCP configuration, and no claim that model output is verified research.

## Why it exists

Single-model answers can hide assumptions. This tool deliberately separates three passes:

- **Technical:** feasibility, evidence quality, constraints, and failure modes.
- **Practical:** users, incentives, adoption barriers, and measurable outcomes.
- **Critical:** risks, affected stakeholders, and what would falsify the idea.

Each provider answers each perspective, so the same question is compared across models rather than merely rotating models between prompts. The synthesis parses each claim and confidence and compares providers pairwise with a transparent wording heuristic: word overlap, plus a check for negation so that "feasible" and "not feasible" are never reported as agreement. It does not pretend to fact-check the providers.

## Quick start: offline mode

Requires Node.js 20 or newer and no API key.

```bash
npm test
node bin/research.js "Should cities require landlords to disclose utility activation risks?" --mock
```

`--mock` runs two deterministic offline providers (`mock-optimist`, `mock-skeptic`) whose canned answers differ on purpose, so the synthesis shows both an agreement and a disagreement. They say nothing about any real model.

The command writes Markdown files and `manifest.json` under `research-output/`.

## Live providers

Credentials are read only from environment variables. Copy `.env.example` into your own shell configuration; never commit a `.env` file.

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4o-mini"
node bin/research.js "What makes a useful student housing data tool?"
```

The current implementation supports OpenAI-compatible endpoints for OpenAI, Groq and Mistral. A single `MISTRAL_API_KEY` configures two providers, `mistral` (`MISTRAL_MODEL`, default `mistral-medium-latest`) and `mistral-small` (`MISTRAL_SMALL_MODEL`, default `mistral-small-latest`), so one key is enough for a real comparison. Provider adapters are intentionally small so another endpoint can be added without changing the orchestration or output format.

## Output

For a question such as `Can this workflow be audited?` with two live providers configured:

```text
research-output/can-this-workflow-be-audited/
├── 01-openai-technical.md
├── 02-openai-practical.md
├── 03-openai-critical.md
├── 04-groq-technical.md
├── 05-groq-practical.md
├── 06-groq-critical.md
├── 07-synthesis.md      # numbered after the response files
└── manifest.json
```

With one provider the synthesis is `04-synthesis.md`. The comparison needs at least two providers.

## Design choices

- Sends every configured provider through every perspective.
- Uses a mock provider so the full workflow is testable offline.
- Saves provider names, statuses, parsed claims, and timestamps in a manifest for auditability.
- Escapes model output before placing it in Markdown tables.
- Retries transient rate-limit/server failures and aborts stalled requests with a timeout.
- Treats model output as an unverified draft and explicitly asks for evidence to verify.
- Keeps credentials outside the repository and does not write them to output files.

## Limitations

This is a research workflow prototype, not an autonomous fact-checker. The agreement check is a heuristic: it misses antonyms and paraphrases, and it can flag an unrelated negation elsewhere in a claim. The OpenAI, Groq and Mistral adapters are tested against a mocked `fetch`, not against the live APIs (a first live Mistral attempt was rejected with HTTP 429 because the key had no request quota, so the Mistral path is unverified live). It does not browse sources, judge citation quality, guarantee factual agreement, or replace domain expertise. Live model availability, pricing, and output quality depend on the configured provider.

## Tests

```bash
npm test
```

The 20 tests cover safe slugs, structured prompts, offline execution, provider coverage, negation and agreement detection, the claims table, table escaping, output file naming, environment configuration, authenticated requests, HTTP errors, empty responses, timeouts, and retries.

## AI assistance

This repository was developed with AI assistance (Claude Code). The workflow, provider boundary, output schema, limitations, and tests were specified and reviewed by the author.

## License

MIT.
