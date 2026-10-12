/**
 * Trims the models.dev catalog (`https://models.opencode.ai/api.json`, ≈5 MB, every provider) down to the two OpenCode
 * gateways and the fields the proxy reads.
 *
 * Deliberate deviation from Go (no OpenCode provider there): see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 * Shared by the bundled-snapshot sync script (`pnpm catalog:opencode`, run by Node directly, so this module imports
 * nothing but `effect`) and by the cron refresh. Decoding strips every key the schemas do not name, so the output keeps
 * the models.dev shape: trimming a trimmed document is a no-op and the runtime parser accepts both. A malformed model
 * entry is skipped; a missing gateway or one without any usable model rejects the document.
 */
import { Result, Schema, type Types } from "effect";

/** models.dev provider ids of OpenCode Zen and OpenCode Go. */
export const OPENCODE_CATALOG_PROVIDERS = ["opencode", "opencode-go"] as const;

export type OpenCodeCatalogProviderId = (typeof OPENCODE_CATALOG_PROVIDERS)[number];

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

const ReasoningOption = Schema.Struct({
  /** `effort` (`values`), `budget_tokens` (`min`/`max`) or `toggle`. */
  type: Schema.String,
  values: optional(Strings),
  min: optional(Schema.Finite),
  max: optional(Schema.Finite),
});

export const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: optional(Schema.String),
  family: optional(Schema.String),
  /** `deprecated` (and possibly `alpha`/`beta`). */
  status: optional(Schema.String),
  reasoning: optional(Schema.Boolean),
  reasoning_options: optional(Schema.Array(ReasoningOption)),
  tool_call: optional(Schema.Boolean),
  attachment: optional(Schema.Boolean),
  modalities: optional(Schema.Struct({ input: optional(Strings), output: optional(Strings) })),
  limit: optional(
    Schema.Struct({ context: optional(Schema.Finite), output: optional(Schema.Finite) }),
  ),
  cost: optional(
    Schema.Struct({ input: optional(Schema.Finite), output: optional(Schema.Finite) }),
  ),
  /** Per-model AI SDK package; overrides the provider's `npm`. */
  provider: optional(Schema.Struct({ npm: optional(Schema.String) })),
});

export type CatalogModel = typeof CatalogModel.Type;

const ProviderHead = Schema.Struct({
  name: optional(Schema.String),
  /** Default AI SDK package of the provider's models. */
  npm: optional(Schema.String),
  /** Gateway base URL. */
  api: optional(Schema.String),
  /** Model entries stay undecoded here: each is decoded on its own so one bad entry does not reject the provider. */
  models: Schema.Record(Schema.String, Schema.Unknown),
});

export interface CatalogProvider {
  readonly id: OpenCodeCatalogProviderId;
  readonly name?: string;
  readonly npm?: string;
  readonly api?: string;
  readonly models: Readonly<Record<string, CatalogModel>>;
}

export type TrimmedCatalog = Readonly<Record<OpenCodeCatalogProviderId, CatalogProvider>>;

export type TrimResult =
  | { readonly ok: true; readonly value: TrimmedCatalog }
  | { readonly ok: false; readonly error: string };

const Document = Schema.Struct({ opencode: ProviderHead, "opencode-go": ProviderHead });

const decodeDocument = Schema.decodeUnknownResult(Schema.fromJsonString(Document));

const decodeModel = Schema.decodeUnknownResult(CatalogModel);

type Head = typeof ProviderHead.Type;

const trimProvider = (
  id: OpenCodeCatalogProviderId,
  head: Head,
): Result.Result<CatalogProvider, string> => {
  const models: Record<string, CatalogModel> = {};

  for (const key of Object.keys(head.models).toSorted()) {
    const decoded = decodeModel(head.models[key]);

    if (Result.isFailure(decoded)) continue;
    const model = decoded.success;
    const modelId = model.id.trim();

    if (modelId === "") continue;
    models[modelId] = modelId === model.id ? model : { ...model, id: modelId };
  }

  if (Object.keys(models).length === 0) return Result.fail(`provider ${id} has no usable models`);
  const provider: Types.Mutable<Omit<CatalogProvider, "models">> = { id };

  if (head.name !== undefined) provider.name = head.name;

  if (head.npm !== undefined) provider.npm = head.npm;

  if (head.api !== undefined) provider.api = head.api;

  return Result.succeed({ ...provider, models });
};

/**
 * The OpenCode part of a models.dev document (JSON text, full or already trimmed). Fails when either gateway is
 * missing or has no usable model, so a broken upstream document never replaces a good catalog.
 */
export const trimOpenCodeCatalog = (text: string): TrimResult => {
  const decoded = decodeDocument(text);

  if (Result.isFailure(decoded))
    return { ok: false, error: `invalid catalog: ${String(decoded.failure)}` };
  const zen = trimProvider("opencode", decoded.success.opencode);

  if (Result.isFailure(zen)) return { ok: false, error: zen.failure };
  const go = trimProvider("opencode-go", decoded.success["opencode-go"]);

  if (Result.isFailure(go)) return { ok: false, error: go.failure };

  return { ok: true, value: { opencode: zen.success, "opencode-go": go.success } };
};
