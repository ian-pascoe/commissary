/**
 * Grants in selection (ADR 0021): the part of a route the caller's allowance reaches.
 *
 * A shared credential serves a caller only the upstream models their grants name. The route is narrowed to those
 * models (an alias pool loses its ungranted members; an alias that points at an ungranted model leaves nothing), and
 * a route with none left means the credential is not a candidate. A private credential belongs to its owner outright:
 * grants never apply to it.
 */
import type { Allowance } from "../../grants/allowance.ts";
import { type Credential, executorKey } from "../model.ts";
import type { ModelRoute } from "./routing.ts";

/**
 * `route` limited to what `allowance` permits on `credential`; `undefined` when nothing of it is permitted. A narrowed
 * alias pool stays a pool (`pooled`): its cooldown state is still tracked per upstream model.
 */
export const grantedRoute = (
  credential: Credential,
  route: ModelRoute,
  allowance: Allowance,
): ModelRoute | undefined => {
  if (credential.owner !== undefined) return route;
  const target = { id: credential.id, executor: executorKey(credential) };

  if (allowance.coversAll(target)) return route;
  const permitted = route.upstreamModels.filter((model) => allowance.permits(target, model));
  const [first] = permitted;

  if (first === undefined) return undefined;

  if (permitted.length === route.upstreamModels.length) return route;

  return { ...route, upstreamModel: first, upstreamModels: permitted, pooled: true };
};
