/**
 * Proxy keys on the proxy routes (ADR 0022): which credential a client sent, and whether it is a live key of a member.
 * The credential sources follow the Go config access provider (`internal/access/config_access/provider.go`
 * `Authenticate`): `Authorization` (`Bearer` stripped), `x-goog-api-key`, `x-api-key`, `?key=` and `?auth_token=`.
 *
 * A key names its org (`proxy-keys/key.ts`), so verification asks that org's ControlPlane only, never another org's.
 * Before that, the Platform registry confirms that the org exists (once per org and isolate), so a made-up org id
 * never instantiates a ControlPlane. Verified keys are cached per isolate for {@link VERIFIED_KEY_TTL_MS} (never past
 * the key's expiry), so a revocation applies within that time everywhere, and at once in the isolate that revoked it.
 */
import { Clock, Effect } from "effect";
import { InternalError, UnauthorizedError } from "../errors.ts";
import type { OrgRole } from "../members/roles.ts";
import { WorkerEnv } from "../platform/env.ts";
import { controlPlaneOf, type OrgId } from "../platform/org.ts";
import { platform } from "../platform/registry.ts";
import { looksLikeProxyKey, parseProxyKey } from "../proxy-keys/key.ts";

/** How long a verified key is trusted without asking its ControlPlane again; revocation applies within this time. */
export const VERIFIED_KEY_TTL_MS = 30_000;

/** The most verified keys one isolate keeps; the oldest is dropped first. */
const MAX_CACHED_KEYS = 1024;

export interface PresentedCredentials {
  /** The first credential that is meant as a proxy key (`cfp_…`), well formed or not. */
  readonly proxyKey?: string;
  /** Whether the client sent any credential at all (an old shared key such as `sk-dummy` counts). */
  readonly any: boolean;
}

const bearer = (header: string): string => {
  const [scheme, ...rest] = header.split(" ");

  return rest.length > 0 && scheme?.toLowerCase() === "bearer" ? rest.join(" ").trim() : header;
};

/** The client credentials of a request, in the order the Go provider checks them. */
export const presentedCredentials = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
): PresentedCredentials => {
  const query = URL.canParse(requestUrl) ? new URL(requestUrl).searchParams : undefined;

  const candidates = [
    bearer(headers["authorization"] ?? ""),
    headers["x-goog-api-key"] ?? "",
    headers["x-api-key"] ?? "",
    query?.get("key") ?? "",
    query?.get("auth_token") ?? "",
  ].flatMap((value) => {
    const trimmed = value.trim();

    return trimmed === "" ? [] : [trimmed];
  });

  const proxyKey = candidates.find(looksLikeProxyKey);

  return { ...(proxyKey === undefined ? {} : { proxyKey }), any: candidates.length > 0 };
};

/** A live key and what the gate needs of its member. */
export interface VerifiedProxyKey {
  readonly org: OrgId;
  readonly keyId: string;
  readonly memberId: string;
  readonly email: string;
  readonly role: OrgRole;
}

interface CachedKey {
  readonly key: VerifiedProxyKey;
  /** Epoch ms after which the ControlPlane is asked again. */
  readonly until: number;
}

/** Verified keys by the SHA-256 of the whole key. */
const verified = new Map<string, CachedKey>();

/** Orgs the Platform registry confirmed; orgs are never deleted, so the answer stays true. */
const knownOrgs = new Set<OrgId>();

/** Forgets a revoked key in this isolate, so it is refused here at once. */
export const forgetVerifiedProxyKey = (keyId: string): void => {
  for (const [hash, cached] of verified) if (cached.key.keyId === keyId) verified.delete(hash);
};

/** Forgets the keys of a member who left the org, so this isolate refuses them at once. */
export const forgetVerifiedProxyKeysOf = (org: OrgId, memberId: string): void => {
  for (const [hash, cached] of verified)
    if (cached.key.org === org && cached.key.memberId === memberId) verified.delete(hash);
};

/** Empties the caches, for tests. */
export const resetProxyKeyCaches = (): void => {
  verified.clear();
  knownOrgs.clear();
};

const invalid = new UnauthorizedError({ message: "Invalid API key" });

const unavailable = (cause: unknown) =>
  new InternalError({
    message: `proxy key verification: ${cause instanceof Error ? cause.message : "unknown error"}`,
  });

const orgExists = (org: OrgId) =>
  Effect.gen(function* () {
    if (knownOrgs.has(org)) return true;

    const found = yield* platform("getOrgById", (stub) => stub.getOrgById(org)).pipe(
      Effect.mapError((error) => new InternalError({ message: error.message })),
    );

    if (found === undefined) return false;
    knownOrgs.add(org);

    return true;
  });

/**
 * The live key behind `text`, or `Invalid API key` (401) for a malformed key, a key of an org that does not exist, an
 * unknown id, a wrong secret, a revoked or expired key and a key whose member left; the client cannot tell which.
 */
export const verifyProxyKey = (
  text: string,
): Effect.Effect<VerifiedProxyKey, UnauthorizedError | InternalError, WorkerEnv> =>
  Effect.gen(function* () {
    const parsed = parseProxyKey(text);

    if (parsed === undefined) return yield* invalid;
    const now = yield* Clock.currentTimeMillis;
    const cached = verified.get(parsed.hash);

    if (cached !== undefined && now < cached.until) return cached.key;
    verified.delete(parsed.hash);

    if (!(yield* orgExists(parsed.org))) return yield* invalid;
    const env = yield* WorkerEnv;

    const verdict = yield* Effect.tryPromise({
      try: async () =>
        await controlPlaneOf(env, parsed.org).verifyProxyKey(parsed.keyId, parsed.hash, now),
      catch: unavailable,
    });

    if (!verdict.ok) return yield* invalid;

    const key: VerifiedProxyKey = {
      org: parsed.org,
      keyId: parsed.keyId,
      memberId: verdict.memberId,
      email: verdict.email,
      role: verdict.role,
    };

    if (verified.size >= MAX_CACHED_KEYS) {
      const oldest = verified.keys().next();

      if (oldest.done !== true) verified.delete(oldest.value);
    }

    verified.set(parsed.hash, {
      key,
      until: Math.min(now + VERIFIED_KEY_TTL_MS, verdict.expiresAt ?? Number.POSITIVE_INFINITY),
    });

    return key;
  });
