/**
 * What the future `@commissary/models` package reads from a Worker's env (#134 "How packages get their bindings"). Each
 * Worker provides its own `env` as {@link ModelsEnv}. Models types `CONTROL_PLANE` through the methods it calls
 * ({@link ModelsControlPlane}); the ControlPlane split replaces them with the Models part's getter.
 */
import { Context, Effect } from "effect";
import type { ControlPlane } from "../credentials/control-plane.ts";
import { type Reply, CurrentOrg } from "@commissary/core";
import { callControlPlane } from "../management/http.ts";
import { controlPlaneOf } from "../platform/org.ts";
import type { SessionState } from "../session-state/durable-object.ts";

/** The ControlPlane methods Models calls: config, credentials, selection, refresh, quota, grants, spend, OAuth. */
type ModelsControlPlaneMethod =
  | "getConfig"
  | "configEntries"
  | "priceOverrideEntries"
  | "writePriceOverride"
  | "writeSettings"
  | "writeChannelRule"
  | "writeKeyGroup"
  | "importConfig"
  | "spendOverview"
  | "createSpendLimit"
  | "updateSpendLimit"
  | "removeSpendLimit"
  | "setSpendSettings"
  | "grantEntries"
  | "writeGrant"
  | "grantTable"
  | "pick"
  | "report"
  | "listModelSources"
  | "planRetry"
  | "importAuthFile"
  | "removeCredentials"
  | "refreshNow"
  | "ensureFresh"
  | "sweepRefresh"
  | "refreshDevinStatus"
  | "patchCredentialMetadata"
  | "listCredentialEntries"
  | "isConfigKey"
  | "credentialAccess"
  | "getCredentialFile"
  | "patchCredentialFields"
  | "setCredentialDisabledByRef"
  | "providerKeysView"
  | "privateKeyConfig"
  | "writePrivateKeyGroup"
  | "credentialIdOfAuthIndex"
  | "providerKeyProbeTarget"
  | "resetCredentialCooldown"
  | "refreshCredential"
  | "refreshAllCredentials"
  | "batchCredentials"
  | "quotaProbeTarget"
  | "recordQuotaReport"
  | "resetGrantTarget"
  | "recordResetGrantStatus"
  | "beginResetGrantClaim"
  | "settleResetGrantClaim"
  | "quotaCheckTargets"
  | "takeQuotaSweepLease"
  | "renewQuotaSweepLease"
  | "releaseQuotaSweepLease"
  | "oauthStart"
  | "oauthStatus"
  | "oauthCallback"
  | "oauthCancel";

/** Models' view of an org's ControlPlane: the methods it calls. */
export type ModelsControlPlane = Pick<ControlPlane, ModelsControlPlaneMethod> &
  Rpc.DurableObjectBranded;

export type ModelsControlPlaneStub = DurableObjectStub<ModelsControlPlane>;

export interface ModelsBindings {
  /** Model catalogs, signature cache, Antigravity state and client versions (Workers KV). */
  readonly CACHE: KVNamespace;
  /** Usage records (D1); schema in `migrations/`. */
  readonly USAGE: D1Database;
  /** Short-lived session state (Antigravity credit probes, `executor/antigravity/state.ts`). */
  readonly SESSION_STATE: DurableObjectNamespace<SessionState>;
  /** One ControlPlane per org, seen through {@link ModelsControlPlane}. */
  readonly CONTROL_PLANE: DurableObjectNamespace<ModelsControlPlane>;
  /** Secret HMAC key of `auth_index` (`management/auth-index.ts`). Empty fails closed. */
  readonly AUTH_INDEX_KEY: string;
  /** Overrides the Meta key-mint endpoint (empty: default); read by the ControlPlane's Models part (refresh, OAuth). */
  readonly META_MINT_URL: string;
}

/**
 * The Models bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class ModelsEnv extends Context.Service<ModelsEnv, ModelsBindings>()(
  "commissary/models/ModelsEnv",
) {}

/** The ControlPlane of the current org, seen through {@link ModelsControlPlane}. */
export const currentModelsControlPlane: Effect.Effect<
  ModelsControlPlaneStub,
  never,
  ModelsEnv | CurrentOrg
> = Effect.gen(function* () {
  return controlPlaneOf(yield* ModelsEnv, yield* CurrentOrg);
});

/** Calls the current org's ControlPlane from a Models management route (`callControlPlane`). */
export const modelsControlPlane = <R>(
  label: string,
  call: (stub: ModelsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, ModelsEnv | CurrentOrg> =>
  Effect.flatMap(currentModelsControlPlane, (stub) => callControlPlane(label, stub, call));
