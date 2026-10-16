/**
 * Sign-in on Commissary Cloud (ADR 0026): Better Auth's core with GitHub and Google as social providers, its people and
 * sessions in D1 (`USAGE`, tables `auth_*` from `migrations/0008_hosted_auth.sql`). Orgs, members and teams stay in the
 * org's ControlPlane, and a session only says which verified email signed in. New in the Workers port.
 *
 * Only an email the provider reports as verified becomes an identity (`validateUserInfo`); the provider's tokens are
 * not kept (Commissary never calls GitHub or Google on the person's behalf), nor the browser's address or user agent.
 *
 * An org can add its own identity provider (issue #76, `src/sso/`) through Better Auth's SSO plugin, whose providers
 * come from the orgs' ControlPlanes (`sso-adapter.ts`), never from D1. Such a sign-in is accepted only for an email of
 * a domain the org verified, makes the person a member of the org (unless an org admin removed them), and its email
 * counts as verified: the org proved it controls the domain. GitHub and Google are refused for an email of a domain
 * whose org requires single sign-on.
 *
 * Better Auth is imported on first use: a self-hosted Commissary never loads it.
 */
import type { betterAuth, BetterAuthOptions } from "better-auth";
import { SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import { type ProviderLookup, ssoAwareAdapter } from "./sso-adapter.ts";

/** Where Better Auth's routes live; `routes.ts` lets through only {@link AUTH_PATHS}. */
export const AUTH_BASE_PATH = "/api/auth";

/** The social providers Commissary Cloud can offer, in the order the sign-in page lists them. */
export const SIGN_IN_PROVIDERS = ["github", "google"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/** Better Auth's tables: prefixed, since they share the `USAGE` database with the usage records. */
export const AUTH_TABLES = {
  user: "auth_user",
  session: "auth_session",
  account: "auth_account",
  verification: "auth_verification",
} as const;

/** The refusal Better Auth reports (`?error=`) when a provider has not verified the email. */
export const EMAIL_NOT_VERIFIED = "email_not_verified";

type AuthEnv = Pick<
  Env,
  | "USAGE"
  | "BETTER_AUTH_SECRET"
  | "SIGN_IN_GITHUB_CLIENT_ID"
  | "SIGN_IN_GITHUB_CLIENT_SECRET"
  | "SIGN_IN_GOOGLE_CLIENT_ID"
  | "SIGN_IN_GOOGLE_CLIENT_SECRET"
>;

const setting = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";

  return trimmed === "" ? undefined : trimmed;
};

/** The providers whose OAuth client the deployment configured (both the id and the secret). */
export const enabledProviders = (env: AuthEnv): ReadonlyArray<SignInProvider> =>
  SIGN_IN_PROVIDERS.filter((provider) => providerClient(env, provider) !== undefined);

const providerClient = (
  env: AuthEnv,
  provider: SignInProvider,
): { readonly clientId: string; readonly clientSecret: string } | undefined => {
  const [id, secret] =
    provider === "github"
      ? [env.SIGN_IN_GITHUB_CLIENT_ID, env.SIGN_IN_GITHUB_CLIENT_SECRET]
      : [env.SIGN_IN_GOOGLE_CLIENT_ID, env.SIGN_IN_GOOGLE_CLIENT_SECRET];

  const clientId = setting(id);
  const clientSecret = setting(secret);

  return clientId === undefined || clientSecret === undefined
    ? undefined
    : { clientId, clientSecret };
};

/** Shortest accepted `BETTER_AUTH_SECRET`: Better Auth signs cookies and state with it. */
export const MIN_SECRET_LENGTH = 32;

/** What the deployment is missing for sign-in, `undefined` when nothing is. */
export const authConfigurationProblem = (env: AuthEnv): string | undefined => {
  if ((setting(env.BETTER_AUTH_SECRET)?.length ?? 0) < MIN_SECRET_LENGTH)
    return `BETTER_AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters`;

  return undefined;
};

/** The refusal of a GitHub or Google sign-in for an email whose domain's org requires single sign-on. */
export const SSO_REQUIRED = "sso_required";

/** A refusal of a sign-in through an org's identity provider (`AuthHooks.admitThroughSso`). */
export interface SignInRefusal {
  readonly error: string;
  readonly errorDescription: string;
}

/** Hooks the hosted gate adds to the sign-in (suspension, `suspension.ts`; single sign-on, `session.ts`). */
export interface AuthHooks {
  /** Whether a session may start for the person with this (verified, lowercased) email. */
  readonly maySignIn?: (email: string) => Promise<boolean>;
  /** The identity provider with this Better Auth provider id (`sso/provider.ts`). */
  readonly ssoProvider?: ProviderLookup;
  /**
   * Admits the person the identity provider `providerId` signed in with this (lowercased) email to its org, or says
   * why not. Without the hook, single sign-on is refused.
   */
  readonly admitThroughSso?: (
    providerId: string,
    email: string,
  ) => Promise<SignInRefusal | undefined>;
  /** Whether the org that verified this (lowercased) email's domain requires single sign-on for it. */
  readonly ssoRequired?: (email: string) => Promise<boolean>;
}

/** Better Auth's methods of a sign-in through an org's identity provider. */
const SSO_METHODS = new Set(["sso-oidc", "sso-saml"]);

/** Better Auth's options for the deployment at `origin` (`https://<host>`). */
export const authOptions = (env: AuthEnv, origin: string, hooks: AuthHooks = {}) =>
  ({
    appName: "commissary",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [origin],
    // `authConfigurationProblem` refuses a missing secret before an instance is built.
    secret: setting(env.BETTER_AUTH_SECRET) ?? "",
    database: env.USAGE,
    socialProviders: Object.fromEntries(
      SIGN_IN_PROVIDERS.flatMap((provider) => {
        const client = providerClient(env, provider);

        return client === undefined ? [] : [[provider, { ...client, prompt: "select_account" }]];
      }),
    ),
    user: {
      modelName: AUTH_TABLES.user,
      validateUserInfo: async ({ user, source }) => {
        const email = typeof user.email === "string" ? user.email.toLowerCase() : "";

        // The org verified the email's domain, which is what makes it verified (`admitThroughSso`).
        if (SSO_METHODS.has(source.method))
          return source.sso === undefined || hooks.admitThroughSso === undefined
            ? { error: "sso_unavailable", errorDescription: "Single sign-on is not available." }
            : await hooks.admitThroughSso(source.sso.providerId, email);

        if (user.emailVerified !== true)
          return {
            error: EMAIL_NOT_VERIFIED,
            errorDescription: "Sign in with an account whose email the provider has verified.",
          };

        if (hooks.ssoRequired !== undefined && (await hooks.ssoRequired(email)))
          return {
            error: SSO_REQUIRED,
            errorDescription: "Your organization requires you to sign in with your work email.",
          };

        return undefined;
      },
    },
    session: { modelName: AUTH_TABLES.session },
    account: {
      modelName: AUTH_TABLES.account,
      // The same verified email through GitHub and Google is one person.
      accountLinking: { enabled: true, trustedProviders: [...SIGN_IN_PROVIDERS] },
    },
    verification: { modelName: AUTH_TABLES.verification },
    databaseHooks: {
      user: {
        create: {
          // Only after `validateUserInfo` admitted the person through their org's identity provider.
          before: async (user, context) =>
            context?.path?.startsWith(SSO_PATH_PREFIX) === true
              ? { data: { ...user, emailVerified: true } }
              : { data: user },
        },
      },
      account: {
        create: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
        update: { before: async (account) => ({ data: withoutProviderTokens(account) }) },
      },
      session: {
        create: {
          before: async (session, context) => {
            const email = await sessionEmail(context, session.userId);

            if (
              email !== undefined &&
              hooks.maySignIn !== undefined &&
              !(await hooks.maySignIn(email))
            )
              return false;

            return { data: { ...session, ipAddress: null, userAgent: null } };
          },
        },
      },
    },
    // Turnstile (`turnstile.ts`) guards the only way in; Better Auth's own limiter would count per isolate only.
    rateLimit: { enabled: false },
    advanced: { useSecureCookies: true, ipAddress: { disableIpTracking: true } },
    onAPIError: { errorURL: SIGN_IN_PAGE_PATH },
    telemetry: { enabled: false },
  }) satisfies BetterAuthOptions;

const withoutProviderTokens = <A extends Record<string, unknown>>(account: A): A => ({
  ...account,
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
});

/** Where Better Auth's SSO plugin has its routes, relative to {@link AUTH_BASE_PATH}. */
const SSO_PATH_PREFIX = "/sso/";

/** The lowercased email of the person a session is about to start for. */
const sessionEmail = async (
  context: { readonly context: { readonly internalAdapter: unknown } } | null,
  userId: string,
): Promise<string | undefined> => {
  if (context === null) return undefined;

  // SAFETY: Better Auth's endpoint context always carries its internal adapter; only `findUserById` is used.
  const adapter = context.context.internalAdapter as {
    findUserById: (id: string) => Promise<{ email: string } | null>;
  };

  const user = await adapter.findUserById(userId);

  return user?.email.toLowerCase();
};

/** What the Worker uses of its Better Auth instance. */
export interface HostedAuth {
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
    }) => ReturnType<
      ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>["api"]["getSession"]
    >;
  };
}

/**
 * Better Auth with the SSO plugin: identity providers from `hooks.ssoProvider` (none without it), domains the orgs
 * verified themselves (`sso-routes.ts`), SAML only signed, timed and in answer to Commissary's own request.
 */
const buildAuth = async (env: AuthEnv, origin: string, hooks: AuthHooks): Promise<HostedAuth> => {
  const [{ betterAuth: make }, { sso }, { getAdapter }] = await Promise.all([
    import("better-auth"),
    import("@better-auth/sso"),
    import("better-auth/db/adapter"),
  ]);

  const options = authOptions(env, origin, hooks);

  const plugins = [
    sso({
      domainVerification: { enabled: true },
      organizationProvisioning: { disabled: true },
      saml: {
        enableInResponseToValidation: true,
        allowIdpInitiated: false,
        requireTimestamps: true,
        algorithms: { onDeprecated: "reject" },
      },
    }),
  ];

  const base = await getAdapter({ ...options, plugins });
  const lookup = hooks.ssoProvider ?? (async () => undefined);

  return make({ ...options, plugins, database: () => ssoAwareAdapter(base, lookup) });
};

const instances = new WeakMap<AuthEnv, Map<string, Promise<HostedAuth>>>();

/**
 * The Better Auth instance of the deployment at `origin`, built once per isolate (and per `env` object: tests swap
 * bindings). Call {@link authConfigurationProblem} first.
 */
export const hostedAuth = (
  env: AuthEnv,
  origin: string,
  hooks: AuthHooks = {},
): Promise<HostedAuth> => {
  let byOrigin = instances.get(env);

  if (byOrigin === undefined) {
    byOrigin = new Map();
    instances.set(env, byOrigin);
  }

  const existing = byOrigin.get(origin);

  if (existing !== undefined) return existing;

  const auth = buildAuth(env, origin, hooks);

  byOrigin.set(origin, auth);

  return auth;
};
