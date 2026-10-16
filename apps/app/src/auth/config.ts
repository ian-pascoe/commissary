/**
 * What the future `@commissary/auth` package reads from a Worker's env (#132, #134 "How packages get their bindings"):
 * the Access team domain and audience, the platform admin lists, the dev bypass, the hosted mode and the per-org rate
 * limiter. Each Worker provides its own `env` as {@link AuthConfig}; the variables are parsed where they are read
 * (`access/config.ts`), per request, so a missing setting still fails closed there.
 *
 * Until the `AuthDirectory` service exists, the auth code that calls the ControlPlane or the Platform registry reaches
 * them through `StateEnv` (`state/env.ts`).
 */
import { Context } from "effect";

export interface AuthBindings {
  /** Access team name or domain (`myteam`, `myteam.cloudflareaccess.com`); empty fails closed. */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** Comma separated Access application AUD tags; empty fails closed. */
  readonly ACCESS_AUD: string;
  /** Comma separated platform admin emails. */
  readonly PLATFORM_ADMIN_EMAILS: string;
  /** Comma separated platform admin service token Client IDs. */
  readonly PLATFORM_ADMIN_SERVICE_TOKENS: string;
  /** Local development only: treats loopback requests as this admin. */
  readonly ACCESS_DEV_BYPASS: string;
  /** `cloud`: Commissary Cloud (`hosted/mode.ts`); unset or `self-hosted`: Cloudflare Access. */
  readonly COMMISSARY_MODE?: string;
  /** Hosted: the per-org request rate limit of the client API (`hosted/rate-limit.ts`). */
  readonly ORG_RATE_LIMIT?: RateLimit;
}

/** The auth settings of the current Worker invocation, provided per request (`requestContext`). */
export class AuthConfig extends Context.Service<AuthConfig, AuthBindings>()(
  "commissary/auth/AuthConfig",
) {}
