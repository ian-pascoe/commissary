/**
 * Sign-up and suspension on Commissary Cloud (ADR 0026), as the gate (`hosted-gate.ts`) checks them on every request.
 *
 * A person who signs in for the first time without a membership gets a Personal org with them as its org owner; one
 * the index lists in some org was invited and gets none (the Platform registry decides, `PlatformStore.signIn`). A
 * suspended org or person is refused everywhere. Answers are cached per isolate for {@link STANDING_TTL_MS}, like
 * verified API keys (`api-key.ts`): a suspension applies within that time everywhere, and at once in the isolate
 * that made it (`forgetStanding`). New in the Workers port.
 */
import { Clock, Effect } from "effect";
import { ForbiddenError, InternalError, type OrgId } from "@commissary/core";
import { syncOrgIndex } from "./admission.ts";
import { AuthDirectory, type Standing } from "./directory.ts";

/** How long an isolate trusts a person's or an org's standing without asking the registry again. */
export const STANDING_TTL_MS = 30_000;

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
): Effect.Effect<void, ForbiddenError | InternalError, AuthDirectory> =>
  Effect.gen(function* () {
    const address = email.toLowerCase();
    const now = yield* Clock.currentTimeMillis;

    if (now < (signedUp.get(address) ?? 0)) return;
    signedUp.delete(address);
    const directory = yield* AuthDirectory;
    const state = yield* directory.signIn(address, now).pipe(Effect.mapError(unavailable));

    if (state.kind === "suspended") return yield* new ForbiddenError({ message: SUSPENDED });

    if (state.kind === "personal") {
      const org = state.org.id;

      const added = yield* directory
        .addMember(
          org,
          { email: address, role: "owner" },
          { role: "owner", sensitive: false },
          "sign-up",
        )
        .pipe(
          Effect.mapError((error) => new InternalError({ message: `sign-up: ${error.reason}` })),
        );

      // A retry after a failure further down finds them a member already.
      if (!added.ok && added.error !== "member_exists")
        return yield* new InternalError({ message: `sign-up: ${added.error}` });
      yield* syncOrgIndex(org);
      yield* directory.finishSignUp(address, now).pipe(Effect.mapError(unavailable));
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
): Effect.Effect<Standing, ForbiddenError | InternalError, AuthDirectory> =>
  Effect.gen(function* () {
    const key = `${org}\u0000${email?.toLowerCase() ?? ""}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = standings.get(key);

    const standing =
      cached !== undefined && now < cached.until
        ? cached.standing
        : yield* (yield* AuthDirectory).standing(org, email).pipe(Effect.mapError(unavailable));

    if (cached === undefined || now >= cached.until)
      remember(standings, key, { standing, until: now + STANDING_TTL_MS });

    if (standing.org === "suspended" || standing.person === "suspended")
      return yield* new ForbiddenError({ message: SUSPENDED });

    return standing;
  });
