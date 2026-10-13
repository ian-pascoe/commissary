/**
 * Worker-side cached reader for the config stored in each org's ControlPlane Durable Object.
 *
 * Each isolate keeps the last snapshot of every org it served. After `ttl` it asks the org's Durable Object for the
 * document with the cached version, so an unchanged config costs one small RPC and no decoding. When the Durable
 * Object is unreachable the last snapshot keeps being served (stale-if-error). Per-request bindings are never
 * captured: the DO stub is resolved from `WorkerEnv` and `CurrentOrg` at call time.
 *
 * Deployment settings: the model catalog is shared by every org, so its source (`models.catalog`) is the `global`
 * org's setting. Another org's snapshot carries `global`'s value (its own ControlPlane refuses to store one,
 * `ConfigStore`), so every reader of `models.catalog` sees the one setting that decides the shared catalog.
 */
import { Clock, Context, Duration, Effect, Layer, Ref } from "effect";
import { currentControlPlane, type WorkerEnv } from "../platform/env.ts";
import { CurrentOrg, GLOBAL_ORG, type OrgId } from "../platform/org.ts";
import { ConfigStoreError } from "./errors.ts";
import type { Config } from "./schema.ts";
import { decodeStoredConfig, type ConfigSnapshotWire } from "./store.ts";

export interface ConfigSnapshot {
  readonly version: number;
  readonly config: Config;
}

/**
 * Where the current org's config snapshots come from; the default implementation talks to the org's ControlPlane
 * Durable Object.
 */
export class ConfigSource extends Context.Service<
  ConfigSource,
  {
    readonly fetch: (
      sinceVersion: number | undefined,
    ) => Effect.Effect<ConfigSnapshotWire, ConfigStoreError, WorkerEnv | CurrentOrg>;
  }
>()("cf-llm-proxy/config/ConfigSource") {
  static readonly controlPlane = Layer.succeed(
    ConfigSource,
    ConfigSource.of({
      fetch: (sinceVersion) =>
        Effect.gen(function* () {
          const stub = yield* currentControlPlane;

          return yield* Effect.tryPromise({
            try: async () => await stub.getConfig(sinceVersion),
            catch: (cause) =>
              new ConfigStoreError({ message: "failed to read config from ControlPlane", cause }),
          });
        }),
    }),
  );
}

interface Cached {
  readonly snapshot: ConfigSnapshot;
  readonly checkedAt: number;
}

export interface ConfigReaderOptions {
  /** How long a snapshot is served before the version is re-checked (default 5 s). */
  readonly ttl?: Duration.Input;
}

export class ConfigReader extends Context.Service<
  ConfigReader,
  {
    /** The current org's config snapshot (cached per org). */
    readonly get: Effect.Effect<ConfigSnapshot, ConfigStoreError, WorkerEnv | CurrentOrg>;
    /** Drops the current org's cached snapshot so the next `get` re-reads (use after a local write). */
    readonly invalidate: Effect.Effect<void, never, CurrentOrg>;
  }
>()("cf-llm-proxy/config/ConfigReader") {
  /** Requires a {@link ConfigSource}. */
  static readonly layer = (options: ConfigReaderOptions = {}) =>
    Layer.effect(ConfigReader, makeConfigReader(options));

  /** Reads through the ControlPlane Durable Object. */
  static readonly layerControlPlane = (options: ConfigReaderOptions = {}) =>
    ConfigReader.layer(options).pipe(Layer.provide(ConfigSource.controlPlane));
}

export const makeConfigReader = Effect.fnUntraced(function* (options: ConfigReaderOptions) {
  const source = yield* ConfigSource;
  const ttlMillis = Duration.toMillis(options.ttl ?? Duration.seconds(5));
  // Snapshots per org; the orgs one isolate serves are a small set.
  const cache = yield* Ref.make<ReadonlyMap<OrgId, Cached>>(new Map());

  const store = (org: OrgId, cached: Cached | undefined) =>
    Ref.update(cache, (all) => {
      const next = new Map(all);

      if (cached === undefined) next.delete(org);
      else next.set(org, cached);

      return next;
    });

  const refresh = (org: OrgId, cached: Cached | undefined) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const wire = yield* source
        .fetch(cached?.snapshot.version)
        .pipe(Effect.provideService(CurrentOrg, org));

      if (wire.unchanged && cached !== undefined) {
        yield* store(org, { snapshot: cached.snapshot, checkedAt: now });

        return cached.snapshot;
      }

      if (wire.document === undefined) {
        return yield* new ConfigStoreError({ message: "ControlPlane returned no config document" });
      }

      const config = yield* decodeStoredConfig(wire.document).pipe(
        Effect.mapError(
          (cause) => new ConfigStoreError({ message: "stored config is invalid", cause }),
        ),
      );

      const snapshot: ConfigSnapshot = { version: wire.version, config };
      yield* store(org, { snapshot, checkedAt: now });

      return snapshot;
    });

  const own = (org: OrgId) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(cache)).get(org);
      const now = yield* Clock.currentTimeMillis;

      if (cached !== undefined && now - cached.checkedAt < ttlMillis) return cached.snapshot;

      return yield* refresh(org, cached).pipe(
        Effect.catch((error) =>
          cached === undefined
            ? Effect.fail(error)
            : Effect.logWarning(
                `config refresh failed, serving stale snapshot v${cached.snapshot.version}: ${error.message}`,
              ).pipe(Effect.as(cached.snapshot)),
        ),
      );
    });

  const get = Effect.gen(function* () {
    const org = yield* CurrentOrg;
    const snapshot = yield* own(org);

    if (org === GLOBAL_ORG) return snapshot;

    // The deployment settings come from `global`; without its config, the org's own (default) value stands.
    const catalog = yield* own(GLOBAL_ORG).pipe(
      Effect.map((deployment) => deployment.config.models.catalog),
      Effect.catch((error) =>
        Effect.logWarning(
          `global config unavailable for deployment settings: ${error.message}`,
        ).pipe(Effect.as(snapshot.config.models.catalog)),
      ),
    );

    return catalog === snapshot.config.models.catalog
      ? snapshot
      : {
          version: snapshot.version,
          config: { ...snapshot.config, models: { ...snapshot.config.models, catalog } },
        };
  });

  return ConfigReader.of({
    get,
    invalidate: Effect.gen(function* () {
      yield* store(yield* CurrentOrg, undefined);
    }),
  });
});
