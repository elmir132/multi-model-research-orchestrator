const openAiDefaults = {
  openai: ["https://api.openai.com/v1", "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-4o-mini"],
  groq: ["https://api.groq.com/openai/v1", "GROQ_API_KEY", "GROQ_MODEL", "llama-3.3-70b-versatile"],
  // Mistral's API is OpenAI-compatible. One key gives two providers (a medium and a small model)
  // so a single credential is enough to see the models compare against each other.
  mistral: ["https://api.mistral.ai/v1", "MISTRAL_API_KEY", "MISTRAL_MODEL", "mistral-medium-latest"],
  "mistral-small": ["https://api.mistral.ai/v1", "MISTRAL_API_KEY", "MISTRAL_SMALL_MODEL", "mistral-small-latest"]
};

const MOCK_CLAIMS = {
  optimistic: {
    "Technical analysis": ["The workflow is technically feasible because each provider can answer the same structured prompt.", "Add provider adapters and persist raw responses.", 0.78],
    "Practical analysis": ["The workflow is useful when a decision-maker needs several viewpoints before acting.", "Show the comparison with clear uncertainty labels.", 0.72],
    "Critical analysis": ["The main risk is mistaking model agreement for evidence or truth.", "Require primary-source verification before relying on a conclusion.", 0.91]
  },
  skeptical: {
    "Technical analysis": ["The workflow is not technically reliable because providers can answer the same structured prompt inconsistently.", "Validate outputs and log failures.", 0.55],
    "Practical analysis": ["The workflow is not useful unless decision-makers can see how uncertain each answer is.", "Test the comparison with real users first.", 0.6],
    "Critical analysis": ["The main risk is mistaking model agreement for evidence or truth, so verification is required.", "Require primary-source verification before relying on a conclusion.", 0.9]
  }
};

// Deterministic offline provider. `stance` only changes the canned wording so the demo
// shows both agreement and disagreement; it says nothing about any real model.
export class MockProvider {
  constructor(name = "mock", stance = "optimistic") { this.name = name; this.stance = stance; }
  async complete(prompt) {
    const topic = prompt.match(/Research question: (.+)/)?.[1] ?? "the question";
    const perspective = prompt.match(/Perspective: (.+)/)?.[1] ?? "general";
    const [claim, recommendation, confidence] = MOCK_CLAIMS[this.stance]?.[perspective]
      ?? [`The workflow can examine ${topic} from multiple angles.`, "Verify the response independently.", 0.5];
    return JSON.stringify({ claim, confidence, evidenceToVerify: ["provider outputs", "primary sources"], risks: ["model agreement can be misleading"], recommendation });
  }
}

export function mockProviders() {
  return [new MockProvider("mock-optimist", "optimistic"), new MockProvider("mock-skeptic", "skeptical")];
}

class ProviderError extends Error {}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(body) {
  if (typeof body?.error === "string") return body.error;
  return body?.error?.message ?? "request failed";
}

// Shared request loop: timeout, retry on rate limits, server errors and network failures.
// A subclass says how to build the request and how to read the answer.
export class HttpJsonProvider {
  constructor({ name, model, timeoutMs = 15000, retries = 2, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
    this.name = name;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  request() { throw new Error("request() is not implemented"); }
  parse() { throw new Error("parse() is not implemented"); }

  /** Returns { text, usage } where usage is { inputTokens, outputTokens } or null. */
  async completeWithUsage(prompt) {
    const { url, headers, body } = this.request(prompt);
    const payload = JSON.stringify(body);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.retries) { await this.sleep(100 * (attempt + 1)); continue; }
          throw new ProviderError(`${this.name} returned ${response.status}: ${errorText(data)}`);
        }
        const parsed = this.parse(data);
        if (!parsed?.text) throw new ProviderError(`${this.name} returned no text`);
        return { text: parsed.text, usage: parsed.usage ?? null };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (attempt < this.retries && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError")) { await this.sleep(100 * (attempt + 1)); continue; }
        throw new Error(`${this.name} request failed: ${error.message}`);
      }
    }
    throw new Error(`${this.name} request failed`);
  }

  async complete(prompt) {
    return (await this.completeWithUsage(prompt)).text;
  }
}

export class OpenAICompatibleProvider extends HttpJsonProvider {
  constructor({ baseUrl, apiKey, ...rest }) {
    super(rest);
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  request(prompt) {
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }
    };
  }

  parse(data) {
    return {
      text: data.choices?.[0]?.message?.content,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? null, outputTokens: data.usage.completion_tokens ?? null } : null
    };
  }
}

// Anthropic Messages API. No temperature is sent: some current models reject it.
export class AnthropicProvider extends HttpJsonProvider {
  constructor({ name = "anthropic", apiKey, baseUrl = "https://api.anthropic.com/v1", maxTokens = 1024, ...rest }) {
    super({ name, ...rest });
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.maxTokens = maxTokens;
  }

  request(prompt) {
    return {
      url: `${this.baseUrl}/messages`,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: { model: this.model, max_tokens: this.maxTokens, messages: [{ role: "user", content: prompt }] }
    };
  }

  parse(data) {
    const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    return { text, usage: data.usage ? { inputTokens: data.usage.input_tokens ?? null, outputTokens: data.usage.output_tokens ?? null } : null };
  }
}

// Google Gemini generateContent. The key goes in a header, never in the URL.
export class GeminiProvider extends HttpJsonProvider {
  constructor({ name = "gemini", apiKey, baseUrl = "https://generativelanguage.googleapis.com/v1beta", ...rest }) {
    super({ name, ...rest });
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  request(prompt) {
    return {
      url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }
    };
  }

  parse(data) {
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    const u = data.usageMetadata;
    return { text, usage: u ? { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null } : null };
  }
}

// A local Ollama server: no key, nothing leaves the machine. Local models are slow, so the
// timeout is generous.
export class OllamaProvider extends HttpJsonProvider {
  constructor({ name = "ollama", baseUrl = "http://localhost:11434", timeoutMs = 120000, ...rest }) {
    super({ name, timeoutMs, ...rest });
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  request(prompt) {
    return {
      url: `${this.baseUrl}/api/chat`,
      headers: { "content-type": "application/json" },
      body: { model: this.model, messages: [{ role: "user", content: prompt }], stream: false, options: { temperature: 0.2 } }
    };
  }

  parse(data) {
    return {
      text: data.message?.content,
      usage: data.prompt_eval_count !== undefined || data.eval_count !== undefined
        ? { inputTokens: data.prompt_eval_count ?? null, outputTokens: data.eval_count ?? null } : null
    };
  }
}

export function providersFromEnv(env = process.env) {
  const providers = Object.entries(openAiDefaults).flatMap(([name, [baseUrl, keyName, modelName, fallbackModel]]) => {
    const apiKey = env[keyName];
    return apiKey ? [new OpenAICompatibleProvider({ name, baseUrl, apiKey, model: env[modelName] || fallbackModel })] : [];
  });
  if (env.ANTHROPIC_API_KEY) providers.push(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001" }));
  if (env.GEMINI_API_KEY) providers.push(new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-flash-latest" }));
  // Ollama needs no key, so it is only enabled when a model is named explicitly.
  if (env.OLLAMA_MODEL) providers.push(new OllamaProvider({ model: env.OLLAMA_MODEL, baseUrl: env.OLLAMA_HOST || undefined }));
  return providers;
}
