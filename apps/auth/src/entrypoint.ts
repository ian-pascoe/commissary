/**
 * The auth Worker's entrypoint (ADR 0030), shared by its deployed entry (`index.ts`) and its dev entry (`dev.ts`), which
 * differ only in how they reach the state Worker's Durable Objects. A module of its own, so neither entry exports it.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import type { SignedInPerson, SignInService } from "@commissary/auth";
import { WorkersLoggerLayer } from "@commissary/core";
import { stateAuthDirectory } from "@commissary/state";
import { makeWebHandler } from "./http/app.ts";
import { authConfigurationProblem } from "./sign-in/auth.ts";
import {
  deleteSignInAccount,
  endDomainSessions,
  endSessions,
  signedInPerson,
} from "./sign-in/sessions.ts";
import { requestContext } from "./worker-env.ts";

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler();

/** The origin Better Auth runs at for an RPC call, which has no request: the auth host's, as its routes see it. */
const RPC_ORIGIN = "https://auth.invalid";

/**
 * The auth Worker's entrypoint over the bindings `E` it is given: `fetch` serves the auth host, and the methods answer
 * the app Worker's service binding. Every method reads the bindings through {@link SignInEntrypoint.bindings}: the
 * deployed entry's ({@link AuthWorker}) or the dev entry's (src/dev.ts).
 */
export abstract class SignInEntrypoint<E> extends WorkerEntrypoint<E> implements SignInService {
  /** The invocation's bindings as the auth Worker reads them. */
  protected abstract bindings(): Env;

  override async fetch(request: Request): Promise<Response> {
    return await handler(request, requestContext(this.bindings(), this.ctx));
  }

  /** A lookup that fails (sign-in not configured, the database unreachable) throws: the app Worker answers 500. */
  async session(cookie: string): Promise<SignedInPerson | null> {
    const env = this.bindings();
    const problem = authConfigurationProblem(env);

    if (problem !== undefined) {
      const message = `hosted sign-in is not configured: ${problem}`;

      await Effect.runPromise(Effect.logError(message).pipe(Effect.provide(WorkersLoggerLayer)));

      throw new Error(message);
    }

    // Better Auth reads the session from its cookie; the origin it runs at only shapes the cookies it would set.
    return (await signedInPerson(env, stateAuthDirectory(env), RPC_ORIGIN, cookie)) ?? null;
  }

  async endSessions(emails: ReadonlyArray<string>): Promise<number> {
    return await endSessions(this.bindings(), emails);
  }

  async endDomainSessions(domain: string): Promise<number> {
    return await endDomainSessions(this.bindings(), domain);
  }

  async deleteSignInAccount(email: string): Promise<number> {
    return await deleteSignInAccount(this.bindings(), email);
  }
}
