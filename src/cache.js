import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * A small on-disk cache of successful model answers, so a rerun (or a run that was
 * interrupted) does not pay for the same call twice. Keys hash the provider, its model and
 * the full prompt, so changing any of them is a miss. Only successful answers are stored.
 * The files hold model output and, when sources are used, can echo their text: keep the
 * directory out of version control (it is in .gitignore by default).
 */
export function cacheKey(provider, prompt) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ provider: provider.name, model: provider.model ?? null, prompt }))
    .digest("hex");
}

export function createCache(dir) {
  return {
    dir,
    async get(key) {
      try {
        const value = JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), "utf8"));
        return typeof value?.text === "string" ? value : null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
    }
  };
}
