/**
 * Sign-up and suspension on Commissary Cloud (ADR 0026), as the gate (`gate.ts`) checks them on every request.
 *
 * A person who signs in for the first time without a membership gets a Personal org with them as its org owner; one
 * the index lists in some org was invited and gets none (the Platform registry decides, `PlatformStore.signIn`). A
 * suspended org or person is refused everywhere. Answers are cached per isolate for {@link STANDING_TTL_MS}, like
 * verified API keys (`access/api-key.ts`): a suspension applies within that time everywhere, and at once in the
 * isolate that made it (`forgetStanding`). New in the Workers port.
 */
import { Clock, Effect } from "effect";
import { ForbiddenError, InternalError, type OrgId } from "@commissary/core";
import { syncOrgIndex } from "../members/admission.ts";
import { controlPlaneOf } from "../platform/org.ts";
import { platform } from "../platform/registry.ts";
import type { Standing } from "../platform/registry-store.ts";
import { StateEnv } from "../state/env.ts";

/** How long an isolate trusts a person's or an org's standing without asking the registry again. */
export const STANDING_TTL_MS = 30_000;

/** The owned-org limit when the deployment sets none (`OWNED_ORG_LIMIT`). */
export const DEFAULT_OWNED_ORG_LIMIT = 3;

/** The deployment's owned-org limit: `OWNED_ORG_LIMIT` when it is a whole number from 0, the default otherwise. */
export const ownedOrgLimit = (env: { readonly OWNED_ORG_LIMIT?: string | undefined }): number => {
  const value = Number((env.OWNED_ORG_LIMIT ?? "").trim());

  return (env.OWNED_ORG_LIMIT ?? "").trim() !== "" && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_OWNED_ORG_LIMIT;
};

/** People known to be signed up and not suspended, until the epoch ms. */
const signedUp = new Map<string, number>();

/** Standings by `<org>\u0000<email>`, until the epoch ms. */
const standings = new Map<string, { readonly standing: Standing; readonly until: number }>();

const MAX_CACHED = 4096;

const remember = <V>(cache: Map<string, V>, key: string, value: V): void => {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next();

    if (oldest.done !== true) cache.delete(oldest.value);
  }

  cache.set(key, value);
};

/** Forgets what this isolate knows of a person or an org, after a platform admin changed it. */
export const forgetStanding = (change: { readonly email?: string; readonly org?: OrgId }): void => {
  if (change.email !== undefined) signedUp.delete(change.email.toLowerCase());

  for (const key of standings.keys()) {
    const [org, email] = key.split("\u0000");

    if (
      (change.org !== undefined && org === change.org) ||
      (change.email !== undefined && email === change.email.toLowerCase())
    )
      standings.delete(key);
  }
};

/** Empties the caches, for tests. */
export const resetStandingCaches = (): void => {
  signedUp.clear();
  standings.clear();
};

const unavailable = (error: { readonly message: string }) =>
  new InternalError({ message: error.message });

export const SUSPENDED = "Suspended";

/**
 * Signs up a person who signed in with a verified email, once: an invited person is signed up as they are, anyone
 * else becomes the org owner of a new Personal org first. A suspended person is refused (403).
 */
export const ensureSignedUp = (
  email: string,
): Effect.Effect<void, ForbiddenError | InternalError, StateEnv> =>
  Effect.gen(function* () {
    const address = email.toLowerCase();
    const now = yield* Clock.currentTimeMillis;

    if (now < (signedUp.get(address) ?? 0)) return;
    signedUp.delete(address);

    const state = yield* platform("signIn", (stub) => stub.signIn(address, now)).pipe(
      Effect.mapError(unavailable),
    );

    if (state.kind === "suspended") return yield* new ForbiddenError({ message: SUSPENDED });

    if (state.kind === "personal") {
      const env = yield* StateEnv;
      const org = state.org.id;

      const added = yield* Effect.tryPromise({
        try: async () =>
          await controlPlaneOf(env, org).addMember(
            { email: address, role: "owner" },
            { role: "owner", sensitive: false },
            "sign-up",
          ),
        catch: (cause) =>
          new InternalError({
            message: `sign-up: ${cause instanceof Error ? cause.message : "unknown error"}`,
          }),
      });

      // A retry after a failure further down finds them a member already.
      if (!added.ok && added.error !== "member_exists")
        return yield* new InternalError({ message: `sign-up: ${added.error}` });
      yield* syncOrgIndex(org);
      yield* platform("finishSignUp", (stub) => stub.finishSignUp(address, now)).pipe(
        Effect.mapError(unavailable),
      );
      yield* Effect.logInfo("signed up with a Personal org").pipe(Effect.annotateLogs({ org }));
    }

    remember(signedUp, address, now + STANDING_TTL_MS);
  });

/**
 * Where `org` and the person with `email` stand (cached); refuses (403 `Suspended`) a suspended org or person. A
 * missing org is left to the caller.
 */
export const requireStanding = (
  org: OrgId,
  email: string | undefined,
): Effect.Effect<Standing, ForbiddenError | InternalError, StateEnv> =>
  Effect.gen(function* () {
    const key = `${org}\u0000${email?.toLowerCase() ?? ""}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = standings.get(key);

    const standing =
      cached !== undefined && now < cached.until
        ? cached.standing
        : yield* platform("standing", (stub) => stub.standing(org, email)).pipe(
            Effect.mapError(unavailable),
          );

    if (cached === undefined || now >= cached.until)
      remember(standings, key, { standing, until: now + STANDING_TTL_MS });

    if (standing.org === "suspended" || standing.person === "suspended")
      return yield* new ForbiddenError({ message: SUSPENDED });

    return standing;
  });
