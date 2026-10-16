/**
 * The management routes' JSON body readers that stay in the Worker (they return `@commissary/json` values). Replies,
 * the text and query readers and `handled` are `@commissary/core`; the ControlPlane calls (`controlPlane`,
 * `callControlPlane`) are `@commissary/state`.
 */
import { Effect } from "effect";
import { bodyText, replyError } from "@commissary/core";
import { isJsonObject, type Json } from "@commissary/json";

/** Request body parsed as JSON (any value); 400 `invalid body` otherwise. */
export const bodyJson = Effect.gen(function* () {
  const text = yield* bodyText;

  return yield* Effect.try({
    // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(400, "invalid body"),
  });
});

/** Request body parsed as a JSON object; 400 `invalid body` otherwise. */
export const bodyObject = bodyJson.pipe(
  Effect.flatMap((value) =>
    isJsonObject(value) ? Effect.succeed(value) : Effect.fail(replyError(400, "invalid body")),
  ),
);
