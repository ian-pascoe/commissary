/**
 * Grants in the model registry (ADR 0023): which of a credential's models a member's reach reaches.
 *
 * The registry lists a model to a member only when selection could serve it: some upstream model the model resolves to
 * on that shared credential is granted to them. It asks selection's own routing (`resolveModelRoute`: prefix, alias
 * pool, exclusions), so a list and a pick never disagree. A private credential's models belong to its owner outright.
 */
import type { Config } from "../config/schema.ts";
import { sanitizeAliases } from "../credentials/derive.ts";
import { resolveModelRoute, type RoutingContext } from "../credentials/selection/routing.ts";
import type { Reach } from "../grants/reach.ts";
import type { ModelSource } from "./source.ts";

/** A restricted reach with the routing context its models resolve in. */
export interface GrantFilter {
  readonly reach: Reach;
  readonly routing: RoutingContext;
}

/** The filter of `reach` over `sources`; `undefined` when the reach is unrestricted (nothing to filter). */
export const grantFilter = (
  reach: Reach,
  config: Pick<Config, "oauth" | "routing">,
  sources: ReadonlyArray<ModelSource>,
): GrantFilter | undefined => {
  if (reach.unrestricted) return undefined;
  const oauthModelAlias: Record<string, ReturnType<typeof sanitizeAliases>> = {};

  for (const [channel, aliases] of Object.entries(config.oauth["model-alias"]))
    oauthModelAlias[channel.trim().toLowerCase()] = sanitizeAliases(aliases);

  const knownPrefixes = new Set<string>();

  for (const source of sources)
    if (!source.disabled && source.prefix !== undefined && source.prefix !== "")
      knownPrefixes.add(source.prefix);

  return {
    reach,
    routing: {
      forceModelPrefix: config.routing["force-model-prefix"],
      oauthModelAlias,
      knownPrefixes,
    },
  };
};

/** Whether the credential `source` may list `modelId` (as the registry names it) under `filter`. */
export const grantsReach = (
  filter: GrantFilter | undefined,
  source: ModelSource,
  modelId: string,
): boolean => {
  if (filter === undefined || source.owner !== undefined) return true;
  const target = { id: source.id, executor: source.executor };

  if (filter.reach.coversAll(target)) return true;
  const route = resolveModelRoute(source, modelId, filter.routing);

  return (
    route !== undefined &&
    route.upstreamModels.some((upstream) => filter.reach.permits(target, upstream))
  );
};
