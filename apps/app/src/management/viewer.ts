/**
 * Who asks, as the credential ownership rules need it (ADR 0023): the member of the request and whether they are an
 * org admin. Every management route that touches credentials hands the viewer to the ControlPlane, which decides what
 * the caller reaches (`credentials/ownership.ts`).
 */
import { Effect } from "effect";
import { type AccessIdentity, AccessPrincipal } from "../access/principal.ts";
import type { Viewer } from "../credentials/ownership.ts";
import { roleAtLeast } from "../members/roles.ts";

export const viewerOf = (identity: AccessIdentity): Viewer => ({
  member: identity.memberId,
  admin: roleAtLeast(identity.role, "admin"),
});

/** The viewer of the current request. */
export const currentViewer: Effect.Effect<Viewer, never, AccessPrincipal> = Effect.gen(
  function* () {
    return viewerOf(yield* AccessPrincipal);
  },
);
