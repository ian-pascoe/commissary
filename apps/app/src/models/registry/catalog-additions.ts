/**
 * Catalog additions (ADR 0020): what Commissary owns on top of models.dev. Shipped with the Worker as versioned data
 * (`catalog/additions.json`), never fetched. Seeded once from the Go server's catalog and maintained here from then on.
 *
 * An addition only fills gaps (`catalog-build.ts`): where models.dev has a value for a model it lists, that value
 * wins, and a wrong value is fixed at models.dev rather than overridden here. Per provider (`claude`, `gemini`, ...):
 *
 * - `include` / `exclude`: wildcard patterns over our model ids; which models.dev models the provider takes. Without
 *   `include` every current text model is taken, minus the `exclude`d families the route cannot serve (video, music,
 *   embeddings, ...).
 * - `facts`: per model id, what models.dev does not carry (`thinking.dynamicAllowed`, web search, ...). Only used for
 *   a model models.dev lists, and only where models.dev has no value.
 * - `defaults`: facts of every models.dev model of the provider (lowest priority).
 * - `models`: Commissary's own full records: models models.dev does not list (or no longer lists), served as they are.
 *   When models.dev lists the id, the record fills its gaps like `facts` do.
 * - `plans` (`codex` only): which model ids each plan offers (`free`, `team`, `plus`, `pro`), in listing order;
 *   models.dev only supplies their details.
 *
 * The Codex client catalog (`catalog/codex_client_models.json`) is the other half of the additions and keeps its
 * format (`codex-client-models.ts`).
 */
import { Result, Schema } from "effect";
import type { Json } from "@commissary/json";

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

const Thinking = Schema.Struct({
  min: optional(Schema.Number),
  max: optional(Schema.Number),
  zeroAllowed: optional(Schema.Boolean),
  dynamicAllowed: optional(Schema.Boolean),
  levels: optional(Strings),
});

/** The facts of one model: the fields of `ModelInfo` (`model-info.ts`) that models.dev may lack. */
const factFields = {
  displayName: optional(Schema.String),
  name: optional(Schema.String),
  version: optional(Schema.String),
  description: optional(Schema.String),
  created: optional(Schema.Number),
  inputTokenLimit: optional(Schema.Number),
  outputTokenLimit: optional(Schema.Number),
  supportedGenerationMethods: optional(Strings),
  contextLength: optional(Schema.Number),
  maxCompletionTokens: optional(Schema.Number),
  supportedParameters: optional(Strings),
  supportedInputModalities: optional(Strings),
  supportedOutputModalities: optional(Strings),
  supportsWebSearch: optional(Schema.Boolean),
  supportConfigurationUpdate: optional(Schema.Boolean),
  nativeCapabilities: optional(Schema.Struct({ webSearch: optional(Schema.Boolean) })),
  thinking: optional(Thinking),
  config: optional(
    Schema.Struct({ overrideHeader: optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
};

export const ModelFacts = Schema.Struct(factFields);

export type ModelFacts = typeof ModelFacts.Type;

/** A full record of a model models.dev does not list. */
export const AdditionModel = Schema.Struct({
  id: Schema.String,
  object: optional(Schema.String),
  ownedBy: optional(Schema.String),
  type: optional(Schema.String),
  ...factFields,
});

export type AdditionModel = typeof AdditionModel.Type;

/** Codex plans, which the registry maps credentials onto (`credential-models.ts`). */
export const CODEX_PLANS = ["free", "team", "plus", "pro"] as const;

export type CodexPlan = (typeof CODEX_PLANS)[number];

const ProviderAdditions = Schema.Struct({
  include: optional(Strings),
  exclude: optional(Strings),
  defaults: optional(ModelFacts),
  facts: optional(Schema.Record(Schema.String, ModelFacts)),
  models: optional(Schema.Array(AdditionModel)),
  plans: optional(Schema.Record(Schema.String, Strings)),
});

export type ProviderAdditions = typeof ProviderAdditions.Type;

/** The providers that have additions (our provider names, not models.dev's). */
export const ADDITION_PROVIDERS = [
  "claude",
  "gemini",
  "vertex",
  "aistudio",
  "codex",
  "kimi",
  "antigravity",
  "xai",
  "devin",
  "meta",
] as const;

export type AdditionProvider = (typeof ADDITION_PROVIDERS)[number];

export interface CatalogAdditions {
  /** Format version of the document. */
  readonly version: 1;
  readonly providers: { readonly [P in AdditionProvider]?: ProviderAdditions };
}

const Document = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Struct(
    Object.fromEntries(
      ADDITION_PROVIDERS.map((provider) => [provider, optional(ProviderAdditions)]),
    ),
  ),
});

const decode = Schema.decodeUnknownResult(Document);

export type AdditionsResult =
  | { readonly ok: true; readonly value: CatalogAdditions }
  | { readonly ok: false; readonly error: string };

/** Parses and validates an additions document; `error` names what is wrong. */
export const parseCatalogAdditions = (value: Json): AdditionsResult => {
  const decoded = decode(value);

  if (Result.isFailure(decoded)) return { ok: false, error: String(decoded.failure) };
  // SAFETY: the providers struct is built from ADDITION_PROVIDERS with ProviderAdditions for each key (Object.fromEntries erased the key names).
  const additions = decoded.success as CatalogAdditions;
  const problems: string[] = [];

  for (const provider of ADDITION_PROVIDERS) {
    const entry = additions.providers[provider];

    if (entry === undefined) continue;
    const seen = new Set<string>();

    for (const model of entry.models ?? []) {
      if (model.id.trim() === "" || model.id !== model.id.trim())
        problems.push(`${provider}: model id ${JSON.stringify(model.id)} is empty or padded`);

      if (seen.has(model.id)) problems.push(`${provider}: duplicate model ${model.id}`);
      seen.add(model.id);

      if (entry.facts?.[model.id] !== undefined)
        problems.push(`${provider}: ${model.id} has both a full record and facts`);
    }

    if (provider !== "codex" && entry.plans !== undefined)
      problems.push(`${provider}: plans exist for codex only`);
  }

  for (const plan of Object.keys(additions.providers.codex?.plans ?? {}))
    if (!CODEX_PLANS.some((known) => known === plan)) problems.push(`codex: unknown plan ${plan}`);

  return problems.length === 0
    ? { ok: true, value: additions }
    : { ok: false, error: problems.join("; ") };
};
