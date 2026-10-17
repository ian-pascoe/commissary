/**
 * The auth Worker (ADR 0030), Commissary Cloud only: Better Auth on the auth host, its `SignIn` database, and the RPC
 * the app Worker asks over its service binding (`SignInService`, `@commissary/auth`). Its Durable Objects are the state
 * Worker's (apps/state), bound by script name (alchemy.run.ts); a deploy of the state Worker resets them, and the calls
 * cut off then are retried once (`retryOnCodeUpdate`).
 */
import { retryOnCodeUpdate } from "@commissary/state";
import { SignInEntrypoint } from "./entrypoint.ts";

/** The deployed entrypoint: the invocation's bindings, the state namespaces retried across a state Worker deploy. */
export class AuthWorker extends SignInEntrypoint<Env> {
  protected bindings(): Env {
    return retryOnCodeUpdate(this.env);
  }
}

export default AuthWorker;
