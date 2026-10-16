/**
 * Better Auth's database for Commissary Cloud with per-org single sign-on (issue #76): D1 for people, sessions and
 * verification records, while the SSO plugin's `ssoProvider` model is answered from the orgs' ControlPlanes (an
 * identity provider lives with its org, its secret sealed there: `sso/store.ts`). New in the Workers port.
 *
 * The plugin reads a provider by its id (`sso-<org id>`) on every step of a sign-in; any other read of the model finds
 * nothing, so a sign-in can only start from a provider id the Worker chose (`routes.ts`). Nothing writes the model:
 * the routes that would (registering a provider, verifying its domain through Better Auth) are not passed on.
 */
import type { DBAdapter, DBTransactionAdapter, Where } from "@better-auth/core/db/adapter";
import type { BetterAuthSsoProvider } from "../sso/provider.ts";

/** The plugin's model name for identity providers. */
export const SSO_PROVIDER_MODEL = "ssoProvider";

/** Finds the provider with this id, `undefined` when there is none (or it cannot be used). */
export type ProviderLookup = (providerId: string) => Promise<BetterAuthSsoProvider | undefined>;

const providerIdOf = (where: ReadonlyArray<Where>): string | undefined => {
  const [only] = where;

  return where.length === 1 &&
    only !== undefined &&
    only.field === "providerId" &&
    (only.operator ?? "eq") === "eq" &&
    typeof only.value === "string"
    ? only.value
    : undefined;
};

const refuseWrite = (): never => {
  throw new Error("identity providers are set through the management API, not Better Auth");
};

/** `adapter` with the `ssoProvider` model answered by `lookup`. */
const withProviders = <A extends DBTransactionAdapter>(adapter: A, lookup: ProviderLookup): A => ({
  ...adapter,
  findOne: async <T>(data: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> => {
    if (data.model !== SSO_PROVIDER_MODEL) return adapter.findOne<T>(data);
    const providerId = providerIdOf(data.where);

    if (providerId === undefined) return null;
    // SAFETY: the plugin reads `ssoProvider` rows as `BetterAuthSsoProvider` (its own row shape, `sso/provider.ts`).
    const found = (await lookup(providerId)) as T | undefined;

    return found ?? null;
  },
  findMany: async <T>(data: Parameters<DBAdapter["findMany"]>[0]): Promise<T[]> =>
    data.model === SSO_PROVIDER_MODEL ? [] : adapter.findMany<T>(data),
  count: async (data: Parameters<DBAdapter["count"]>[0]): Promise<number> =>
    data.model === SSO_PROVIDER_MODEL ? 0 : adapter.count(data),
  create: async (data) =>
    data.model === SSO_PROVIDER_MODEL ? refuseWrite() : adapter.create(data),
  update: async <T>(data: Parameters<DBAdapter["update"]>[0]): Promise<T | null> =>
    data.model === SSO_PROVIDER_MODEL ? refuseWrite() : adapter.update<T>(data),
  updateMany: async (data: Parameters<DBAdapter["updateMany"]>[0]): Promise<number> =>
    data.model === SSO_PROVIDER_MODEL ? refuseWrite() : adapter.updateMany(data),
  delete: async <T>(data: Parameters<DBAdapter["delete"]>[0]): Promise<void> =>
    data.model === SSO_PROVIDER_MODEL ? refuseWrite() : adapter.delete<T>(data),
  deleteMany: async (data: Parameters<DBAdapter["deleteMany"]>[0]): Promise<number> =>
    data.model === SSO_PROVIDER_MODEL ? refuseWrite() : adapter.deleteMany(data),
});

/** `base` (Better Auth's D1 adapter) with identity providers from `lookup`, also inside its transactions. */
export const ssoAwareAdapter = (base: DBAdapter, lookup: ProviderLookup): DBAdapter => ({
  ...withProviders(base, lookup),
  transaction: async (callback) =>
    base.transaction(async (trx) => callback(withProviders(trx, lookup))),
});
