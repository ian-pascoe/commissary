// Mirrors CallerScope in sdk/cliproxy/session/identity.go (sha256 of a versioned prefix + caller credential).
// The Go `userApiKey` is replaced by the Cloudflare Access principal.
import { Context, Effect } from "effect";
import { GLOBAL_ORG, type OrgId } from "../platform/org.ts";

/** The authenticated caller: an Access user (email) or an Access service token (client id). */
export type Principal =
  | { readonly kind: "user"; readonly email: string; readonly sub: string }
  | { readonly kind: "service"; readonly commonName: string };

/** A verified principal plus the identifiers derived from it. */
export interface AccessIdentity {
  readonly principal: Principal;
  /** Stable text identity for usage records: `user:<lowercased email>` or `service:<common_name>`. */
  readonly principalId: string;
  /** Irreversible namespace used to isolate session state between callers (`callerScope(principalId, org)`). */
  readonly callerScope: string;
  /** The org the request is for: the org addressed by a management URL, otherwise the request's `CurrentOrg`. */
  readonly org: OrgId;
  /** The principal is a platform admin (`PLATFORM_ADMIN_*`, or the local dev bypass): it may manage every org. */
  readonly platformAdmin: boolean;
}

/**
 * The authenticated principal of the current request.
 *
 * Provided by the Access gate for every request under a protected prefix (see `access/routes.ts`); handlers for
 * `/v1*`, `/v1beta*`, `/openai/v1*`, `/backend-api/codex*` and `/v8/management*` can `yield* AccessPrincipal`.
 */
export class AccessPrincipal extends Context.Service<AccessPrincipal, AccessIdentity>()(
  "cf-llm-proxy/access/AccessPrincipal",
) {}

export const principalId = (principal: Principal): string =>
  principal.kind === "user"
    ? `user:${principal.email.toLowerCase()}`
    : `service:${principal.commonName}`;

const CALLER_SCOPE_PREFIX = "cli-proxy-api:caller-scope:v1\u0000";

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * `sha256("cli-proxy-api:caller-scope:v1\x00" + value)` as lowercase hex in the org `global` (like Go, so the sessions
 * from before orgs existed keep their scope), `sha256("cli-proxy-api:caller-scope:v1\x00org:<org>\x00" + value)` in
 * any other org (ADR 0021). Empty for a blank value (like Go).
 */
export const callerScope = (value: string, org: OrgId): Effect.Effect<string> => {
  const trimmed = value.trim();

  if (trimmed === "") return Effect.succeed("");
  const scoped = org === GLOBAL_ORG ? trimmed : `org:${org}\u0000${trimmed}`;

  return Effect.promise(async () =>
    toHex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CALLER_SCOPE_PREFIX + scoped)),
    ),
  );
};

/** The identity of `principal` in `org`; `platformAdmin` when it is on the platform admin lists. */
export const makeIdentity = (
  principal: Principal,
  org: OrgId,
  platformAdmin = false,
): Effect.Effect<AccessIdentity> =>
  Effect.gen(function* () {
    const id = principalId(principal);

    return {
      principal,
      principalId: id,
      callerScope: yield* callerScope(id, org),
      org,
      platformAdmin,
    };
  });
