/**
 * Cron refresh of the OpenCode catalog: fetches the models.dev document OpenCode itself reads
 * (`https://models.opencode.ai/api.json`), trims it to the two gateways and stores the trimmed JSON in KV `CACHE`
 * (`OPENCODE_CATALOG_KV_KEY`), where the registry (`CatalogStore`) and the OpenCode executor
 * (`currentOpenCodeCatalog`) read it.
 *
 * Deliberate deviation from Go (no OpenCode provider there). Bounded: one fetch per cron run (every 3 hours), a 30 s
 * timeout and a 16 MiB size limit (the document is ≈5.4 MB), enforced on the declared `content-length` and while the
 * body streams in (the read is cancelled once it passes the limit, so no more than the limit plus one chunk is held). A failed fetch, an oversized or invalid document keeps the
 * stored catalog; the request path never fetches. See docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 */
import { Data, Effect, Result, Stream } from "effect";
import type { HttpClientResponse } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";
import { WorkerEnv } from "../platform/env.ts";
import { CatalogStore } from "./catalog-store.ts";
import { OPENCODE_CATALOG_KV_KEY, OPENCODE_CATALOG_URL } from "./opencode-catalog.ts";
import { trimOpenCodeCatalog } from "./opencode-catalog-trim.ts";

/** Largest document accepted (the full models.dev catalog is ≈5.4 MB). */
export const MAX_OPENCODE_CATALOG_BYTES = 16 << 20;

const TIMEOUT = "30 seconds";

export interface OpenCodeRefreshOutcome {
  readonly status: "updated" | "unchanged" | "failed";
  readonly message?: string;
  /** Model counts of the stored catalog (`opencode`, `opencode-go`). */
  readonly models?: Readonly<Record<string, number>>;
}

class RefreshFailure extends Data.TaggedError("OpenCodeCatalogRefreshFailure")<{
  readonly message: string;
}> {}

const failed = (message: string): OpenCodeRefreshOutcome => ({ status: "failed", message });

/** The response body as text, failing (and cancelling the read) as soon as it passes `maxBytes`. */
export const boundedResponseText = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
): Effect.Effect<string, RefreshFailure> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let read = 0;
    let text = "";

    yield* response.stream.pipe(
      Stream.mapError(() => new RefreshFailure({ message: "catalog fetch failed" })),
      Stream.runForEach((chunk) => {
        read += chunk.byteLength;

        if (read > maxBytes)
          return Effect.fail(new RefreshFailure({ message: "catalog is too large" }));
        text += decoder.decode(chunk, { stream: true });

        return Effect.void;
      }),
    );

    return text + decoder.decode();
  });

/** Fetches, trims and stores the catalog. Never fails: problems are part of the outcome. */
export const refreshOpenCodeCatalog = (
  url: string = OPENCODE_CATALOG_URL,
): Effect.Effect<OpenCodeRefreshOutcome, never, HttpClient.HttpClient | WorkerEnv | CatalogStore> =>
  Effect.gen(function* (): Effect.fn.Return<
    OpenCodeRefreshOutcome,
    never,
    HttpClient.HttpClient | WorkerEnv | CatalogStore
  > {
    const client = yield* HttpClient.HttpClient;
    const env = yield* WorkerEnv;
    const store = yield* CatalogStore;

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json" }),
    );

    const text = yield* client.execute(request).pipe(
      Effect.mapError(() => new RefreshFailure({ message: "catalog fetch failed" })),
      Effect.flatMap((response): Effect.Effect<string, RefreshFailure> => {
        if (response.status !== 200)
          return Effect.fail(
            new RefreshFailure({ message: `catalog source answered HTTP ${response.status}` }),
          );
        const length = Number(response.headers["content-length"] ?? "0");

        if (length > MAX_OPENCODE_CATALOG_BYTES)
          return Effect.fail(
            new RefreshFailure({ message: `catalog is too large (${length} bytes)` }),
          );

        return boundedResponseText(response, MAX_OPENCODE_CATALOG_BYTES);
      }),
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.fail(new RefreshFailure({ message: "catalog fetch timed out" })),
      }),
      Effect.result,
    );

    if (Result.isFailure(text)) return failed(text.failure.message);

    const trimmed = trimOpenCodeCatalog(text.success);

    if (!trimmed.ok) return failed(trimmed.error);
    const next = JSON.stringify(trimmed.value);

    const models = Object.fromEntries(
      Object.values(trimmed.value).map((provider) => [
        provider.id,
        Object.keys(provider.models).length,
      ]),
    );

    const previous = yield* Effect.tryPromise(() => env.CACHE.get(OPENCODE_CATALOG_KV_KEY)).pipe(
      Effect.orElseSucceed(() => null),
    );

    if (previous === next) return { status: "unchanged", models };

    const stored = yield* Effect.tryPromise(() =>
      env.CACHE.put(OPENCODE_CATALOG_KV_KEY, next),
    ).pipe(Effect.result);

    if (Result.isFailure(stored)) return failed("storing the catalog failed");
    yield* store.invalidate;

    return { status: "updated", models };
  }).pipe(
    Effect.tap((outcome) =>
      outcome.status === "failed"
        ? Effect.logWarning(
            `opencode catalog refresh failed, keeping the stored catalog: ${outcome.message ?? ""}`,
          )
        : Effect.logInfo(`opencode catalog: ${outcome.status}`),
    ),
  );
