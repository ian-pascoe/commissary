/**
 * Claude reset grants (`resetGrants` and `claimResetGrant` in @commissary/contract/credentials):
 * `GET /v9/management/credentials/reset-grants?auth_index=` reads an account's grants from Anthropic now;
 * `POST /v9/management/credentials/reset-grants/claim` `{auth_index}` spends one reset (src/quota/reset-grant-flow.ts).
 *
 * Workers addition, no Go counterpart: the upstream panel made these calls from the browser through Go's
 * `POST /requests/api-call`, which is not ported (see docs/ARCHITECTURE.md "Claude reset grants"). Tokens never leave
 * the server. Claim outcomes Anthropic answered (refusals included) are 200s carrying `outcome`; `502` means nothing
 * definite happened upstream (the status or organization could not be read, so nothing was sent), `409` that nothing
 * was sent because another claim of the account runs, an unanswered one cannot be resent, the status changed while it
 * was read, or the account is disabled.
 */
import { Effect } from "effect";
import type { Json } from "@commissary/json";
import {
  claimResetGrant,
  readResetGrants,
  type ResetGrantFailure,
} from "../quota/reset-grant-flow.ts";
import { handled, jsonReply, queryParams, type Reply, replyError } from "@commissary/core";
import { bodyObject } from "./http.ts";
import { currentViewer } from "@commissary/auth";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const failed = (failure: ResetGrantFailure): Reply => {
  switch (failure.kind) {
    case "not_found":
      return replyError(404, "auth file not found");
    case "unsupported":
      return replyError(
        422,
        `reset grants are only available for Claude accounts, not ${failure.provider}`,
      );
    case "unavailable":
      return replyError(502, failure.message);
    case "conflict":
      return replyError(409, failure.message);
  }
};

const controlPlaneDown = <A, R>(
  effect: Effect.Effect<A, { readonly operation: string; readonly message: string }, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logError(`management ${error.operation} failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
      ),
    ),
  );

const read = Effect.gen(function* () {
  const authIndex = (yield* queryParams).get("auth_index")?.trim() ?? "";

  if (authIndex === "") return yield* replyError(400, "auth_index is required");
  const viewer = yield* currentViewer;
  const result = yield* controlPlaneDown(readResetGrants({ authIndex }, viewer));

  if (result.kind !== "read") return yield* failed(result);

  return jsonReply(200, {
    status: "ok",
    grants: result.grants,
    ...(result.pending === undefined ? {} : { pending_claim: result.pending }),
  });
});

const claim = Effect.gen(function* () {
  const authIndex = text((yield* bodyObject).auth_index);

  if (authIndex === "") return yield* replyError(400, "auth_index is required");
  const viewer = yield* currentViewer;
  const result = yield* controlPlaneDown(claimResetGrant({ authIndex }, viewer));

  if (result.kind !== "claimed") return yield* failed(result);

  return jsonReply(200, {
    status: "ok",
    outcome: result.outcome,
    retried: result.retried,
    cooldown_cleared: result.cooldownCleared,
    ...(result.grants === undefined ? {} : { grants: result.grants }),
    ...(result.report === undefined ? {} : { report: result.report }),
    ...(result.pending === undefined ? {} : { pending_claim: result.pending }),
    ...(result.warning === undefined ? {} : { warning: result.warning }),
  });
});

/** Need an `HttpClient` (bound in `routes.ts`). */
export const resetGrantsHandler = handled(read);

export const claimResetGrantHandler = handled(claim);
