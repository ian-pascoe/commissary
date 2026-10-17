/**
 * Cloudflare Turnstile on Commissary Cloud (ADR 0026): a social sign-in starts only with a token the sign-in page's
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

/** How long siteverify may take before the sign-in is refused as `unavailable`. */
const SITEVERIFY_TIMEOUT_MS = 10_000;

/**
 * Asks siteverify whether `token` is a fresh token of the deployment's widget, solved on `hostname` (the app host, where
 * the sign-in page renders the widget, ADR 0030). `failed`
 * for a missing, malformed, used or expired token, or one solved on another site; `unavailable` when siteverify cannot be
 * reached in time (the sign-in is refused either way).
 */
export const verifyTurnstile = (
  secret: string,
  token: string | undefined,
  remoteIp: string | undefined,
  hostname: string,
): Effect.Effect<TurnstileOutcome> => {
  const response = token?.trim() ?? "";

  if (response === "" || response.length > MAX_TOKEN_LENGTH) return Effect.succeed("failed");

  return Effect.tryPromise(async () => {
    const answer = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      body: JSON.stringify({
        secret,
        response,
        ...(remoteIp === undefined || remoteIp === "" ? {} : { remoteip: remoteIp }),
      }),
    });

    if (!answer.ok) return "unavailable" as const;
    // Anything but `success: true` fails, and so does a token solved on another hostname (a widget's site key may be
    // shared by several hostnames).
    const body = await answer.json<{ readonly success?: unknown; readonly hostname?: unknown }>();
    const elsewhere = typeof body.hostname === "string" && body.hostname !== hostname;

    return body.success === true && !elsewhere ? ("passed" as const) : ("failed" as const);
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Turnstile siteverify unreachable").pipe(Effect.as("unavailable" as const)),
    ),
  );
};
