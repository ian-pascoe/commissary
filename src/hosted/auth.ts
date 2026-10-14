/**
 * Sign-in on a hosted proxy (ADR 0026): Better Auth's core with GitHub and Google as social providers, its people and
 * sessions in D1 (`USAGE`, tables `auth_*` from `migrations/0008_hosted_auth.sql`). No plugins: orgs, members and teams
 * stay in the org's ControlPlane, and a session only says which verified email signed in. New in the Workers port.
 *
 * Only an email the provider reports as verified becomes an identity (`validateUserInfo`); the provider's tokens are
 * not kept (the proxy never calls GitHub or Google on the person's behalf), nor the browser's address or user agent.
 *
 * Better Auth is imported on first use: a self-hosted proxy never loads it.
 */
import type { betterAuth, BetterAuthOptions } from "better-auth";
import { SIGN_IN_PAGE_PATH } from "../management/contract/sign-in.ts";

/** Where Better Auth's routes live; `routes.ts` lets through only {@link AUTH_PATHS}. */
export const AUTH_BASE_PATH = "/api/auth";

/** The social providers a hosted proxy can offer, in the order the sign-in page lists them. */
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

/** Hooks the hosted gate adds to the sign-in (suspension, `suspension.ts`). */
export interface AuthHooks {
  /** Whether a session may start for the person with this (verified, lowercased) email. */
  readonly maySignIn?: (email: string) => Promise<boolean>;
}

/** Better Auth's options for the deployment at `origin` (`https://<host>`). */
export const authOptions = (env: AuthEnv, origin: string, hooks: AuthHooks = {}) =>
  ({
    appName: "cf-llm-proxy",
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
      validateUserInfo: ({ user }) =>
        user.emailVerified === true
          ? undefined
          : {
              error: EMAIL_NOT_VERIFIED,
              errorDescription: "Sign in with an account whose email the provider has verified.",
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

export type HostedAuth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>;

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

  const auth = import("better-auth").then(({ betterAuth: make }) =>
    make(authOptions(env, origin, hooks)),
  );

  byOrigin.set(origin, auth);

  return auth;
};
