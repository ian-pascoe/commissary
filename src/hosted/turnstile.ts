/**
 * Cloudflare Turnstile on a hosted proxy (ADR 0026): a social sign-in starts only with a token the sign-in page's
 * widget issued, checked with Turnstile's siteverify API. Signing in is also signing up (a first sign-in creates the
 * person), so every start is guarded. New in the Workers port, no Go counterpart.
 */
import { Effect } from "effect";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The request header the sign-in page sends the widget's token in (Better Auth's captcha plugin uses the same). */
export const TURNSTILE_TOKEN_HEADER = "x-captcha-response";

/** Turnstile tokens are at most 2048 characters. */
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileOutcome = "passed" | "failed" | "unavailable";

/**
 * Asks siteverify whether `token` is a fresh token of the deployment's widget. `failed` for a missing, malformed, used
 * or expired token; `unavailable` when siteverify cannot be reached (the sign-in is refused either way).
 */
export const verifyTurnstile = (
  secret: string,
  token: string | undefined,
  remoteIp: string | undefined,
): Effect.Effect<TurnstileOutcome> => {
  const response = token?.trim() ?? "";

  if (response === "" || response.length > MAX_TOKEN_LENGTH) return Effect.succeed("failed");

  return Effect.tryPromise(async () => {
    const answer = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response,
        ...(remoteIp === undefined || remoteIp === "" ? {} : { remoteip: remoteIp }),
      }),
    });

    if (!answer.ok) return "unavailable" as const;
    // Only `success` is read; anything but `true` fails.
    const body = await answer.json<{ readonly success?: unknown }>();

    return body.success === true ? ("passed" as const) : ("failed" as const);
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Turnstile siteverify unreachable").pipe(Effect.as("unavailable" as const)),
    ),
  );
};
