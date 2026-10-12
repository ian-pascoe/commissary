#!/usr/bin/env node
/**
 * Regenerates the bundled OpenCode catalog snapshot (`src/registry/catalog/opencode_models.json`): the `opencode` (Zen)
 * and `opencode-go` providers of the models.dev catalog, trimmed to the fields the proxy reads.
 *
 * Usage: `pnpm catalog:opencode [source]`, where `source` is an http(s) URL or a local file (for instance OpenCode's
 * own cache, `~/.cache/opencode/models.json`). Defaults to the URL OpenCode itself reads. Run by Node directly (type
 * stripping), so it only imports the dependency-free trim module.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { trimOpenCodeCatalog } from "../src/registry/opencode-catalog-trim.ts";

const DEFAULT_SOURCE = "https://models.opencode.ai/api.json";

const OUTPUT = fileURLToPath(
  new URL("../src/registry/catalog/opencode_models.json", import.meta.url),
);

const source = process.argv[2] ?? DEFAULT_SOURCE;

const load = async (from: string): Promise<string> => {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from, { headers: { accept: "application/json" } });

    if (!response.ok) throw new Error(`${from} answered HTTP ${response.status}`);

    return response.text();
  }

  return readFile(from, "utf8");
};

const trimmed = trimOpenCodeCatalog(await load(source));

if (!trimmed.ok) {
  process.stderr.write(`catalog rejected: ${trimmed.error}\n`);
  process.exit(1);
}

await writeFile(OUTPUT, `${JSON.stringify(trimmed.value, null, 2)}\n`);

const counts = Object.values(trimmed.value).map(
  (provider) => `${provider.id}: ${Object.keys(provider.models).length} models`,
);

process.stdout.write(`wrote ${OUTPUT} (${counts.join(", ")}) from ${source}\n`);
