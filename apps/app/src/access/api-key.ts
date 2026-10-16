/**
 * API keys on the client API (ADR 0022): which credential a client sent, and whether it is a live key of a member.
 * The credential sources follow the Go config access provider (`internal/access/config_access/provider.go`
 * `Authenticate`): `Authorization` (`Bearer` stripped), `x-goog-api-key`, `x-api-key`, `?key=` and `?auth_token=`.
 *
 * A key names its org (`api-keys/key.ts`), so verification asks that org's ControlPlane only, never another org's.
 * Before that, the Platform registry confirms that the org exists (at most every {@link VERIFIED_KEY_TTL_MS} per org
 * and isolate), so a made-up org id never instantiates a ControlPlane. Verified keys are cached per isolate for {@link VERIFIED_KEY_TTL_MS} (never past
 * the key's expiry), so a revoked key may keep working for that long in every isolate of every Worker: revocation clears no cache.
 */
import { Clock, Effect } from "effect";
import { InternalError, UnauthorizedError } from "../errors.ts";
import type { OrgRole } from "../members/roles.ts";
import { controlPlaneOf, type OrgId } from "../platform/org.ts";
import { platform } from "../platform/registry.ts";
import { looksLikeApiKey, parseApiKey } from "../api-keys/key.ts";
import { StateEnv } from "../state/env.ts";

/** How long a verified key is trusted without asking its ControlPlane again; revocation applies within this time. */
export const VERIFIED_KEY_TTL_MS = 30_000;

/** The most verified keys one isolate keeps; the oldest is dropped first. */
const MAX_CACHED_KEYS = 1024;

export interface PresentedCredentials {
  /** The first credential that is meant as an API key (`cms_…`), well formed or not. */
  readonly apiKey?: string;
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

  const apiKey = candidates.find(looksLikeApiKey);

  return { ...(apiKey === undefined ? {} : { apiKey }), any: candidates.length > 0 };
};

/** A live key and what the gate needs of its member. */
export interface VerifiedApiKey {
  readonly org: OrgId;
  readonly keyId: string;
  readonly memberId: string;
  readonly email: string;
  readonly role: OrgRole;
}

interface CachedKey {
  readonly key: VerifiedApiKey;
  /** Epoch ms after which the ControlPlane is asked again. */
  readonly until: number;
}

/** Verified keys by the SHA-256 of the whole key. */
const verified = new Map<string, CachedKey>();

/** Orgs the Platform registry confirmed, with the epoch ms until which the answer is trusted. */
const knownOrgs = new Map<OrgId, number>();

/** Empties the caches, for tests. */
export const resetApiKeyCaches = (): void => {
  verified.clear();
  knownOrgs.clear();
};

const invalid = new UnauthorizedError({ message: "Invalid API key" });

const unavailable = (cause: unknown) =>
  new InternalError({
    message: `API key verification: ${cause instanceof Error ? cause.message : "unknown error"}`,
  });

export const orgExists = Effect.fnUntraced(function* (org: OrgId, now: number) {
  if (now < (knownOrgs.get(org) ?? 0)) return true;

  const found = yield* platform("getOrgById", (stub) => stub.getOrgById(org)).pipe(
    Effect.mapError((error) => new InternalError({ message: error.message })),
  );

  if (found === undefined) {
    knownOrgs.delete(org);

    return false;
  }

  knownOrgs.set(org, now + VERIFIED_KEY_TTL_MS);

  return true;
});

/**
 * The live key behind `text`, or `Invalid API key` (401) for a malformed key, a key of an org that does not exist, an
 * unknown id, a wrong secret, a revoked or expired key and a key whose member left; the client cannot tell which.
 */
export const verifyApiKey: (
  text: string,
) => Effect.Effect<VerifiedApiKey, UnauthorizedError | InternalError, StateEnv> = Effect.fnUntraced(
  function* (text: string) {
    const parsed = parseApiKey(text);

    if (parsed === undefined) return yield* invalid;
    const now = yield* Clock.currentTimeMillis;
    const cached = verified.get(parsed.hash);

    if (cached !== undefined && now < cached.until) return cached.key;
    verified.delete(parsed.hash);

    if (!(yield* orgExists(parsed.org, now))) return yield* invalid;
    const env = yield* StateEnv;

    const verdict = yield* Effect.tryPromise({
      try: async () =>
        await controlPlaneOf(env, parsed.org).verifyApiKey(parsed.keyId, parsed.hash, now),
      catch: unavailable,
    });

    if (!verdict.ok) return yield* invalid;

    const key: VerifiedApiKey = {
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
  },
);
