import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { WorkerEnv } from "../src/platform/env.ts";
import { embeddedCatalogs, embeddedModelsDev } from "../src/registry/catalog.ts";
import { resetOpenCodeCatalogCache, openCodeCatalogFor } from "../src/registry/opencode-catalog.ts";
import { CATALOG_CACHE_TTL_MS, CATALOG_KEYS, CatalogStore } from "../src/registry/catalog-store.ts";
import {
  MAX_CATALOG_BYTES,
  MODELS_DEV_URL,
  refreshCatalogs,
  resolveSource,
} from "../src/registry/refresh.ts";
import { scheduledTasks } from "../src/scheduled.ts";
import { documentText, mdModel } from "./support/models-dev.ts";
import {
  FakeKv,
  fakeConfig,
  fakeHttp,
  fakeLease,
  refreshLayer,
  workerEnv,
} from "./support/registry-refresh.ts";

const runRefresh = (
  kv: FakeKv,
  responses: Record<string, string | number>,
  yaml = "",
  requested: string[] = [],
) => refreshCatalogs.pipe(Effect.provide(refreshLayer(kv, fakeHttp(responses, requested), yaml)));

describe("resolveSource", () => {
  it("maps the models.catalog values", () => {
    assert.deepStrictEqual(resolveSource(""), { mode: "fetch", url: MODELS_DEV_URL });
    assert.deepStrictEqual(resolveSource(" https://x.test/m.json "), {
      mode: "fetch",
      url: "https://x.test/m.json",
    });
    assert.deepStrictEqual(resolveSource("embed"), { mode: "embed" });
    assert.deepStrictEqual(resolveSource("disabled"), { mode: "disabled" });
    assert.strictEqual(resolveSource("/etc/models.json").mode, "disabled");
    assert.strictEqual(resolveSource("ftp://x/y").mode, "disabled");
  });
});

describe("refreshCatalogs (cron)", () => {
  it("is the one scheduled catalog task", () => {
    assert.deepStrictEqual(
      scheduledTasks.map((task) => task.name).filter((name) => name.includes("catalog")),
      ["model-catalog-refresh"],
    );
  });

  it.effect("stores the trimmed document with one fetch, then reports unchanged", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      const requested: string[] = [];

      const outcome = yield* runRefresh(kv, { [MODELS_DEV_URL]: documentText() }, "", requested);

      assert.deepStrictEqual(requested, [MODELS_DEV_URL]);
      assert.strictEqual(outcome.status, "updated");
      assert.deepStrictEqual(outcome.models, {
        anthropic: 1,
        google: 1,
        "google-vertex": 1,
        xai: 1,
        meta: 1,
        "kimi-code-plan-global": 1,
        openai: 1,
        opencode: 4,
        "opencode-go": 2,
      });
      const stored = kv.data.get(CATALOG_KEYS.modelsDev);
      assert.isDefined(stored);
      assert.isFalse(stored?.includes("mistral-x"));
      assert.isFalse(stored?.includes("knowledge"));
      // The prices stay: they cost usage records (ADR 0024).
      assert.isTrue(stored?.includes("cache_read"));
      assert.isDefined(kv.data.get(CATALOG_KEYS.status));

      const again = yield* runRefresh(kv, { [MODELS_DEV_URL]: documentText() });
      assert.strictEqual(again.status, "unchanged");
      assert.strictEqual(kv.puts.filter((key) => key === CATALOG_KEYS.modelsDev).length, 1);
    }),
  );

  it.effect("a new model shows up in the stored catalog without any additions change", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      yield* runRefresh(kv, {
        [MODELS_DEV_URL]: documentText({
          anthropic: { "claude-brand-new": mdModel("claude-brand-new") },
        }),
      });

      const catalogs = yield* Effect.gen(function* () {
        const store = yield* CatalogStore;

        return yield* store.load(false);
      }).pipe(Effect.provide(Layer.mergeAll(CatalogStore.layer, workerEnv(kv))));

      assert.isTrue(catalogs.models.claude.some((model) => model.id === "claude-brand-new"));
    }),
  );

  it.effect("counts malformed entries in the document and says so", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();

      const outcome = yield* runRefresh(kv, {
        [MODELS_DEV_URL]: documentText({ anthropic: { "claude-bad": { id: 42 } } }),
      });

      assert.strictEqual(outcome.status, "updated");
      // The test document already has one broken OpenCode entry.
      assert.strictEqual(outcome.skipped, 2);
    }),
  );

  it.effect("added and removed count the models clients can call, not the document's ids", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();

      const first = documentText({
        anthropic: { "claude-brand-new": mdModel("claude-brand-new") },
      });

      yield* runRefresh(kv, { [MODELS_DEV_URL]: first });

      // A deprecated model, an OpenCode-only one and a non-text one are no served models.
      const noise = yield* runRefresh(kv, {
        [MODELS_DEV_URL]: documentText({
          anthropic: {
            "claude-brand-new": mdModel("claude-brand-new"),
            "claude-old": mdModel("claude-old", { status: "deprecated" }),
          },
          opencode: { "extra-gateway-model": mdModel("extra-gateway-model") },
        }),
      });

      assert.strictEqual(noise.status, "updated");
      assert.strictEqual(noise.added, 0);
      assert.strictEqual(noise.removed, 0);

      const dropped = yield* runRefresh(kv, { [MODELS_DEV_URL]: documentText() });

      assert.strictEqual(dropped.removed, 1);
      assert.strictEqual(dropped.added, 0);
    }),
  );

  it.effect("keeps the stored catalog when the source fails or sends garbage", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      kv.data.set(CATALOG_KEYS.modelsDev, "previous");

      for (const reply of [503, "<html>not json</html>", '{"anthropic":1}']) {
        const outcome = yield* runRefresh(kv, { [MODELS_DEV_URL]: reply });
        assert.strictEqual(outcome.status, "failed");
      }

      // A provider Commissary reads without a single usable model rejects the whole document.
      const noModels = JSON.parse(documentText()) as Record<string, { models: unknown }>;
      noModels["xai"] = { models: { bad: { id: 1 } } };
      const rejected = yield* runRefresh(kv, { [MODELS_DEV_URL]: JSON.stringify(noModels) });
      assert.strictEqual(rejected.status, "failed");

      assert.strictEqual(kv.data.get(CATALOG_KEYS.modelsDev), "previous");
      assert.strictEqual(kv.puts.filter((key) => key === CATALOG_KEYS.modelsDev).length, 0);
    }),
  );

  it.effect("rejects a document above the size limit by its declared length", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();

      const huge = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                status: 200,
                headers: { "content-length": String(MAX_CATALOG_BYTES + 1) },
              }),
            ),
          ),
        ),
      );

      const outcome = yield* refreshCatalogs.pipe(Effect.provide(refreshLayer(kv, huge)));
      assert.strictEqual(outcome.status, "failed");
      assert.isTrue(outcome.message?.includes("too large"));
      assert.strictEqual(kv.puts.length, 1);
    }),
  );

  it.effect("enforces the size limit while the body streams in and cancels the read", () =>
    Effect.gen(function* () {
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

      const outcome = yield* refreshCatalogs.pipe(Effect.provide(refreshLayer(kv, endless)));

      assert.deepStrictEqual(outcome, { status: "failed", message: "catalog is too large" });
      // The limit plus one chunk (and the stream's read-ahead), not the whole endless body.
      assert.isTrue(progress.pulled < MAX_CATALOG_BYTES / chunk.byteLength + 4);
      assert.isTrue(progress.cancelled);
      assert.isFalse(kv.data.has(CATALOG_KEYS.modelsDev));
    }),
  );

  it.effect("an explicit source replaces the default; embed clears the copy; disabled skips", () =>
    Effect.gen(function* () {
      const custom = "https://example.test/custom.json";
      const kv = new FakeKv();
      const requested: string[] = [];

      const custom1 = yield* runRefresh(
        kv,
        { [custom]: documentText() },
        `models:\n  catalog: ${custom}\n`,
        requested,
      );

      assert.deepStrictEqual(requested, [custom]);
      assert.strictEqual(custom1.status, "updated");
      assert.isTrue(kv.data.has(CATALOG_KEYS.modelsDev));

      const embed = yield* runRefresh(kv, {}, "models:\n  catalog: embed\n");
      assert.strictEqual(embed.status, "updated");
      assert.isFalse(kv.data.has(CATALOG_KEYS.modelsDev));

      const again = yield* runRefresh(kv, {}, "models:\n  catalog: embed\n");
      assert.strictEqual(again.status, "unchanged");

      const off = yield* runRefresh(kv, {}, "models:\n  catalog: disabled\n", requested);
      assert.strictEqual(off.status, "skipped");
      assert.deepStrictEqual(requested, [custom]);
    }),
  );

  it.effect("the Codex and Devin catalog keys have no effect on the refresh", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      const requested: string[] = [];

      const outcome = yield* runRefresh(
        kv,
        { [MODELS_DEV_URL]: documentText() },
        "models:\n  codex-catalog: disabled\n  devin-catalog: embed\n",
        requested,
      );

      assert.strictEqual(outcome.status, "updated");
      assert.deepStrictEqual(requested, [MODELS_DEV_URL]);
    }),
  );

  it.effect("an interrupted refresh gives the lease back", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      const lease = fakeLease();

      const hang = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      );

      const fiber = yield* refreshCatalogs.pipe(
        Effect.provide(refreshLayer(kv, hang, "", lease)),
        Effect.forkChild,
      );

      for (let turn = 0; turn < 20 && lease.taken.length === 0; turn += 1)
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

      assert.deepStrictEqual(lease.taken, ["cron"]);
      assert.deepStrictEqual(lease.released, []);

      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(lease.released, ["tok"]);
    }),
  );

  it.effect("the Platform registry that cannot be reached fails the refresh and records it", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      const requested: string[] = [];

      const env = Layer.succeed(WorkerEnv, {
        CACHE: kv as unknown as KVNamespace,
        PLATFORM: {
          getByName: () => ({
            takeCatalogRefreshLease: async () => {
              throw new Error("down");
            },
          }),
        },
      } as unknown as Env);

      const outcome = yield* refreshCatalogs.pipe(
        Effect.provide(
          Layer.mergeAll(
            fakeHttp({ [MODELS_DEV_URL]: documentText() }, requested),
            fakeConfig(""),
            CatalogStore.layer,
            env,
          ),
        ),
      );

      assert.deepStrictEqual(outcome, {
        status: "failed",
        message: "platform registry unavailable",
      });
      assert.deepStrictEqual(requested, []);
      assert.isTrue(kv.data.get(CATALOG_KEYS.status)?.includes("platform registry unavailable"));
    }),
  );

  it.effect("storage failures are reported, never thrown", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      kv.failPut = true;
      const outcome = yield* runRefresh(kv, { [MODELS_DEV_URL]: documentText() });
      assert.strictEqual(outcome.status, "failed");
    }),
  );

  it.effect(
    "drops the isolate catalog cache after storing a new document, not when unchanged",
    () =>
      Effect.gen(function* () {
        const kv = new FakeKv();
        let invalidated = 0;

        const store = Layer.succeed(
          CatalogStore,
          CatalogStore.of({
            load: () => Effect.die("unused"),
            stored: Effect.promise(() => kv.get(CATALOG_KEYS.modelsDev)),
            invalidate: Effect.sync(() => {
              invalidated += 1;
            }),
          }),
        );

        const layer = Layer.mergeAll(
          fakeHttp({ [MODELS_DEV_URL]: documentText() }),
          store,
          workerEnv(kv),
          fakeConfig(""),
        );

        const refresh = refreshCatalogs.pipe(Effect.provide(layer));

        assert.strictEqual((yield* refresh).status, "updated");
        assert.strictEqual(invalidated, 1);
        assert.strictEqual((yield* refresh).status, "unchanged");
        assert.strictEqual(invalidated, 1);
      }),
  );
});

describe("CatalogStore", () => {
  it.effect(
    "serves the bundled catalogs, then the KV copy after the cache TTL, and survives KV errors",
    () => {
      const kv = new FakeKv();

      return Effect.gen(function* () {
        const store = yield* CatalogStore;
        const before = yield* store.load(false);
        assert.strictEqual(before.models.claude.length, embeddedCatalogs().models.claude.length);

        kv.data.set(
          CATALOG_KEYS.modelsDev,
          documentText({ anthropic: { "from-kv": mdModel("from-kv") } }),
        );
        const cached = yield* store.load(false);
        assert.strictEqual(cached, before);

        yield* TestClock.adjust(CATALOG_CACHE_TTL_MS + 1);
        const after = yield* store.load(false);
        assert.isTrue(after.models.claude.some((model) => model.id === "from-kv"));
        assert.isTrue(after.modelsDev.opencode.models["gpt-9"] !== undefined);

        kv.get = async () => {
          throw new Error("kv down");
        };

        yield* TestClock.adjust(CATALOG_CACHE_TTL_MS + 1);
        const stale = yield* store.load(false);
        assert.strictEqual(stale, after);
      }).pipe(Effect.provide(Layer.mergeAll(CatalogStore.layer, workerEnv(kv))));
    },
  );

  it.effect("embed ignores the stored copy, and so does the OpenCode reader", () => {
    const kv = new FakeKv();
    kv.data.set(
      CATALOG_KEYS.modelsDev,
      documentText({ anthropic: { "from-kv": mdModel("from-kv") } }),
    );

    return Effect.gen(function* () {
      const store = yield* CatalogStore;
      resetOpenCodeCatalogCache();

      assert.strictEqual(yield* store.load(true), embeddedCatalogs());
      assert.isTrue(
        (yield* store.load(false)).models.claude.some((model) => model.id === "from-kv"),
      );
      assert.deepStrictEqual(yield* openCodeCatalogFor("embed"), embeddedModelsDev());
      assert.isDefined((yield* openCodeCatalogFor("")).opencode.models["free-model"]);
    }).pipe(Effect.provide(Layer.mergeAll(CatalogStore.layer, workerEnv(kv))));
  });

  it.effect("an invalid stored document falls back to the bundled catalogs", () => {
    const kv = new FakeKv();
    kv.data.set(CATALOG_KEYS.modelsDev, "{broken");

    return Effect.gen(function* () {
      const store = yield* CatalogStore;
      assert.strictEqual(yield* store.load(false), embeddedCatalogs());
    }).pipe(Effect.provide(Layer.mergeAll(CatalogStore.layer, workerEnv(kv))));
  });
});
