import fs from "node:fs/promises";
import path from "node:path";

export const MAX_SOURCE_FILES = 20;
export const MAX_SOURCE_CHARS = 60000;

/** Reads the .md and .txt files of one folder (not recursive). */
export async function loadSources(dir) {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!entries.length) throw new Error(`No .md or .txt files found in ${dir}`);
  if (entries.length > MAX_SOURCE_FILES) throw new Error(`Too many source files (${entries.length}); the limit is ${MAX_SOURCE_FILES}`);
  const sources = [];
  let total = 0;
  for (const name of entries) {
    const text = await fs.readFile(path.join(dir, name), "utf8");
    total += text.length;
    sources.push({ name, text });
  }
  if (total > MAX_SOURCE_CHARS) throw new Error(`Sources are ${total} characters; the limit is ${MAX_SOURCE_CHARS}. Use fewer or shorter files.`);
  return sources;
}

export function sourcesBlock(sources) {
  return [
    "Source documents. Base your answer on them and, for every important statement, copy a short quote exactly as written (same characters) from one of them:",
    ...sources.map((source) => `[document: ${source.name}]\n${source.text}\n[end document]`)
  ].join("\n\n");
}

const squash = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Checks that every quote a model gave really occurs in the source it named. Whitespace is
 * ignored, everything else must match exactly. This proves the text exists in that file; it
 * does not prove the model read it correctly.
 */
export function verifyQuotes(quotes, sources) {
  const byName = new Map(sources.map((source) => [source.name, squash(source.text)]));
  const failed = [];
  let verified = 0;
  for (const { source, quote } of quotes) {
    const haystack = byName.get(source);
    const needle = squash(quote);
    if (haystack === undefined) failed.push({ source, quote, reason: "unknown source" });
    else if (!needle || !haystack.includes(needle)) failed.push({ source, quote, reason: "quote not found in source" });
    else verified += 1;
  }
  return { checked: quotes.length, verified, failed };
}
