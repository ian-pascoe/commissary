/**
 * The state auth asks for, behind one Effect service (#132 "How it reaches its stores"): the calls it makes to an org's
 * ControlPlane and to the Platform registry. Auth never sees a Durable Object: the Worker provides the one adapter
 * over the stubs (`@commissary/state` `auth-directory.ts`), and the tests an in-memory one
 * (`@commissary/auth/testing`). The types that cross the service live here, and the stores import them, so
 * dependencies run one way: state → auth.
 *
 * Where auth reads only part of a store's answer, the type here names that part (`OrgRef`, `SignInOutcome`,
 * `SsoSignInState`, `MemberAddition`); the store's fuller answer satisfies it.
 */
import { Context, Data, type Effect } from "effect";
import type { OrgRole } from "@commissary/contract/members";
import { InternalError, type OrgId } from "@commissary/core";
import type { Actor } from "./roles.ts";
import type { IdpSettings } from "./sso/settings.ts";

/** Who a request is, as the ControlPlane looks it up: a person by email, a service token by Client ID. */
export type PrincipalRef =
  | { readonly kind: "user"; readonly email: string }
  | { readonly kind: "service"; readonly clientId: string };

/** A principal's place in the org. */
export interface Admission {
  readonly role: OrgRole;
  /** The member id of a person; absent for a service token. */
  readonly memberId?: string;
  /** The person joined just now (auto-join). */
  readonly joined: boolean;
  /** The Platform registry's index is behind the org's members and service tokens (`membershipIndex`). */
  readonly indexStale: boolean;
}

/** The org accepts only API keys on its client API routes: an Access sign-in is not admitted there. */
export interface ClientsUseApiKeys {
  readonly apiKeysOnly: true;
}

/** What the Platform registry indexes for the org, and the change it reflects. */
export interface MembershipIndex {
  readonly emails: ReadonlyArray<string>;
  readonly serviceTokens: ReadonlyArray<string>;
  /** The change counter the lists reflect; hand it back to `markIndexSynced`. */
  readonly counter: number;
  /** Whether the registry has caught up with `counter`. */
  readonly synced: boolean;
}

/** The org list and index of one org as its ControlPlane states them. */
export interface OrgIndex {
  readonly emails: ReadonlyArray<string>;
  readonly serviceTokens: ReadonlyArray<string>;
}

/** What a repair of one org's index changed. */
export type IndexRepair =
  | {
      readonly ok: true;
      readonly members: number;
      readonly serviceTokens: number;
      /** Service tokens the org lists that another org already holds: kept with that org, not moved. */
      readonly conflicts: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: "not_found" };

/** Why a presented API key was refused; the client sees the same `Invalid API key` for each. */
export type ApiKeyRejection = "unknown" | "expired";

/** The ControlPlane's answer to a presented API key: its live member and their role, or why it is refused. */
export type ApiKeyVerdict =
  | {
      readonly ok: true;
      readonly memberId: string;
      readonly email: string;
      readonly role: OrgRole;
      /** When the key expires (epoch ms), so a cache of verified keys never keeps it longer. */
      readonly expiresAt?: number;
    }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/** The ControlPlane's answer to a presented management key; the client sees the same `Invalid API key` for every refusal. */
export type ManagementKeyVerdict =
  | {
      readonly ok: true;
      readonly name: string;
      readonly role: OrgRole;
      readonly ownerEmail?: string;
    }
  | { readonly ok: false };

/** Where an org and a person stand for a key or a session of Commissary Cloud. */
export interface Standing {
  readonly org: "active" | "suspended" | "missing";
  readonly person: "active" | "suspended";
}

/** What a sign-in through the org's identity provider did to its membership (`ControlPlane.admitThroughSso`). */
export type SsoAdmission =
  | { readonly ok: true; readonly joined: boolean; readonly indexStale: boolean }
  | {
      readonly ok: false;
      /** No provider; the email's domain is not a verified domain of the org; an org admin removed the person. */
      readonly error: "provider_missing" | "domain_unverified" | "removed";
    };

/** A verified single sign-on domain: the org that verified it and whether that org requires single sign-on for it. */
export interface SsoDomainRecord {
  readonly org: OrgId;
  readonly requireSso: boolean;
}

/** An org of the Platform registry, as auth needs it: its permanent id. */
export interface OrgRef {
  readonly id: OrgId;
}

/**
 * Where a person who signed in stands (Platform `signIn`): suspended; signed up (or invited); or due the Personal org
 * the registry just created for them, which the sign-up still has to give them (`standing.ts`).
 */
export type SignInOutcome =
  | { readonly kind: "suspended" }
  | { readonly kind: "ready" }
  | { readonly kind: "personal"; readonly org: OrgRef };

/** An org's single sign-on as a sign-in reads it: its identity provider and its domains. */
export interface SsoSignInState {
  readonly provider?: { readonly settings: IdpSettings };
  readonly domains: ReadonlyArray<{ readonly domain: string; readonly verifiedAt?: number }>;
}

/** Whether adding a member worked; `error` is the store's code (`member_exists` when they already are one). */
export type MemberAddition = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * A directory call failed (the Durable Object could not be reached, or threw). `message` is `<call>: <reason>`;
 * callers that word their own failure use `reason`.
 */
export class DirectoryUnavailable extends Data.TaggedError("DirectoryUnavailable")<{
  readonly message: string;
  readonly reason: string;
}> {}

/**
 * A failed directory call as the request's failure (a 500): the call's own message, or `<label>: <reason>` when the
 * caller names what it was doing.
 */
export const directoryFailure =
  (label?: string) =>
  (error: DirectoryUnavailable): InternalError =>
    new InternalError({
      message: label === undefined ? error.message : `${label}: ${error.reason}`,
    });

type Call<A> = Effect.Effect<A, DirectoryUnavailable>;

export interface AuthDirectoryService {
  // --- an org's ControlPlane ------------------------------------------------------------------------------------
  /** Checks a presented API key of `org` (its id and the SHA-256 of the whole key) at `now` (epoch ms). */
  readonly verifyApiKey: (
    org: OrgId,
    keyId: string,
    hash: string,
    now: number,
  ) => Call<ApiKeyVerdict>;
  readonly verifyManagementKey: (
    org: OrgId,
    keyId: string,
    hash: string,
    now: number,
  ) => Call<ManagementKeyVerdict>;
  /**
   * The role of `principal` in `org` (`undefined`: none); with `autoJoin` a person joins where the org lets them;
   * `client`: the request is for the client API.
   */
  readonly admit: (
    org: OrgId,
    principal: PrincipalRef,
    autoJoin: boolean,
    client: boolean,
  ) => Call<Admission | ClientsUseApiKeys | undefined>;
  readonly membershipIndex: (org: OrgId) => Call<MembershipIndex>;
  readonly markIndexSynced: (org: OrgId, counter: number) => Call<void>;
  readonly ssoState: (org: OrgId) => Call<SsoSignInState>;
  readonly admitThroughSso: (org: OrgId, email: string) => Call<SsoAdmission>;
  /** Adds `member` to `org` as `actor` would; `by` is recorded as who added them. */
  readonly addMember: (
    org: OrgId,
    member: { readonly email: string; readonly role: OrgRole },
    actor: Actor,
    by: string,
  ) => Call<MemberAddition>;
  // --- the Platform registry ------------------------------------------------------------------------------------
  readonly getOrgById: (id: OrgId) => Call<OrgRef | undefined>;
  readonly getOrgBySlug: (slug: string) => Call<OrgRef | undefined>;
  readonly replaceOrgIndex: (org: OrgId, index: OrgIndex) => Call<IndexRepair>;
  readonly standing: (org: OrgId, email: string | undefined) => Call<Standing>;
  /** The org that verified `domain` (normalized, `sso/domain.ts`), `undefined` when none did. */
  readonly ssoDomain: (domain: string) => Call<SsoDomainRecord | undefined>;
  /** The domains the registry gives `org`. */
  readonly ssoDomainsOf: (org: OrgId) => Call<ReadonlyArray<string>>;
  readonly signIn: (email: string, now: number) => Call<SignInOutcome>;
  readonly finishSignUp: (email: string, now: number) => Call<void>;
}

/** The state auth reads and writes, provided per request by the Worker (`requestContext`). */
export class AuthDirectory extends Context.Service<AuthDirectory, AuthDirectoryService>()(
  "commissary/auth/AuthDirectory",
) {}
