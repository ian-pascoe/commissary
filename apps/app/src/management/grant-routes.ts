/**
 * `GET|POST /v9/management/grants` and `PUT|DELETE /grants/:id` (`GrantsGroup` in @commissary/contract/grants): which upstream
 * models of which shared credentials a member, a team or everyone may use (ADR 0023), and `GET /models/mine`, the
 * models the caller may use. Workers addition, no Go counterpart.
 *
 * A grant is a config entry (ADR 0025) of the request's org. `POST` creates one (`409 conflict` when the subject and
 * scope already have one); `PUT` and `DELETE` name the revision they were based on in `If-Match` and answer `409
 * conflict` when it is stale; a missing or malformed header is `400 invalid_if_match`. A grant that names no model, or
 * a member or team the org does not have, is `422 invalid_config` (a value of the wrong type is `400 invalid body`). The
 * routes are for org admins; `models/mine` is for every member and answers from the registry as the caller's grants
 * leave it. A grant applies at once to selection and to the model lists within seconds (registry cache).
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import type { WriteResult } from "../config/store.ts";
import type { GrantScope, GrantSubject, GrantValue } from "../grants/grant.ts";
import { isJsonObject, type Json } from "../json/index.ts";
import { ModelRegistry } from "../registry/service.ts";
import { bodyJson, controlPlane, handled, ifMatch, jsonReply, replyError } from "./http.ts";

const BASE = "/v9/management/grants";

const parseSubject = (value: Json | undefined): GrantSubject | undefined => {
  if (!isJsonObject(value)) return undefined;

  if (value.kind === "everyone") return { kind: "everyone" };

  if ((value.kind === "member" || value.kind === "team") && typeof value.id === "string")
    return { kind: value.kind, id: value.id };

  return undefined;
};

const parseScope = (value: Json | undefined): GrantScope | undefined => {
  if (!isJsonObject(value)) return undefined;

  if (value.kind === "all") return { kind: "all" };

  if (value.kind === "provider" && typeof value.provider === "string")
    return { kind: "provider", provider: value.provider };

  if (value.kind === "credential" && typeof value.id === "string")
    return { kind: "credential", id: value.id };

  return undefined;
};

/** The body as a grant's value; a field of the wrong type is `400 invalid body`. */
const parseValue = (body: Json): GrantValue | undefined => {
  if (!isJsonObject(body)) return undefined;
  const subject = parseSubject(body.subject);
  const scope = parseScope(body.scope);
  const { models } = body;

  if (subject === undefined || scope === undefined) return undefined;

  if (!Array.isArray(models) || !models.every((model) => typeof model === "string"))
    return undefined;

  return { subject, scope, models: models.filter((model) => typeof model === "string") };
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
  const wire = yield* controlPlane("grantEntries", (stub) => stub.grantEntries());

  return jsonReply(200, wire);
});

const create = Effect.gen(function* () {
  const grant = yield* value;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* controlPlane("writeGrant", (stub) =>
    stub.writeGrant({ revision: 0, value: grant }, principalId),
  );

  return yield* written(result);
});

const replace = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const grant = yield* value;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* controlPlane("writeGrant", (stub) =>
    stub.writeGrant({ id, revision, value: grant }, principalId),
  );

  return yield* written(result);
});

const remove = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const { principalId } = yield* AccessPrincipal;

  const result = yield* controlPlane("writeGrant", (stub) =>
    stub.writeGrant({ id, revision, value: null }, principalId),
  );

  return yield* written(result);
});

/** The models the caller may use: a fresh registry, so a grant just written shows on the next read. */
const mine = Effect.gen(function* () {
  const registry = yield* ModelRegistry;

  const snapshot = yield* registry.fresh.pipe(
    Effect.catch((error) =>
      Effect.logError(`models/mine: registry build failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "model registry unavailable"))),
      ),
    ),
  );

  const identity = yield* AccessPrincipal;

  const models = snapshot
    .visibleTo(identity.memberId)
    .availableModels()
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((model) => ({
      id: model.id,
      ...((model.displayName ?? "") === "" ? {} : { display_name: model.displayName }),
      owned_by: model.ownedBy,
      type: model.type,
    }));

  return jsonReply(200, { models });
});

export const myModelsHandler = handled(mine);

export const grantRoutes = [
  HttpRouter.route("GET", BASE, handled(list)),
  HttpRouter.route("POST", BASE, handled(create)),
  HttpRouter.route("PUT", `${BASE}/:id`, handled(replace)),
  HttpRouter.route("DELETE", `${BASE}/:id`, handled(remove)),
];
