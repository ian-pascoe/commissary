/**
 * Admitting a principal into an org through the org's ControlPlane (ADR 0022), and keeping the Platform registry's
 * index (which orgs each person and service token belong to) in step with it, both through `AuthDirectory`. New in the
 * Workers port, no Go counterpart.
 *
 * The ControlPlane is authoritative and checked on every request, so a removed member loses access on their next
 * request. The registry's index only lists the orgs of a caller (the panel's org switcher): after a change the
 * ControlPlane marks it stale, and {@link syncOrgIndex} pushes the org's lists to the registry, then tells the
 * ControlPlane which change the registry holds. A failed push is logged and retried with the next change or admission.
 */
import { Effect } from "effect";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";
import { AuthConfig } from "./config.ts";
import {
  type Admission,
  AuthDirectory,
  type ClientsUseApiKeys,
  type DirectoryUnavailable,
  type PrincipalRef,
} from "./directory.ts";
import { isHosted } from "./mode.ts";
import type { AdmissiblePrincipal } from "./principal.ts";

export const principalRef = (principal: AdmissiblePrincipal): PrincipalRef =>
  principal.kind === "service"
    ? { kind: "service", clientId: principal.commonName }
    : { kind: "user", email: principal.email };

/**
 * Pushes the org's members and service tokens to the Platform registry when its index is behind; never fails (a
 * failure is logged, the next change or admission tries again).
 */
export const syncOrgIndex = (org: OrgId): Effect.Effect<void, never, AuthDirectory> =>
  Effect.gen(function* () {
    const directory = yield* AuthDirectory;
    const index = yield* directory.membershipIndex(org);

    if (index.synced) return;

    const repaired = yield* directory.replaceOrgIndex(org, {
      emails: index.emails,
      serviceTokens: index.serviceTokens,
    });

    if (!repaired.ok)
      return yield* Effect.logWarning("membership index not synced: the registry refused it").pipe(
        Effect.annotateLogs({ org }),
      );

    if (repaired.conflicts.length > 0)
      yield* Effect.logWarning("service tokens registered to another org were not indexed").pipe(
        Effect.annotateLogs({ org, tokens: repaired.conflicts.length }),
      );

    yield* directory.markIndexSynced(org, index.counter);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`membership index not synced: ${error.message}`).pipe(
        Effect.annotateLogs({ org }),
      ),
    ),
  );

/**
 * The role of `principal` in `org`, `undefined` when it has none. With `autoJoin`, a person joins an org that has
 * auto-join on (on for `global`) as a plain member on their first request; on Commissary Cloud (ADR 0026) nobody joins
 * `global` that way, even where its setting is still on from a self-hosted past. `client`: the request is for the client
 * API, which takes an Access sign-in only while the org accepts them there (`ClientsUseApiKeys` otherwise).
 */
export const admitPrincipal = (
  org: OrgId,
  principal: AdmissiblePrincipal,
  autoJoin = true,
  client = false,
): Effect.Effect<
  Admission | ClientsUseApiKeys | undefined,
  DirectoryUnavailable,
  AuthConfig | AuthDirectory
> =>
  Effect.gen(function* () {
    const joins = autoJoin && !(org === GLOBAL_ORG && isHosted(yield* AuthConfig));
    const directory = yield* AuthDirectory;
    const admission = yield* directory.admit(org, principalRef(principal), joins, client);

    if (admission !== undefined && "indexStale" in admission && admission.indexStale)
      yield* syncOrgIndex(org);

    return admission;
  });
