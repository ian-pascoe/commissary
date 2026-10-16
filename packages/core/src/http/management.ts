/**
 * Shared plumbing of the management routes: JSON replies, the early-exit `Reply`, request body and query readers, the
 * `If-Match` revision, and `handled`, which turns a handler's failures into responses.
 *
 * Go source: internal/api/handlers/management/handler.go (management middleware; its `X-CPA-*` headers are not ported)
 * and the `c.JSON(status, gin.H{"error": ...})` convention of every management handler.
 */
import { Data, Effect, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { causeSummary } from "../observability/cause.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Sent on every management response. Deviation from Go: no `X-CPA-Version` / `X-CPA-Support-Plugin` (the upstream panel read them). */
export const MANAGEMENT_HEADERS = {
  "cache-control": "no-store",
} as const;

export const jsonReply = <Body>(
  status: number,
  body: Body,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: JSON_CONTENT_TYPE });

/** An early exit with a ready response (the Effect failure channel of every management handler). */
export class Reply extends Data.TaggedError("Reply")<{
  readonly response: HttpServerResponse.HttpServerResponse;
}> {}

/** A JSON value in a reply's fields (core has no `@commissary/json`; its `Json` values are these). */
export type ReplyValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ReplyValue>
  | { readonly [key: string]: ReplyValue };

/** The fields an error reply adds next to `error`, such as `message`. */
export interface ReplyFields {
  readonly [field: string]: ReplyValue;
}

/** `{ error, ...extra }` with `status`. */
export const replyError = (status: number, error: string, extra: ReplyFields = {}): Reply =>
  new Reply({ response: jsonReply(status, { error, ...extra }) });

/** Request body as text; `invalid body` (400) when it cannot be read. */
export const bodyText = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  // `arrayBuffer` instead of `text`: workerd warns when `.text()` reads a non-text type such as application/yaml.
  const buffer = yield* request.arrayBuffer.pipe(
    Effect.mapError(() => replyError(400, "invalid body")),
  );

  return new TextDecoder().decode(buffer);
});

/**
 * Request body as text; `413 body_too_large` above `maxBytes`, `400 invalid body` when unreadable. A declared
 * `content-length` above the bound is refused before reading; otherwise (chunked bodies too) the stream is counted
 * while it is read and cancelled as soon as it passes the bound, so no more than `maxBytes` plus one chunk is held.
 */
export const boundedBodyText = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    const tooLarge = replyError(413, "body_too_large", {
      message: `the request body is larger than ${maxBytes} bytes`,
    });

    if (Number(request.headers["content-length"] ?? 0) > maxBytes) return yield* tooLarge;
    const decoder = new TextDecoder();
    let read = 0;
    let text = "";

    yield* request.stream.pipe(
      Stream.mapError(() => replyError(400, "invalid body")),
      Stream.runForEach((chunk) => {
        read += chunk.byteLength;

        if (read > maxBytes) return Effect.fail(tooLarge);
        text += decoder.decode(chunk, { stream: true });

        return Effect.void;
      }),
    );

    return text + decoder.decode();
  });

/**
 * The revision an entry edit is based on (`If-Match`: `"12"`, `W/"12"` or `12`; 0 for an entry not stored yet); an
 * absent or malformed header is `400 invalid_if_match`.
 */
export const ifMatch = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = request.headers["if-match"]?.trim() ?? "";
  const match = /^(?:W\/)?(?:"(\d{1,15})"|(\d{1,15}))$/.exec(raw);
  const digits = match?.[1] ?? match?.[2];

  if (digits === undefined) return yield* replyError(400, "invalid_if_match");

  return Number(digits);
});

/** Query parameters of the current request (first value wins). */
export const queryParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "http://localhost").searchParams;
});

/**
 * Turns a handler's failure channel into responses and adds the management headers. Unexpected defects are logged and
 * answered with 500 (never with details).
 */
export const handled = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((reply) => Effect.succeed(reply.response)),
    Effect.catchCause((cause) =>
      Effect.logError(`management handler failed: ${causeSummary(cause)}`).pipe(
        Effect.as(jsonReply(500, { error: "internal error" })),
      ),
    ),
    Effect.map((response) => HttpServerResponse.setHeaders(response, MANAGEMENT_HEADERS)),
  );
