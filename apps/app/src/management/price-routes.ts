/**
 * `GET|POST /v9/management/price-overrides` and `PUT|DELETE /price-overrides/:id` (`PricesGroup` in
 * @commissary/contract/prices): an org's price overrides (ADR 0024). Workers addition, no Go counterpart.
 *
 * An override is a config entry (ADR 0025) of the request's org. `POST` creates one (`409 conflict` when the provider
 * and model already have one); `PUT` and `DELETE` name the revision they were based on in `If-Match` and answer `409
 * conflict` when it is stale, `404 not_found` for an id that does not exist when the header says `0` (a stale revision of a removed override is `409`); a missing or malformed header is `400
 * invalid_if_match`. A name that is empty or a price that is not a number from 0 to the cap is `422 invalid_config`
 * (a value of the wrong type is `400 invalid body`). A price applies to the usage recorded after the write: the cost
 * stored on a record is never recomputed.
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import type { PriceOverrideValue, WriteResult } from "../config/store.ts";
import { isJsonObject, type Json } from "../json/index.ts";
import { bodyJson, handled, ifMatch, jsonReply, replyError } from "./http.ts";
import { modelsControlPlane } from "../models/env.ts";

const BASE = "/v9/management/price-overrides";

const isRate = (value: Json | undefined): value is number => typeof value === "number";

/** The body as an override's value; a field of the wrong type is `400 invalid body`. */
const parseValue = (body: Json): PriceOverrideValue | undefined => {
  if (!isJsonObject(body)) return undefined;
  const { provider, model, input, output, cache_read: cacheRead, cache_write: cacheWrite } = body;

  if (typeof provider !== "string" || typeof model !== "string") return undefined;

  if (!isRate(input) || !isRate(output)) return undefined;

  if (
    (cacheRead !== undefined && !isRate(cacheRead)) ||
    (cacheWrite !== undefined && !isRate(cacheWrite))
  )
    return undefined;

  return {
    provider,
    model,
    input,
    output,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
};

const value = Effect.gen(function* () {
  const parsed = parseValue(yield* bodyJson);

  return parsed ?? (yield* replyError(400, "invalid body"));
});

const idParam = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;
  let decoded = "";

  try {
    decoded = decodeURIComponent(id ?? "");
  } catch {
    return yield* replyError(400, "invalid_id");
  }

  return decoded === "" ? yield* replyError(400, "invalid_id") : decoded;
});

const written = (result: WriteResult<{ readonly id: string; readonly revision: number }>) => {
  if (result.ok)
    return Effect.succeed(
      jsonReply(200, {
        status: "ok",
        version: result.version,
        id: result.id,
        revision: result.revision,
      }),
    );

  if (result.error === "conflict")
    return Effect.fail(replyError(409, "conflict", { message: result.message }));

  if (result.error === "not_found") return Effect.fail(replyError(404, "not_found"));

  return Effect.fail(replyError(422, "invalid_config", { message: result.message }));
};

const list = Effect.gen(function* () {
  return jsonReply(
    200,
    yield* modelsControlPlane("priceOverrideEntries", (stub) => stub.priceOverrideEntries()),
  );
});

const create = Effect.gen(function* () {
  const price = yield* value;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* modelsControlPlane("writePriceOverride", (stub) =>
    stub.writePriceOverride({ revision: 0, value: price }, principalId),
  );

  return yield* written(result);
});

const replace = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const price = yield* value;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* modelsControlPlane("writePriceOverride", (stub) =>
    stub.writePriceOverride({ id, revision, value: price }, principalId),
  );

  return yield* written(result);
});

const remove = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* modelsControlPlane("writePriceOverride", (stub) =>
    stub.writePriceOverride({ id, revision, value: null }, principalId),
  );

  return yield* written(result);
});

export const priceRoutes = [
  HttpRouter.route("GET", BASE, handled(list)),
  HttpRouter.route("POST", BASE, handled(create)),
  HttpRouter.route("PUT", `${BASE}/:id`, handled(replace)),
  HttpRouter.route("DELETE", `${BASE}/:id`, handled(remove)),
];
