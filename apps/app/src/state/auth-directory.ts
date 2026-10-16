/**
 * The one `AuthDirectory` adapter (#132): `@commissary/auth`'s state calls over the Durable Object stubs, an org's
 * ControlPlane (`controlPlaneOf`) and the Platform registry (`platformOf`). It lives next to the Durable Object classes
 * and moves with them into `@commissary/state`. A failed RPC is a `DirectoryUnavailable` naming the call.
 */
import { type AuthDirectoryService, DirectoryUnavailable } from "@commissary/auth";
import type { OrgId } from "@commissary/core";
import { Effect } from "effect";
import { controlPlaneOf } from "../platform/org.ts";
import { platformOf } from "../platform/registry.ts";
import type { StateBindings } from "./env.ts";

/** Runs one RPC; RPC results are plain data after `await`. */
const call = <A>(label: string, rpc: () => Promise<A>): Effect.Effect<A, DirectoryUnavailable> =>
  Effect.tryPromise({
    try: rpc,
    catch: (cause) => {
      const reason = cause instanceof Error ? cause.message : "unknown error";

      return new DirectoryUnavailable({ message: `${label}: ${reason}`, reason });
    },
  });

/** The directory over the state bindings of the current invocation. */
export const stateAuthDirectory = (
  env: Pick<StateBindings, "CONTROL_PLANE" | "PLATFORM">,
): AuthDirectoryService => {
  const org = (id: OrgId) => controlPlaneOf(env, id);
  const platform = () => platformOf(env);

  return {
    verifyApiKey: (id, keyId, hash, now) =>
      call("verifyApiKey", async () => await org(id).verifyApiKey(keyId, hash, now)),
    verifyManagementKey: (id, keyId, hash, now) =>
      call("verifyManagementKey", async () => await org(id).verifyManagementKey(keyId, hash, now)),
    admit: (id, principal, autoJoin, client) =>
      call("admit", async () => await org(id).admit(principal, autoJoin, client)),
    membershipIndex: (id) => call("membershipIndex", async () => await org(id).membershipIndex()),
    markIndexSynced: (id, counter) =>
      call("markIndexSynced", async () => await org(id).markIndexSynced(counter)),
    ssoState: (id) => call("ssoState", async () => await org(id).ssoState()),
    admitThroughSso: (id, email) =>
      call("admitThroughSso", async () => await org(id).admitThroughSso(email)),
    addMember: (id, member, actor, by) =>
      call("addMember", async () => await org(id).addMember(member, actor, by)),
    getOrgById: (id) => call("getOrgById", async () => await platform().getOrgById(id)),
    getOrgBySlug: (slug) => call("getOrgBySlug", async () => await platform().getOrgBySlug(slug)),
    replaceOrgIndex: (id, index) =>
      call("replaceOrgIndex", async () => await platform().replaceOrgIndex(id, index)),
    standing: (id, email) => call("standing", async () => await platform().standing(id, email)),
    ssoDomain: (domain) => call("ssoDomain", async () => await platform().ssoDomain(domain)),
    ssoDomainsOf: (id) => call("ssoDomainsOf", async () => await platform().ssoDomainsOf(id)),
    signIn: (email, now) => call("signIn", async () => await platform().signIn(email, now)),
    finishSignUp: (email, now) =>
      call("finishSignUp", async () => await platform().finishSignUp(email, now)),
  };
};
