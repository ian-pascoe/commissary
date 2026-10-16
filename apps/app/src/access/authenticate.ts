/**
 * Authentication of one request of a zone: `@commissary/auth`'s entry points with what the Worker's routes say of the
 * request: the client API (`authenticateClient`), or the management API and the panel (`authenticateManagement`) with
 * the role the route needs (`management/policy.ts`) and the org its URL addresses (`management/zones.ts`). New in the
 * Workers port.
 */
import {
  type AccessError,
  type AccessIdentity,
  type AccessJwks,
  type AuthConfig,
  type AuthDirectory,
  authenticateClient,
  authenticateManagement,
  type SignInSessions,
} from "@commissary/auth";
import type { CurrentOrg } from "@commissary/core";
import type { Effect } from "effect";
import { routeAccess } from "../management/policy.ts";
import { type AccessZone, scopedUrl } from "../management/zones.ts";

/**
 * Authenticates a request for `zone` (`method` decides, with the path, the role a management request needs). `headers`
 * must expose lowercased header names; `requestUrl` is the full URL as the client sent it.
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
  method = "GET",
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  zone === "protected"
    ? authenticateClient(headers, requestUrl)
    : authenticateManagement(headers, requestUrl, {
        needs: routeAccess(method, requestUrl, zone),
        slug: scopedUrl(requestUrl)?.slug,
      });
