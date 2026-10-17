/**
 * Price overrides (`/v9/management/price-overrides`, `packages/models/src/management/price-routes.ts`): an org's own price for
 * a provider and model, which wins over the models.dev price when a usage record is costed (ADR 0024). Shared with the
 * browser: imports `effect` and `./config.ts`, `./errors.ts` only.
 *
 * Prices are US dollars per million tokens. `cache_read` and `cache_write` left out charge those tokens at the input
 * price. Each override is a config entry with a revision (ADR 0025): an edit names the revision it was based on in
 * `If-Match` (0 for a new override).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Revision } from "./config.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** The largest price (USD per million tokens) an override may state: a typo guard, not a market bound. */
export const MAX_OVERRIDE_PRICE = 100_000;

/** The provider and model of a usage record and the prices to cost its tokens at. */
export const PriceOverrideBody = Schema.Struct({
  /** The provider key of the usage record (`codex`, `claude`, `gemini`, an OpenAI-compatible endpoint's name, ...). */
  provider: Schema.String,
  model: Schema.String,
  /** US dollars per million tokens. */
  input: Schema.Number,
  output: Schema.Number,
  cache_read: optional(Schema.Number),
  cache_write: optional(Schema.Number),
});

export type PriceOverrideBody = typeof PriceOverrideBody.Type;

export const PriceOverride = Schema.Struct({
  ...PriceOverrideBody.fields,
  id: Schema.String,
  revision: Revision,
  /** Epoch milliseconds. */
  updated_at: Schema.Number,
  /** The principal that wrote it. */
  updated_by: Schema.String,
});

export type PriceOverride = typeof PriceOverride.Type;

/** `version` is the org's change counter the list was read at. */
export const PriceOverrides = Schema.Struct({
  version: Schema.Int,
  overrides: Schema.Array(PriceOverride),
});

export type PriceOverrides = typeof PriceOverrides.Type;

/** A saved override: its `id` and new `revision` (0 when it was removed). */
export const PriceOverrideSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  id: Schema.String,
  revision: Revision,
});

export type PriceOverrideSaved = typeof PriceOverrideSaved.Type;

/** The `If-Match` request header: the override's revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

export class PricesGroup extends HttpApiGroup.make("prices").add(
  HttpApiEndpoint.get("list", "/price-overrides", {
    success: PriceOverrides,
    error: managementErrors,
  }),
  /** Add an override (409 when the provider and model have one). */
  HttpApiEndpoint.post("create", "/price-overrides", {
    payload: PriceOverrideBody,
    success: PriceOverrideSaved,
    error: managementErrors,
  }),
  /** Replace an override's provider, model and prices. */
  HttpApiEndpoint.put("replace", "/price-overrides/:id", {
    ...idParam,
    ...IfMatch,
    payload: PriceOverrideBody,
    success: PriceOverrideSaved,
    error: managementErrors,
  }),
  /** Remove an override: its provider and model are priced from the catalog again (or unpriced). */
  HttpApiEndpoint.delete("remove", "/price-overrides/:id", {
    ...idParam,
    ...IfMatch,
    success: PriceOverrideSaved,
    error: managementErrors,
  }),
) {}
