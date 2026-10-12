/**
 * `ModelRegistry` service: the registry as the pipeline and the listing routes see it.
 *
 * It combines three inputs: the model sources of all credentials (ControlPlane `listModelSources`), the config
 * (`ConfigReader`) and the catalogs (`CatalogStore`: KV copy refreshed by cron, embedded fallback), and exposes an
 * immutable `RegistrySnapshot` that is cached per isolate for a few seconds.
 *
 * Pipeline usage (slice #5): `snapshot.providersForModel(model)` is `util.GetProviderName`, and
 * `snapshot.lookupModelInfo` has the `ModelInfoLookup` shape the thinking pipeline expects
 * (`applyThinking({ lookupModelInfo })`).
 */
import { Clock, Context, Effect, Layer, Ref, Result, Schema } from "effect";
import { ConfigReader } from "../config/reader.ts";
import type { ConfigStoreError } from "../config/errors.ts";
import type { Config } from "../config/schema.ts";
import { WorkerEnv } from "../platform/env.ts";
import { projectModel } from "./availability.ts";
import { assembleCredentialModels } from "./credential-models.ts";
import { CatalogStore } from "./catalog-store.ts";
import { usesEmbeddedCatalog } from "./catalog-source.ts";
import { withAntigravityHints } from "../executor/antigravity/models.ts";
import type { ModelCatalogs } from "./catalog.ts";
import type { ModelInfo } from "./model-info.ts";
import { type ClientRegistration, ModelRegistryIndex } from "./registry.ts";
import type { ModelSource } from "./source.ts";

/** The ControlPlane could not provide the credential model sources. */
export class ModelRegistryError extends Schema.TaggedError<ModelRegistryError>()(
  "ModelRegistryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** How long an isolate reuses a built snapshot (credential or catalog edits show up within this time). */
export const SNAPSHOT_TTL_MS = 5_000;

export class RegistrySnapshot {
  constructor(
    readonly index: ModelRegistryIndex,
    readonly catalogs: ModelCatalogs,
    readonly config: Config,
    readonly now: number,
    /** The enriched credential model sources the index was built from (id order); `routingView` re-assembles them. */
    readonly sources: ReadonlyArray<ModelSource> = [],
    /** Version of `config` in the ControlPlane (0 = defaults, or unknown when built outside the service). */
    readonly configVersion: number = 0,
  ) {}

  /** `util.GetProviderName`: providers of an exact model id, retrying the lower-cased id. */
  providersForModel = (modelId: string): string[] => {
    if (modelId === "") return [];
    const exact = this.index.providersForModel(modelId);

    if (exact.length > 0 || modelId.toLowerCase() === modelId) return exact;

    return this.index.providersForModel(modelId.toLowerCase());
  };

  /** `registry.LookupModelInfo(modelID, provider)`: registry first, then the static catalogs. */
  lookupModelInfo = (modelId: string, provider: string): ModelInfo | undefined =>
    this.index.lookupModelInfo(this.catalogs, modelId, provider);

  /** `registry.ModelOverrideHeaders`: `config.override_header` of the catalog entry (forces upstream headers). */
  modelOverrideHeaders = (modelId: string, provider = ""): Record<string, string> | undefined => {
    const headers = this.lookupModelInfo(modelId, provider)?.config?.overrideHeader;
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers ?? {}))
      if (key.trim() !== "") out[key.trim()] = value;

    return Object.keys(out).length === 0 ? undefined : out;
  };

  /** `GetResponsesWebSearchCapability`: tri-state over every route serving the public model. */
  responsesWebSearchCapability = (modelId: string): boolean | undefined =>
    this.index.responsesWebSearchCapability(modelId);

  /** Models with at least one usable credential, sorted by id (`GetAvailableModelInfos`). */
  availableModels = (): ModelInfo[] => this.index.availableModels(this.now);

  /** `ResolveAutoModel`: the newest available model for `auto`. */
  firstAvailableModel = (): string | undefined => this.index.firstAvailableModel(this.now);

  /** The models one credential serves (prefix/alias/exclusion rules applied). */
  modelsForCredential = (credentialId: string): ModelInfo[] =>
    this.index.modelsForClient(credentialId);

  /** `ClientSupportsModel`. */
  credentialSupportsModel = (credentialId: string, modelId: string): boolean =>
    this.index.clientSupportsModel(credentialId, modelId);
}

/** Pure construction of a snapshot; credentials are registered in id order so "last registered wins" is stable. */
export const buildSnapshot = (input: {
  readonly sources: ReadonlyArray<ModelSource>;
  readonly config: Config;
  readonly catalogs: ModelCatalogs;
  readonly now: number;
  readonly configVersion?: number;
}): RegistrySnapshot => {
  const { config, catalogs, now } = input;
  const nowSeconds = Math.floor(now / 1000);
  const clients: ClientRegistration[] = [];
  const sources = input.sources.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const source of sources) {
    const assembled = assembleCredentialModels(source, { config, catalogs, nowSeconds });

    if (assembled === undefined) continue;
    clients.push({
      id: source.id,
      provider: assembled.provider,
      models: assembled.models,
      projection: (model) => projectModel(source, model, now),
    });
  }

  return new RegistrySnapshot(
    new ModelRegistryIndex(clients, now),
    catalogs,
    config,
    now,
    sources,
    input.configVersion ?? 0,
  );
};

export class ModelRegistry extends Context.Service<
  ModelRegistry,
  {
    /** Current registry snapshot (cached for {@link SNAPSHOT_TTL_MS}). */
    readonly snapshot: Effect.Effect<
      RegistrySnapshot,
      ModelRegistryError | ConfigStoreError,
      WorkerEnv
    >;
    /**
     * A snapshot built right now from a freshly read config (the config reader's cache is dropped first), stored in
     * the cache. Unlike `snapshot` there is no stale fallback: a failure is reported. For admin views that must show an
     * edit made a moment ago.
     */
    readonly fresh: Effect.Effect<
      RegistrySnapshot,
      ModelRegistryError | ConfigStoreError,
      WorkerEnv
    >;
  }
>()("cliproxy/registry/ModelRegistry") {
  /** Needs `ConfigReader` and `CatalogStore`. */
  static readonly layer = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const configReader = yield* ConfigReader;
      const catalogStore = yield* CatalogStore;
      const cache = yield* Ref.make<RegistrySnapshot | undefined>(undefined);

      const build = Effect.gen(function* () {
        const env = yield* WorkerEnv;

        const { config, version } = yield* configReader.get;

        const [catalogs, sources] = yield* Effect.all(
          [
            catalogStore.load(usesEmbeddedCatalog(config.models.catalog)),
            Effect.tryPromise({
              try: async () => await env.CONTROL_PLANE.getByName("global").listModelSources(),
              catch: (cause) =>
                new ModelRegistryError({
                  message: "failed to read model sources from ControlPlane",
                  cause,
                }),
            }),
          ],
          { concurrency: "unbounded" },
        );

        const now = yield* Clock.currentTimeMillis;
        // Antigravity credentials serve the entitlements of their last `fetchAvailableModels` probe (KV).
        const enriched = yield* Effect.promise(() => withAntigravityHints(env.CACHE, sources));

        return buildSnapshot({
          sources: enriched,
          config,
          catalogs,
          now,
          configVersion: version,
        });
      });

      const snapshot = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cache);

        if (cached !== undefined && now - cached.now < SNAPSHOT_TTL_MS) return cached;
        const built = yield* build.pipe(Effect.result);

        if (Result.isSuccess(built)) {
          yield* Ref.set(cache, built.success);

          return built.success;
        }

        // Stale-if-error, like the config reader: keep serving the previous registry while the DO is unreachable.
        if (cached !== undefined) {
          yield* Effect.logWarning(
            `model registry refresh failed, serving the previous snapshot: ${built.failure.message}`,
          );

          return cached;
        }

        return yield* built.failure;
      });

      const fresh = Effect.gen(function* () {
        yield* configReader.invalidate;
        const built = yield* build;
        yield* Ref.set(cache, built);

        return built;
      });

      return ModelRegistry.of({ snapshot, fresh });
    }),
  );
}
