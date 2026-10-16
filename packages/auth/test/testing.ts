/**
 * `@commissary/auth/testing`: what tests of auth and of its dependants need. Locally generated RSA keys, signed Access
 * JWTs and a fake JWKS HTTP client; and an in-memory `AuthDirectory` (the second adapter, next to the Worker's over the
 * Durable Objects), with the orgs, members, keys and people a test seeds. For test files only (docs/DEVELOPMENT.md,
 * "Tests").
 */
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import type { OrgRole } from "@commissary/contract/members";
import { type OrgId, OrgId as OrgIdSchema } from "@commissary/core";
import { AccessJwks } from "../src/access/jwks.ts";
import {
  AuthDirectory,
  type AuthDirectoryService,
  DirectoryUnavailable,
  type SsoSignInState,
} from "../src/directory.ts";
import { mintApiKey, mintManagementKey, parseApiKey, parseManagementKey } from "../src/keys.ts";

// --- Access ---------------------------------------------------------------------------------------------------------

export const TEAM = "team.cloudflareaccess.com";

export const ISSUER = `https://${TEAM}`;

export const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;

export const AUD = "aud-tag-1";

export interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

export const makeKey = async (kid: string): Promise<TestKey> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
};

export interface TokenOptions {
  readonly key: TestKey;
  /** Overrides the `kid` header (defaults to the key's kid). */
  readonly kid?: string;
  readonly claims?: Record<string, unknown>;
  readonly issuer?: string;
  readonly audience?: string | ReadonlyArray<string>;
  /** Seconds since epoch. */
  readonly now: number;
  readonly expiresIn?: number;
  readonly notBefore?: number;
}

export const signToken = (options: TokenOptions): Promise<string> => {
  const jwt = new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? options.key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience([
      ...(typeof options.audience === "string" ? [options.audience] : (options.audience ?? [AUD])),
    ])
    .setIssuedAt(options.now)
    .setExpirationTime(options.now + (options.expiresIn ?? 3600));

  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore);

  return jwt.sign(options.key.privateKey);
};

export const userClaims = (email: string) => ({ email, sub: `sub-${email}`, type: "app" });

export const serviceClaims = (commonName: string) => ({
  common_name: commonName,
  sub: "",
  type: "app",
});

/** Mutable state behind the fake JWKS endpoint. */
export interface FakeJwks {
  keys: Array<JWK>;
  fetches: number;
  fail: boolean;
}

export const makeFakeJwks = (keys: ReadonlyArray<TestKey>): FakeJwks => ({
  keys: keys.map((key) => key.jwk),
  fetches: 0,
  fail: false,
});

/** `AccessJwks` layer backed by a fake HttpClient serving `state`. */
export const fakeJwksLayer = (state: FakeJwks): Layer.Layer<AccessJwks> =>
  AccessJwks.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            state.fetches++;

            const body = state.fail
              ? "boom"
              : JSON.stringify({ keys: state.keys, public_cert: {} });

            return HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                status: state.fail ? 500 : 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      ),
    ),
  );

// --- the in-memory directory ----------------------------------------------------------------------------------------

interface MemoryMember {
  readonly id: string;
  readonly role: OrgRole;
}

interface MemoryKey {
  readonly org: OrgId;
  readonly hash: string;
  readonly expiresAt?: number;
}

interface MemoryOrg {
  readonly id: OrgId;
  readonly slug: string;
  suspended: boolean;
  autoJoin: boolean;
  /** The org still takes Access sign-ins on its client API (`global` only, on a real deployment). */
  accessClients: boolean;
  /** Members by lowercased email. */
  readonly members: Map<string, MemoryMember>;
  /** Service tokens' roles by Client ID. */
  readonly serviceTokens: Map<string, OrgRole>;
  /** API keys by id, with the member id they belong to. */
  readonly apiKeys: Map<string, MemoryKey & { readonly memberId: string }>;
  /** Management keys by id. */
  readonly managementKeys: Map<
    string,
    MemoryKey & { readonly name: string; readonly role: OrgRole; readonly ownerEmail?: string }
  >;
  /** Counts membership changes; the registry's index holds `indexed`. */
  counter: number;
  indexed: number;
  sso: SsoSignInState;
}

/** What a test seeds and reads back; `calls` lists every directory call in order. */
export interface MemoryDirectory {
  readonly service: AuthDirectoryService;
  /** The `AuthDirectory` layer over {@link service}. */
  readonly layer: Layer.Layer<AuthDirectory>;
  readonly calls: Array<string>;
  /** Calls that fail with `DirectoryUnavailable` (by name), as if the Durable Object could not be reached. */
  readonly failing: Set<string>;
  /** The registry's index: the orgs it lists each email in. */
  readonly index: Map<string, Set<OrgId>>;
  readonly addOrg: (slug: string, id?: OrgId) => OrgId;
  readonly addMember: (org: OrgId, email: string, role: OrgRole) => string;
  readonly removeMember: (org: OrgId, email: string) => void;
  readonly addServiceToken: (org: OrgId, clientId: string, role: OrgRole) => void;
  readonly setOrg: (
    org: OrgId,
    settings: Partial<Pick<MemoryOrg, "autoJoin" | "accessClients" | "suspended">>,
  ) => void;
  /** Issues an API key of the member with `email`; answers the whole key. */
  readonly issueApiKey: (org: OrgId, email: string, expiresAt?: number) => string;
  /** Issues a management key; answers the whole key. */
  readonly issueManagementKey: (
    org: OrgId,
    name: string,
    role: OrgRole,
    ownerEmail?: string,
  ) => string;
  readonly revokeKey: (org: OrgId, key: string) => void;
  readonly suspendPerson: (email: string, suspended?: boolean) => void;
  /** People who finished signing up. */
  readonly signedUp: Set<string>;
}

let nextId = 0;

const newId = (prefix: string): string => `${prefix}${(++nextId).toString(16).padStart(20, "0")}`;

/** An in-memory `AuthDirectory`: no org exists until a test adds it (`global` included). */
export const memoryDirectory = (): MemoryDirectory => {
  const orgs = new Map<OrgId, MemoryOrg>();
  const index = new Map<string, Set<OrgId>>();
  const suspendedPeople = new Set<string>();
  const signedUp = new Set<string>();
  const personalOrgs = new Map<string, OrgId>();
  const calls: Array<string> = [];
  const failing = new Set<string>();

  const call = <A>(name: string, answer: () => A): Effect.Effect<A, DirectoryUnavailable> =>
    Effect.suspend(() => {
      calls.push(name);

      return failing.has(name)
        ? Effect.fail(
            new DirectoryUnavailable({ message: `${name}: unreachable`, reason: "unreachable" }),
          )
        : Effect.sync(answer);
    });

  const orgOf = (id: OrgId): MemoryOrg => {
    const org = orgs.get(id);

    if (org === undefined) throw new Error(`no org ${id}`);

    return org;
  };

  const addOrg = (slug: string, id = OrgIdSchema.make(`org-${slug}`)): OrgId => {
    orgs.set(id, {
      id,
      slug,
      suspended: false,
      autoJoin: false,
      accessClients: false,
      members: new Map(),
      serviceTokens: new Map(),
      apiKeys: new Map(),
      managementKeys: new Map(),
      counter: 0,
      indexed: 0,
      sso: { domains: [] },
    });

    return id;
  };

  const addMember = (id: OrgId, email: string, role: OrgRole): string => {
    const org = orgOf(id);
    const member = { id: newId("m"), role };

    org.members.set(email.toLowerCase(), member);
    org.counter++;

    return member.id;
  };

  const service: AuthDirectoryService = {
    verifyApiKey: (id, keyId, hash, now) =>
      call("verifyApiKey", () => {
        const org = orgOf(id);
        const key = org.apiKeys.get(keyId);

        if (key === undefined || key.hash !== hash) return { ok: false, reason: "unknown" };

        if (key.expiresAt !== undefined && now >= key.expiresAt)
          return { ok: false, reason: "expired" };
        const member = [...org.members].find(([, entry]) => entry.id === key.memberId);

        if (member === undefined) return { ok: false, reason: "unknown" };

        return {
          ok: true,
          memberId: key.memberId,
          email: member[0],
          role: member[1].role,
          ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
        };
      }),
    verifyManagementKey: (id, keyId, hash) =>
      call("verifyManagementKey", () => {
        const key = orgOf(id).managementKeys.get(keyId);

        if (key === undefined || key.hash !== hash) return { ok: false };

        return {
          ok: true,
          name: key.name,
          role: key.role,
          ...(key.ownerEmail === undefined ? {} : { ownerEmail: key.ownerEmail }),
        };
      }),
    admit: (id, principal, autoJoin, client) =>
      call("admit", () => {
        const org = orgOf(id);

        if (client && !org.accessClients) return { apiKeysOnly: true } as const;
        const indexStale = org.indexed < org.counter;

        if (principal.kind === "service") {
          const role = org.serviceTokens.get(principal.clientId);

          if (role !== undefined) return { role, joined: false, indexStale };

          return autoJoin && org.autoJoin
            ? { role: "member" as const, joined: false, indexStale }
            : undefined;
        }

        const email = principal.email.toLowerCase();
        const member = org.members.get(email);

        if (member !== undefined)
          return { role: member.role, memberId: member.id, joined: false, indexStale };

        if (!autoJoin || !org.autoJoin) return undefined;

        return {
          role: "member" as const,
          memberId: addMember(id, email, "member"),
          joined: true,
          indexStale: true,
        };
      }),
    membershipIndex: (id) =>
      call("membershipIndex", () => {
        const org = orgOf(id);

        return {
          emails: [...org.members.keys()],
          serviceTokens: [...org.serviceTokens.keys()],
          counter: org.counter,
          synced: org.indexed >= org.counter,
        };
      }),
    markIndexSynced: (id, counter) =>
      call("markIndexSynced", () => {
        const org = orgOf(id);

        org.indexed = Math.max(org.indexed, counter);
      }),
    ssoState: (id) => call("ssoState", () => orgOf(id).sso),
    admitThroughSso: (id, email) =>
      call("admitThroughSso", () => {
        const org = orgOf(id);

        if (org.sso.provider === undefined) return { ok: false, error: "provider_missing" };

        if (org.members.has(email.toLowerCase()))
          return { ok: true, joined: false, indexStale: false };
        addMember(id, email, "member");

        return { ok: true, joined: true, indexStale: true };
      }),
    addMember: (id, member) =>
      call("addMember", () => {
        if (orgOf(id).members.has(member.email.toLowerCase()))
          return { ok: false, error: "member_exists" };
        addMember(id, member.email, member.role);

        return { ok: true };
      }),
    getOrgById: (id) => call("getOrgById", () => (orgs.has(id) ? { id } : undefined)),
    getOrgBySlug: (slug) =>
      call("getOrgBySlug", () => {
        const org = [...orgs.values()].find((entry) => entry.slug === slug);

        return org === undefined ? undefined : { id: org.id };
      }),
    replaceOrgIndex: (id, lists) =>
      call("replaceOrgIndex", () => {
        if (!orgs.has(id)) return { ok: false, error: "not_found" } as const;

        for (const orgsOfEmail of index.values()) orgsOfEmail.delete(id);

        for (const email of lists.emails)
          index.set(email, (index.get(email) ?? new Set<OrgId>()).add(id));

        return {
          ok: true,
          members: lists.emails.length,
          serviceTokens: lists.serviceTokens.length,
          conflicts: [],
        } as const;
      }),
    standing: (id, email) =>
      call("standing", () => {
        const org = orgs.get(id);

        return {
          org: org === undefined ? "missing" : org.suspended ? "suspended" : "active",
          person:
            email !== undefined && suspendedPeople.has(email.toLowerCase())
              ? "suspended"
              : "active",
        } as const;
      }),
    ssoDomain: (domain) =>
      call("ssoDomain", () => {
        for (const org of orgs.values())
          if (
            org.sso.domains.some(
              (entry) => entry.domain === domain && entry.verifiedAt !== undefined,
            )
          )
            return { org: org.id, requireSso: false };

        return undefined;
      }),
    ssoDomainsOf: (id) =>
      call("ssoDomainsOf", () =>
        orgOf(id).sso.domains.flatMap((entry) =>
          entry.verifiedAt === undefined ? [] : [entry.domain],
        ),
      ),
    signIn: (email) =>
      call("signIn", () => {
        const address = email.toLowerCase();

        if (suspendedPeople.has(address)) return { kind: "suspended" } as const;

        if (signedUp.has(address)) return { kind: "ready" } as const;
        const pending = personalOrgs.get(address);

        if (pending !== undefined) return { kind: "personal", org: { id: pending } } as const;

        if ((index.get(address)?.size ?? 0) > 0) {
          signedUp.add(address);

          return { kind: "ready" } as const;
        }

        const org = addOrg(`personal-${newId("p").slice(-8)}`);

        personalOrgs.set(address, org);

        return { kind: "personal", org: { id: org } } as const;
      }),
    finishSignUp: (email) =>
      call("finishSignUp", () => {
        signedUp.add(email.toLowerCase());
      }),
  };

  return {
    service,
    layer: Layer.succeed(AuthDirectory, service),
    calls,
    failing,
    index,
    signedUp,
    addOrg,
    addMember,
    removeMember: (id, email) => {
      const org = orgOf(id);

      org.members.delete(email.toLowerCase());
      org.counter++;
    },
    addServiceToken: (id, clientId, role) => {
      const org = orgOf(id);

      org.serviceTokens.set(clientId, role);
      org.counter++;
    },
    setOrg: (id, settings) => {
      Object.assign(orgOf(id), settings);
    },
    issueApiKey: (id, email, expiresAt) => {
      const member = orgOf(id).members.get(email.toLowerCase());

      if (member === undefined) throw new Error(`${email} is no member of ${id}`);
      const minted = mintApiKey(id);

      orgOf(id).apiKeys.set(minted.keyId, {
        org: id,
        hash: minted.hash,
        memberId: member.id,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return minted.key;
    },
    issueManagementKey: (id, name, role, ownerEmail) => {
      const minted = mintManagementKey(id);

      orgOf(id).managementKeys.set(minted.keyId, {
        org: id,
        hash: minted.hash,
        name,
        role,
        ...(ownerEmail === undefined ? {} : { ownerEmail }),
      });

      return minted.key;
    },
    revokeKey: (id, key) => {
      const keyId = (parseApiKey(key) ?? parseManagementKey(key))?.keyId ?? "";

      orgOf(id).apiKeys.delete(keyId);
      orgOf(id).managementKeys.delete(keyId);
    },
    suspendPerson: (email, suspended = true) => {
      if (suspended) suspendedPeople.add(email.toLowerCase());
      else suspendedPeople.delete(email.toLowerCase());
    },
  };
};
