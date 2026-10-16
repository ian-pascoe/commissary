/**
 * The per-org request rate limit of Commissary Cloud's client API (ADR 0026): the Workers rate-limiting binding
 * `ORG_RATE_LIMIT`, keyed by the org of the API key, so one org's traffic never slows another's. The deployment sets
 * the limit (requests per {@link RATE_LIMIT_PERIOD_SECONDS}, `alchemy.run.ts`). The binding counts per Cloudflare
 * location and is eventually consistent: a ceiling against abuse, not exact accounting. New in the Workers port.
 */
import { Effect } from "effect";
import { RateLimitedError, type OrgId } from "@commissary/core";
import { AuthConfig } from "./config.ts";

/** The binding's period: the limit counts requests per minute. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const RATE_LIMITED = "Rate limit exceeded";

/**
 * Counts a request of `org`; over the limit, `429 Rate limit exceeded` with `Retry-After`. A deployment without the
 * binding has no limit; a failing binding lets the request through (logged), since refusing every org would be worse.
 */
export const limitOrgRate = (org: OrgId): Effect.Effect<void, RateLimitedError, AuthConfig> =>
  Effect.gen(function* () {
    const { ORG_RATE_LIMIT: limiter } = yield* AuthConfig;

    if (limiter === undefined) return;

    const outcome = yield* Effect.tryPromise(async () => await limiter.limit({ key: org })).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`rate limit not checked: ${error.message}`).pipe(
          Effect.as({ success: true }),
        ),
      ),
    );

    if (!outcome.success)
      return yield* new RateLimitedError({
        message: RATE_LIMITED,
        retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS,
      });
  });
