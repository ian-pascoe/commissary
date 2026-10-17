/**
 * The auth Worker's RPC (ADR 0030; #130, #132): what another Worker asks the one Worker that holds Better Auth and its
 * `SignIn` database. The auth Worker's entrypoint implements it (apps/auth), and the app Worker's Cloud-only service
 * binding (`AUTH`) is typed by it, so no package depends on the auth Worker. A self-hosted Commissary has no binding
 * and makes no call. Changes are expand-then-contract, like the state RPC (docs/DEVELOPMENT.md): add a method or a field,
 * switch the callers, remove the old one a release later. New in the Workers port.
 */
import type { SignedInPerson } from "./hosted-gate.ts";

export interface SignInService {
  /**
   * The person whose live session the `Cookie` header `cookie` names; `null` without one, for an expired or ended
   * session and for an email the provider has not verified.
   */
  session(cookie: string): Promise<SignedInPerson | null>;
  /**
   * Ends every session of the people with these emails (a suspension): their next request is not signed in. Their
   * accounts stay. Answers how many sessions it ended.
   */
  endSessions(emails: ReadonlyArray<string>): Promise<number>;
  /**
   * Ends every session of the people whose email is at `domain` (a normalized domain whose org now requires single
   * sign-on for it): they sign in again, through the org's identity provider. Answers how many sessions it ended.
   */
  endDomainSessions(domain: string): Promise<number>;
  /**
   * Deletes the sign-in account of `email` (a person deleting their account, ADR 0027) with its sessions and linked
   * GitHub/Google accounts. Answers how many accounts it deleted: 0 once it is gone, so a repeated deletion succeeds.
   */
  deleteSignInAccount(email: string): Promise<number>;
}
