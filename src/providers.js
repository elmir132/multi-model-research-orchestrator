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

export class OpenAICompatibleProvider {
  constructor({ name, baseUrl, apiKey, model, timeoutMs = 15000, retries = 2, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async complete(prompt) {
    const payload = JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }], temperature: 0.2 });
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.retries) { await this.sleep(100 * (attempt + 1)); continue; }
          throw new ProviderError(`${this.name} returned ${response.status}: ${body.error?.message ?? "request failed"}`);
        }
        const text = body.choices?.[0]?.message?.content;
        if (!text) throw new ProviderError(`${this.name} returned no text`);
        return text;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (attempt < this.retries && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError")) { await this.sleep(100 * (attempt + 1)); continue; }
        throw new Error(`${this.name} request failed: ${error.message}`);
      }
    }
    throw new Error(`${this.name} request failed`);
  }
}

export function providersFromEnv(env = process.env) {
  return Object.entries(openAiDefaults).flatMap(([name, [baseUrl, keyName, modelName, fallbackModel]]) => {
    const apiKey = env[keyName];
    return apiKey ? [new OpenAICompatibleProvider({ name, baseUrl, apiKey, model: env[modelName] || fallbackModel })] : [];
  });
}
