/**
 * The Worker's side of membership (ADR 0022): admitting a principal into an org through the org's ControlPlane, and
 * keeping the Platform registry's index (which orgs each person and service token belong to) in step with it. New in
 * the Workers port, no Go counterpart.
 *
 * The ControlPlane is authoritative and checked on every request, so a removed member loses access on their next
 * request. The registry's index only lists the orgs of a caller (the panel's org switcher): after a change the
 * ControlPlane marks it stale, and {@link syncOrgIndex} pushes the org's lists to the registry, then tells the
 * ControlPlane which change the registry holds. A failed push is logged and retried with the next change or admission.
 */
import { Data, Effect } from "effect";
import type { Principal } from "../access/principal.ts";
import { WorkerEnv } from "../platform/env.ts";
import { controlPlaneOf, type OrgId } from "../platform/org.ts";
import { platformOf } from "../platform/registry.ts";
import type { Admission, PrincipalRef } from "./store.ts";

/** The org's ControlPlane could not be asked; the message names the call. */
export class MembershipUnavailable extends Data.TaggedError("MembershipUnavailable")<{
  readonly message: string;
}> {}

const failure = (label: string) => (cause: unknown) =>
  new MembershipUnavailable({
    message: `${label}: ${cause instanceof Error ? cause.message : "unknown error"}`,
  });

export const principalRef = (principal: Principal): PrincipalRef =>
  principal.kind === "user"
    ? { kind: "user", email: principal.email }
    : { kind: "service", clientId: principal.commonName };

/**
 * Pushes the org's members and service tokens to the Platform registry when its index is behind; never fails (a
 * failure is logged, the next change or admission tries again).
 */
export const syncOrgIndex = (org: OrgId): Effect.Effect<void, never, WorkerEnv> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const stub = controlPlaneOf(env, org);

    const index = yield* Effect.tryPromise({
      try: async () => await stub.membershipIndex(),
      catch: failure("membershipIndex"),
    });

    if (index.synced) return;

    const repaired = yield* Effect.tryPromise({
      try: async () =>
        await platformOf(env).replaceOrgIndex(org, {
          emails: index.emails,
          serviceTokens: index.serviceTokens,
        }),
      catch: failure("replaceOrgIndex"),
    });

    if (!repaired.ok)
      return yield* Effect.logWarning("membership index not synced: the registry refused it").pipe(
        Effect.annotateLogs({ org }),
      );

    if (repaired.conflicts.length > 0)
      yield* Effect.logWarning("service tokens registered to another org were not indexed").pipe(
        Effect.annotateLogs({ org, tokens: repaired.conflicts.length }),
      );

    yield* Effect.tryPromise({
      try: async () => await stub.markIndexSynced(index.counter),
      catch: failure("markIndexSynced"),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`membership index not synced: ${error.message}`).pipe(
        Effect.annotateLogs({ org }),
      ),
    ),
  );

/**
 * The role of `principal` in `org`, `undefined` when it has none. With `autoJoin`, a person joins an org that has
 * auto-join on (on for `global`) as a plain member on their first request.
 */
export const admitPrincipal = (
  org: OrgId,
  principal: Principal,
  autoJoin = true,
): Effect.Effect<Admission | undefined, MembershipUnavailable, WorkerEnv> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    const admission = yield* Effect.tryPromise({
      try: async () => await controlPlaneOf(env, org).admit(principalRef(principal), autoJoin),
      catch: failure("admit"),
    });

    if (admission?.indexStale === true) yield* syncOrgIndex(org);

    return admission;
  });
