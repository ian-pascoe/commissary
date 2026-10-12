/**
 * The OpenCode model catalog (models.dev data for OpenCode Zen and OpenCode Go): which models each gateway serves,
 * which upstream protocol each speaks, and their limits, modalities and reasoning support.
 *
 * Deliberate deviation from Go: CLIProxyAPI has no OpenCode provider. OpenCode's own client picks a model's protocol
 * from the catalog's AI SDK package (`provider.npm`, else the provider's `npm`; sst/opencode
 * `packages/core/src/aisdk-native.ts`) and so does the proxy. The catalog is bundled
 * (`catalog/opencode_models.json`, `pnpm catalog:opencode`) and refreshed into KV by the cron job
 * (`opencode-refresh.ts`); readers use the KV copy when it is valid, else the bundled one. Requests never fetch it.
 * See docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 */
import { Clock, Effect, Option, type Types } from "effect";
import type { OpenCodeProtocol } from "../config/schema.ts";
import { OPENCODE_SPECS, type OpenCodeProvider } from "../executor/opencode/providers.ts";
import { WorkerEnv } from "../platform/env.ts";
import openCodeJson from "./catalog/opencode_models.json";
import type { ModelInfo, ThinkingSupport } from "./model-info.ts";
import {
  type CatalogModel,
  type CatalogProvider,
  type TrimmedCatalog,
  trimOpenCodeCatalog,
} from "./opencode-catalog-trim.ts";

export type { CatalogModel as OpenCodeCatalogModel } from "./opencode-catalog-trim.ts";

/** The OpenCode part of the models.dev catalog, trimmed (`opencode-catalog-trim.ts`). */
export type OpenCodeCatalog = TrimmedCatalog;

/** Where OpenCode itself reads the catalog (the cron source). */
export const OPENCODE_CATALOG_URL = "https://models.opencode.ai/api.json";

/** KV key of the refreshed (trimmed) catalog in `CACHE`. */
export const OPENCODE_CATALOG_KV_KEY = "registry/opencode_models.json";

/** AI SDK package of providers and models that name none (models.dev default). */
export const DEFAULT_OPENCODE_NPM = "@ai-sdk/openai-compatible";

/** AI SDK package -> gateway protocol (sst/opencode `aisdk-native.ts`). */
const NPM_PROTOCOLS: ReadonlyMap<string, OpenCodeProtocol> = new Map([
  ["@ai-sdk/openai-compatible", "chat"],
  ["@ai-sdk/mistral", "chat"],
  ["@ai-sdk/openai", "responses"],
  ["@ai-sdk/anthropic", "messages"],
  ["@ai-sdk/google", "gemini"],
]);

let embedded: OpenCodeCatalog | undefined;

/** The catalog compiled into the Worker (parsed once per isolate). */
export const embeddedOpenCodeCatalog = (): OpenCodeCatalog => {
  if (embedded === undefined) {
    const trimmed = trimOpenCodeCatalog(JSON.stringify(openCodeJson));

    if (!trimmed.ok) throw new Error(`embedded opencode_models.json is invalid: ${trimmed.error}`);
    embedded = trimmed.value;
  }

  return embedded;
};

export interface OpenCodeCatalogFromText {
  readonly catalog: OpenCodeCatalog;
  /** Why a stored text was not used (the bundled catalog was used instead). */
  readonly warning?: string;
}

/** The catalog of a stored KV text; nothing stored or an invalid text yields the bundled catalog. */
export const openCodeCatalogFromText = (
  text: string | null | undefined,
): OpenCodeCatalogFromText => {
  if (text === undefined || text === null) return { catalog: embeddedOpenCodeCatalog() };
  const trimmed = trimOpenCodeCatalog(text);

  if (trimmed.ok) return { catalog: trimmed.value };

  return {
    catalog: embeddedOpenCodeCatalog(),
    warning: `stored opencode catalog rejected, using the bundled one: ${trimmed.error}`,
  };
};

// --- per-isolate KV copy (request path) -----------------------------------------------------------------------------

const LOCAL_CACHE_MS = 60_000;

let cached:
  | { readonly loadedAt: number; readonly text: string | null; readonly catalog: OpenCodeCatalog }
  | undefined;

/** Test hook: forgets the per-isolate copy. */
export const resetOpenCodeCatalogCache = (): void => {
  cached = undefined;
};

/**
 * The active catalog for request handling: the KV copy (re-read at most once a minute per isolate), else the bundled
 * one. Never fails; without Worker bindings (unit tests) it is the bundled catalog.
 */
export const currentOpenCodeCatalog: Effect.Effect<OpenCodeCatalog> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;

  if (cached !== undefined && now - cached.loadedAt < LOCAL_CACHE_MS) return cached.catalog;
  const env = yield* Effect.serviceOption(WorkerEnv);

  if (Option.isNone(env)) return embeddedOpenCodeCatalog();

  const stored = yield* Effect.tryPromise(() => env.value.CACHE.get(OPENCODE_CATALOG_KV_KEY)).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<string | null>()),
  );

  // A failed read keeps the previous copy.
  if (Option.isNone(stored)) return cached?.catalog ?? embeddedOpenCodeCatalog();

  if (cached !== undefined && cached.text === stored.value) {
    cached = { ...cached, loadedAt: now };

    return cached.catalog;
  }

  const built = openCodeCatalogFromText(stored.value);

  if (built.warning !== undefined) yield* Effect.logWarning(built.warning);
  cached = { loadedAt: now, text: stored.value, catalog: built.catalog };

  return built.catalog;
});

// --- lookups --------------------------------------------------------------------------------------------------------

/** The catalog section of a gateway. */
export const catalogProvider = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
): CatalogProvider => catalog[OPENCODE_SPECS[provider].catalogId];

/** A model of a gateway by id (exact, then case-insensitive). */
export const findCatalogModel = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  modelId: string,
): CatalogModel | undefined => {
  const { models } = catalogProvider(catalog, provider);
  const id = modelId.trim();
  const exact = models[id];

  if (exact !== undefined) return exact;
  const lower = id.toLowerCase();

  return Object.values(models).find((model) => model.id.toLowerCase() === lower);
};

/** The model's AI SDK package: its own `provider.npm`, else the provider's, else the models.dev default. */
export const catalogModelNpm = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  model: CatalogModel,
): string => model.provider?.npm ?? catalogProvider(catalog, provider).npm ?? DEFAULT_OPENCODE_NPM;

/**
 * The gateway protocol of an AI SDK package; `undefined` for an unknown package. `@ai-sdk/google` exists only on Zen;
 * a Go model naming it is unknown too.
 */
export const protocolForNpm = (
  npm: string,
  provider: OpenCodeProvider,
): OpenCodeProtocol | undefined => {
  const protocol = NPM_PROTOCOLS.get(npm.trim());

  return protocol === "gemini" && provider !== "opencode-zen" ? undefined : protocol;
};

export const isDeprecatedModel = (model: CatalogModel): boolean =>
  (model.status ?? "").trim().toLowerCase() === "deprecated";

/** Both prices are zero (OpenCode's free tier). */
export const isFreeModel = (model: CatalogModel): boolean =>
  model.cost?.input === 0 && model.cost.output === 0;

/** The registry `type` of a protocol: the format family the thinking pipeline validates against. */
export const openCodeProtocolType = (protocol: OpenCodeProtocol | undefined): string => {
  switch (protocol) {
    case "messages":
      return "claude";
    case "gemini":
      return "gemini";
    default:
      return "openai";
  }
};

const DEFAULT_LEVELS: ReadonlyArray<string> = ["low", "medium", "high"];

/**
 * Thinking support from `reasoning`/`reasoning_options`: `effort` values become levels, `budget_tokens` a budget range
 * (minimum 1024 and the output limit by default), `toggle` (or no options) the standard low/medium/high levels.
 * Models without reasoning support none, so reasoning settings are stripped for them.
 */
export const catalogThinking = (model: CatalogModel): ThinkingSupport | undefined => {
  if (model.reasoning !== true) return undefined;
  const out: Types.Mutable<ThinkingSupport> = {};
  const levels: string[] = [];

  for (const option of model.reasoning_options ?? []) {
    if (option.type === "effort") {
      for (const value of option.values ?? []) {
        const level = value.trim().toLowerCase();

        if (level === "none") out.zeroAllowed = true;
        else if (level === "auto") out.dynamicAllowed = true;

        if (level !== "" && !levels.includes(level)) levels.push(level);
      }
    } else if (option.type === "budget_tokens") {
      out.min = option.min ?? 1024;
      const max = option.max ?? model.limit?.output;

      if (max !== undefined && max > 0) out.max = max;
      out.zeroAllowed = true;
    }
  }

  if (levels.length > 0) out.levels = levels;
  else if (out.min === undefined) out.levels = [...DEFAULT_LEVELS];

  return out;
};

/** `ModelInfo` of a catalog model as the gateway `provider` serves it. */
export const catalogModelInfo = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  model: CatalogModel,
): ModelInfo => {
  const protocol = protocolForNpm(catalogModelNpm(catalog, provider, model), provider);

  const info: Types.Mutable<ModelInfo> = {
    id: model.id,
    object: "model",
    created: 0,
    ownedBy: "opencode",
    type: openCodeProtocolType(protocol),
    displayName: model.name ?? model.id,
  };

  const context = model.limit?.context ?? 0;
  const output = model.limit?.output ?? 0;

  if (context > 0) info.contextLength = context;

  if (output > 0) info.maxCompletionTokens = output;
  const input = model.modalities?.input ?? [];

  if (input.length > 0) info.supportedInputModalities = [...input];
  const outputModalities = model.modalities?.output ?? [];

  if (outputModalities.length > 0) info.supportedOutputModalities = [...outputModalities];
  const thinking = catalogThinking(model);

  if (thinking !== undefined) info.thinking = thinking;

  return info;
};

/**
 * The models a gateway registers when its config lists none: every catalog model that is not deprecated, minus the
 * free models where the gateway rejects them outside OpenCode's own client (Zen).
 */
export const defaultCatalogModels = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
): ModelInfo[] =>
  Object.values(catalogProvider(catalog, provider).models)
    .filter(
      (model) =>
        !isDeprecatedModel(model) &&
        !(OPENCODE_SPECS[provider].skipFreeModels && isFreeModel(model)),
    )
    .map((model) => catalogModelInfo(catalog, provider, model));
