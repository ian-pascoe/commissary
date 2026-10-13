// Test harness for the management routes: Access gate with a fake JWKS, real ControlPlane, mocked outbound HTTP.
import { FULL_ACCESS } from "../../src/credentials/ownership.ts";
import { env } from "cloudflare:workers";
import { Context, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { makeAccessLayer, makeWithAccess } from "../../src/access/layer.ts";
import type { AccessPrincipal } from "../../src/access/principal.ts";
import { orgAddressing } from "../../src/access/org-address.ts";
import { RootRoutes } from "../../src/http/routes.ts";
import { ManagementRoutes } from "../../src/management/routes.ts";
import { OAuthCallbackRoutes } from "../../src/oauth/public-routes.ts";
import { requestContext } from "../../src/platform/env.ts";
import { controlPlaneOf, CurrentOrg, GLOBAL_ORG, type OrgId } from "../../src/platform/org.ts";
import { CatalogStore } from "../../src/registry/catalog-store.ts";
import { ModelRegistryLive } from "../../src/registry/live.ts";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims,
} from "./access.ts";
import { type MockHandler, mockHttp } from "./refresh.ts";
import type { Json } from "../../src/json/index.ts";

export const key = await makeKey("management-kid");

export const ADMIN = "admin@example.com";

/** An Access service token Client ID for tests that need a service-token administrator (`SERVICE_ADMIN_BINDINGS`). */
export const SERVICE_ADMIN = "automation.access";

/** Pass to `makeHarness` as the bindings to make `SERVICE_ADMIN` an administrator. */
export const SERVICE_ADMIN_BINDINGS: Partial<Env> = {
  PLATFORM_ADMIN_SERVICE_TOKENS: SERVICE_ADMIN,
};

const baseEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: ADMIN,
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

const ctx = {} as unknown as ExecutionContext;

export const token = async (email: string = ADMIN): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims(email) });

/** An Access service token assertion for the client id `commonName`. */
export const serviceToken = async (commonName: string): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: serviceClaims(commonName) });

/** The ControlPlane of `org` (`global` by default). */
export const controlPlane = (org: OrgId = GLOBAL_ORG) => controlPlaneOf(env, org);

/** Restores a pristine ControlPlane of `global` (no credentials, default config); usable as a `beforeEach` hook. */
export const resetControlPlane = async (): Promise<void> => {
  await resetOrgControlPlane(GLOBAL_ORG);
};

/** Restores a pristine ControlPlane of `org` (no credentials, default config). */
export const resetOrgControlPlane = async (org: OrgId): Promise<void> => {
  const stub = controlPlane(org);
  const entries = await stub.listCredentials(FULL_ACCESS);
  await stub.removeCredentials(
    entries.map((entry) => entry.id),
    FULL_ACCESS,
  );
  await stub.importConfig("", "test");

  // An import leaves the price overrides alone.
  for (const override of (await stub.priceOverrideEntries()).overrides)
    await stub.writePriceOverride(
      { id: override.id, revision: override.revision, value: null },
      "test",
    );
};

export interface Harness {
  readonly call: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<Response>;
  readonly json: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  readonly requests: ReturnType<typeof mockHttp>["requests"];
  readonly dispose: () => Promise<void>;
}

/**
 * `org`: the org every request of the harness belongs to (the Worker resolves `global` for now). `proxyRoutes`: stand-in
 * proxy routes behind the same gate, for tests of what reaches them.
 */
export const makeHarness = (
  http: MockHandler = () => ({ status: 404 }),
  bindings: Partial<Env> = {},
  org: OrgId = GLOBAL_ORG,
  proxyRoutes: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", AccessPrincipal>
  > = Layer.empty,
): Harness => {
  const outbound = mockHttp(http);
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

  const routes = ManagementRoutes.pipe(
    Layer.provide(Layer.mergeAll(ModelRegistryLive, outbound.layer, CatalogStore.layer)),
  );

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      RootRoutes,
      OAuthCallbackRoutes,
      access,
      makeWithAccess(access)(Layer.mergeAll(routes, proxyRoutes)),
    ),
    { disableLogger: true, middleware: orgAddressing },
  );

  const call: Harness["call"] = async (path, init = {}) => {
    const { auth, ...rest } = init;
    const headers = new Headers(rest.headers);

    if (auth !== false) headers.set("Cf-Access-Jwt-Assertion", auth ?? (await token()));

    return await web.handler(
      new Request(`https://proxy.test${path}`, { ...rest, headers }),
      Context.add(requestContext({ ...baseEnv, ...bindings }, ctx), CurrentOrg, org),
    );
  };

  return {
    call,
    json: async (path, init) => {
      const response = await call(path, init);
      const text = await response.text();

      return {
        status: response.status,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
        headers: response.headers,
      };
    },
    requests: outbound.requests,
    dispose: web.dispose,
  };
};

/**
 * A Platform registry of its own for one harness (the Worker has one object per deployment, which the tests of a file
 * share): pass `bindings` to `makeHarness`, and create and rename orgs through `platform` without touching other
 * tests' orgs.
 */
export const isolatedPlatform = () => {
  const stub = env.PLATFORM.getByName(`platform-${crypto.randomUUID()}`);

  // SAFETY: only `getByName` is read from the binding (`platformOf`), and it answers with a real Platform stub.
  const bindings = { PLATFORM: { getByName: () => stub } as unknown as Env["PLATFORM"] };

  return { bindings: bindings satisfies Partial<Env>, platform: stub };
};

export const jsonInit = (method: string, body: Json): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-secret-access",
  refresh_token: "secret-refresh",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});
