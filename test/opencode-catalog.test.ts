// OpenCode Zen/Go catalog: trimming of the models.dev document, the cron refresh into KV, the per-isolate KV copy with
// the bundled fallback, and the models registered without a config `models` list.
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  currentOpenCodeCatalog,
  defaultCatalogModels,
  embeddedOpenCodeCatalog,
  OPENCODE_CATALOG_KV_KEY,
  OPENCODE_CATALOG_URL,
  openCodeCatalogFromText,
  resetOpenCodeCatalogCache,
} from "../src/registry/opencode-catalog.ts";
import { trimOpenCodeCatalog } from "../src/registry/opencode-catalog-trim.ts";
import { CatalogStore } from "../src/registry/catalog-store.ts";
import {
  MAX_OPENCODE_CATALOG_BYTES,
  refreshOpenCodeCatalog,
} from "../src/registry/opencode-refresh.ts";
import { scheduledTasks } from "../src/scheduled.ts";
import { FakeKv, fakeHttp, refreshLayer, workerEnv } from "./support/registry-refresh.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  release_date: "2026-01-01",
  knowledge: "2025-06",
  open_weights: false,
  temperature: true,
  reasoning: true,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 1, output: 2, cache_read: 0.1 },
  modalities: { input: ["text", "image"], output: ["text"] },
  ...extra,
});

/** A models.dev document: the two gateways plus an unrelated provider. */
const documentText = (zenModels: Record<string, unknown> = {}) =>
  JSON.stringify({
    openai: { id: "openai", npm: "@ai-sdk/openai", models: { "gpt-x": model("gpt-x") } },
    opencode: {
      id: "opencode",
      name: "OpenCode Zen",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/v1",
      env: ["OPENCODE_API_KEY"],
      doc: "https://opencode.ai/docs/zen",
      models: {
        "gpt-9": model("gpt-9", { provider: { npm: "@ai-sdk/openai" } }),
        "claude-z": model("claude-z", { provider: { npm: "@ai-sdk/anthropic" } }),
        "old-model": model("old-model", { status: "deprecated" }),
        "free-model": model("free-model", { cost: { input: 0, output: 0 } }),
        broken: { id: 42 },
        ...zenModels,
      },
    },
    "opencode-go": {
      id: "opencode-go",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "kimi-q": model("kimi-q"),
        "go-free": model("go-free", { cost: { input: 0, output: 0 } }),
      },
    },
  });

describe("catalog trimming", () => {
  it("keeps only the two gateways and the fields the proxy reads; trimming is idempotent", () => {
    const trimmed = trimOpenCodeCatalog(documentText());
    expect(trimmed.ok).toBe(true);

    if (!trimmed.ok) return;
    expect(Object.keys(trimmed.value).toSorted()).toEqual(["opencode", "opencode-go"]);
    const zen = trimmed.value.opencode;
    expect(zen).toMatchObject({
      id: "opencode",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/v1",
    });
    expect(zen).not.toHaveProperty("env");
    expect(Object.keys(zen.models).toSorted()).toEqual([
      "claude-z",
      "free-model",
      "gpt-9",
      "old-model",
    ]);
    expect(zen.models["gpt-9"]).not.toHaveProperty("release_date");
    expect(zen.models["gpt-9"]?.cost).toEqual({ input: 1, output: 2 });
    expect(zen.models["gpt-9"]?.provider?.npm).toBe("@ai-sdk/openai");

    const again = trimOpenCodeCatalog(JSON.stringify(trimmed.value));
    expect(again).toEqual(trimmed);
  });

  it("rejects documents without both gateways or without usable models", () => {
    expect(trimOpenCodeCatalog("not json").ok).toBe(false);
    expect(trimOpenCodeCatalog(JSON.stringify({ opencode: { models: {} } })).ok).toBe(false);

    // SAFETY: documentText() is a JSON object of providers.
    const empty = JSON.parse(documentText()) as Record<string, { models: unknown }>;
    empty["opencode-go"] = { models: { bad: { id: 1 } } };
    expect(trimOpenCodeCatalog(JSON.stringify(empty))).toMatchObject({ ok: false });
  });

  it("the bundled snapshot is a valid trimmed catalog", () => {
    const bundled = embeddedOpenCodeCatalog();
    expect(Object.keys(bundled.opencode.models).length).toBeGreaterThan(10);
    expect(Object.keys(bundled["opencode-go"].models).length).toBeGreaterThan(5);
    expect(trimOpenCodeCatalog(JSON.stringify(bundled))).toEqual({ ok: true, value: bundled });
  });
});

describe("default registered models", () => {
  const catalog = (() => {
    const trimmed = trimOpenCodeCatalog(documentText());

    if (!trimmed.ok) throw new Error(trimmed.error);

    return trimmed.value;
  })();

  it("Zen registers non-deprecated, non-free models with the catalog limits and protocol types", () => {
    const models = defaultCatalogModels(catalog, "opencode-zen");
    expect(models.map((info) => info.id).toSorted()).toEqual(["claude-z", "gpt-9"]);
    const claude = models.find((info) => info.id === "claude-z");
    expect(claude).toMatchObject({
      type: "claude",
      displayName: "CLAUDE-Z",
      contextLength: 200_000,
      maxCompletionTokens: 32_000,
      supportedInputModalities: ["text", "image"],
    });
    expect(models.find((info) => info.id === "gpt-9")?.type).toBe("openai");
  });

  it("Go keeps its free models", () => {
    expect(
      defaultCatalogModels(catalog, "opencode-go")
        .map((info) => info.id)
        .toSorted(),
    ).toEqual(["go-free", "kimi-q"]);
  });
});

describe("cron refresh into KV", () => {
  const run = (kv: FakeKv, responses: Record<string, string | number>) =>
    Effect.runPromise(
      refreshOpenCodeCatalog().pipe(Effect.provide(refreshLayer(kv, fakeHttp(responses)))),
    );

  it("is a scheduled task", () => {
    expect(scheduledTasks.map((task) => task.name)).toContain("opencode-catalog-refresh");
  });

  it("stores the trimmed catalog, then reports unchanged", async () => {
    const kv = new FakeKv();
    const requested: string[] = [];

    const outcome = await Effect.runPromise(
      refreshOpenCodeCatalog().pipe(
        Effect.provide(
          refreshLayer(kv, fakeHttp({ [OPENCODE_CATALOG_URL]: documentText() }, requested)),
        ),
      ),
    );

    expect(requested).toEqual([OPENCODE_CATALOG_URL]);
    expect(outcome).toMatchObject({ status: "updated", models: { opencode: 4, "opencode-go": 2 } });
    const stored = kv.data.get(OPENCODE_CATALOG_KV_KEY);
    expect(stored).toBeDefined();
    expect(stored).not.toContain("gpt-x");
    expect(stored).not.toContain("release_date");

    expect(await run(kv, { [OPENCODE_CATALOG_URL]: documentText() })).toMatchObject({
      status: "unchanged",
    });
    expect(kv.puts).toHaveLength(1);
  });

  it("keeps the stored catalog when the source fails or sends garbage", async () => {
    const kv = new FakeKv();
    kv.data.set(OPENCODE_CATALOG_KV_KEY, "previous");

    expect(await run(kv, { [OPENCODE_CATALOG_URL]: 503 })).toMatchObject({ status: "failed" });
    expect(await run(kv, { [OPENCODE_CATALOG_URL]: '{"opencode":1}' })).toMatchObject({
      status: "failed",
    });
    expect(kv.data.get(OPENCODE_CATALOG_KV_KEY)).toBe("previous");
    expect(kv.puts).toHaveLength(0);
  });

  it("enforces the size limit while the body streams in (no content-length) and cancels the read", async () => {
    const kv = new FakeKv();
    const chunk = new Uint8Array(1 << 20).fill(0x20);
    const progress = { pulled: 0, cancelled: false };

    const endless = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  progress.pulled += 1;
                  controller.enqueue(chunk);
                },
                cancel() {
                  progress.cancelled = true;
                },
              }),
              { status: 200 },
            ),
          ),
        ),
      ),
    );

    const outcome = await Effect.runPromise(
      refreshOpenCodeCatalog().pipe(Effect.provide(refreshLayer(kv, endless))),
    );

    expect(outcome).toEqual({ status: "failed", message: "catalog is too large" });
    // The limit plus one chunk (and the stream's read-ahead), not the whole endless body.
    expect(progress.pulled).toBeLessThan(MAX_OPENCODE_CATALOG_BYTES / chunk.byteLength + 4);
    expect(progress.cancelled).toBe(true);
    expect(kv.puts).toHaveLength(0);
  });

  it("drops the isolate catalog cache after storing a new catalog, not when unchanged", async () => {
    const kv = new FakeKv();
    let invalidated = 0;

    const store = Layer.succeed(
      CatalogStore,
      CatalogStore.of({
        load: Effect.die("unused"),
        stored: Effect.die("unused"),
        invalidate: Effect.sync(() => {
          invalidated += 1;
        }),
      }),
    );

    const layer = Layer.mergeAll(
      fakeHttp({ [OPENCODE_CATALOG_URL]: documentText() }),
      store,
      workerEnv(kv),
    );

    const refresh = () => Effect.runPromise(refreshOpenCodeCatalog().pipe(Effect.provide(layer)));

    expect(await refresh()).toMatchObject({ status: "updated" });
    expect(invalidated).toBe(1);
    expect(await refresh()).toMatchObject({ status: "unchanged" });
    expect(invalidated).toBe(1);
  });
});

describe("request-path catalog", () => {
  beforeEach(resetOpenCodeCatalogCache);

  const withKv = workerEnv;

  it("reads the KV copy when valid", async () => {
    const kv = new FakeKv();
    kv.data.set(OPENCODE_CATALOG_KV_KEY, documentText({ "fresh-model": model("fresh-model") }));

    const catalog = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(withKv(kv))),
    );

    expect(catalog.opencode.models["fresh-model"]).toBeDefined();
  });

  it("falls back to the bundled snapshot when KV is empty or invalid", async () => {
    const empty = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(withKv(new FakeKv()))),
    );

    expect(empty).toEqual(embeddedOpenCodeCatalog());

    resetOpenCodeCatalogCache();
    const kv = new FakeKv();
    kv.data.set(OPENCODE_CATALOG_KV_KEY, "{broken");

    const invalid = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(withKv(kv))),
    );

    expect(invalid).toEqual(embeddedOpenCodeCatalog());
    expect(openCodeCatalogFromText("{broken").warning).toContain("rejected");
    expect(openCodeCatalogFromText(null).warning).toBeUndefined();
  });

  it("without Worker bindings it is the bundled snapshot", async () => {
    expect(await Effect.runPromise(currentOpenCodeCatalog)).toEqual(embeddedOpenCodeCatalog());
  });
});
