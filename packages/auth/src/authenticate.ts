/**
 * The two entry points of authentication (#132): {@link authenticateClient} for the client API and
 * {@link authenticateManagement} for the management API and the panel. Each picks the deployment's gate (ADR 0026): the
 * Access gate of a self-hosted Commissary (`access-gate.ts`) or the gate of Commissary Cloud (`hosted-gate.ts`).
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it. What a path needs
 * is the Worker's to say, since it owns the routes: the role a management request needs and the org its URL addresses
 * ({@link ManagementRoute}), and whether a request is for the client API at all. Cross-site checks (`csrf.ts`) come
 * before either.
 */
import { Effect } from "effect";
import type { CurrentOrg } from "@commissary/core";
import { accessGate } from "./access-gate.ts";
import type { AccessJwks } from "./access/jwks.ts";
import { AuthConfig } from "./config.ts";
import type { AuthDirectory } from "./directory.ts";
import type { AccessError, ManagementRoute } from "./gate.ts";
import { hostedClientGate, hostedManagementGate, type SignInSessions } from "./hosted-gate.ts";
import { isHosted } from "./mode.ts";
import type { AccessIdentity } from "./principal.ts";

/**
 * Authenticates a client API request (`/v1*`, …): an API key, or on a self-hosted Commissary an Access sign-in where
 * the org still takes them from clients. The identity's org is the key's, the request's `CurrentOrg` otherwise.
 */
export const authenticateClient = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks
> =>
  Effect.gen(function* () {
    return isHosted(yield* AuthConfig)
      ? yield* hostedClientGate(headers, requestUrl)
      : yield* accessGate(headers, requestUrl, undefined);
  });

/**
 * Authenticates a management request: a management key, or a person (an Access sign-in, a Commissary Cloud session),
 * or an Access service token on a self-hosted Commissary, with the role `route.needs` in the org `route.slug` addresses
 * (the request's `CurrentOrg` without one).
 */
export const authenticateManagement = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  route: ManagementRoute,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  Effect.gen(function* () {
    return isHosted(yield* AuthConfig)
      ? yield* hostedManagementGate(headers, requestUrl, route)
      : yield* accessGate(headers, requestUrl, route);
  });
