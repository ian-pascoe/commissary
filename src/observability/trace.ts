/**
 * Per-request trace state, the `X-CPA-TRACE-ID` response header and the structured request log.
 *
 * Go source: internal/logging/cpa_trace.go (CPATraceIDMiddleware, FormatCPATraceID), internal/logging/gin_logger.go
 * (GinLogrusLogger: request id per AI API request, one log line per request), internal/logging/requestid.go.
 *
 * Deviation from Go: the header carries only the request id (a random UUID, also the usage records' `trace_id`). Go
 * sends `<selection time yyyyMMddHHmmss>-<auth index>-<request id>`, refreshed whenever a credential is selected, to
 * every API client; Go's auth index is an unsalted hash of the credential id, which for a config API key is itself a
 * hash of the key, so any client could confirm key guesses offline. Even keyed, the index would tell clients which
 * credential served them. Admins correlate a response with its credential through the usage records (`trace_id` →
 * `auth_index`) or the request log line (`authIndex`, keyed). Nothing in this repository or the Go panel parses the
 * header. Every proxied response gets it, including requests that never selected a credential (Go sends none then).
 */
import { Clock, Context, Effect, Exit } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuthIndexKeyError, orgAuthIndexer } from "../management/auth-index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { CurrentOrg } from "../platform/org.ts";

export const CPA_TRACE_ID_HEADER = "X-CPA-TRACE-ID";

/** Mutable state of one inbound request, written by the pipeline and read by the middleware. */
export interface RequestTraceState {
  /** Inbound request id: the `X-CPA-TRACE-ID` value and the usage `trace_id`. */
  readonly requestId: string;
  /** Access principal id (`user:<email>` / `service:<id>`), set by the pipeline. */
  principal: string | undefined;
  /** Keyed `auth_index` of the last selected credential (logged, never sent to the client). */
  authIndex: string | undefined;
  /** Number of upstream attempts started. */
  attempts: number;
  provider: string | undefined;
  model: string | undefined;
}

/** The trace of the current request; `undefined` outside the Worker's router (tests, scheduled jobs). */
export const RequestTrace = Context.Reference<RequestTraceState | undefined>(
  "cf-llm-proxy/observability/RequestTrace",
  {
    defaultValue: () => undefined,
  },
);

export const newTraceState = (): RequestTraceState => ({
  requestId: crypto.randomUUID(),
  principal: undefined,
  authIndex: undefined,
  attempts: 0,
  provider: undefined,
  model: undefined,
});

/**
 * The keyed index of `credentialId` in the request's org for the log line (the index the org's management API
 * answers), or undefined when `AUTH_INDEX_KEY` is refused
 * (`AuthIndexKeyError`, logged once by the indexer): the log annotation must never fail the request it describes.
 */
const loggedAuthIndex = (credentialId: string) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const org = yield* CurrentOrg;

    try {
      return orgAuthIndexer(env, org)(credentialId);
    } catch (error) {
      if (error instanceof AuthIndexKeyError) return undefined;
      throw error;
    }
  });

/** Records a credential selection on the request's trace (no-op outside the router). */
export const noteSelection = (credentialId: string, provider: string, model: string) =>
  Effect.gen(function* () {
    const trace = yield* RequestTrace;

    if (trace === undefined) return;
    trace.authIndex = yield* loggedAuthIndex(credentialId);
    trace.attempts += 1;
    trace.provider = provider;
    trace.model = model;
  });

/** Annotates the request's trace with the caller (no-op outside the router). */
export const notePrincipal = (principalId: string) =>
  Effect.gen(function* () {
    const trace = yield* RequestTrace;

    if (trace !== undefined && principalId !== "") trace.principal = principalId;
  });

const logFields = (
  trace: RequestTraceState,
  method: string,
  path: string,
  status: number,
  latencyMs: number,
) => ({
  requestId: trace.requestId,
  method,
  path,
  ...(status > 0 ? { status } : {}),
  latencyMs,
  ...(trace.principal === undefined ? {} : { principal: trace.principal }),
  ...(trace.provider === undefined ? {} : { provider: trace.provider }),
  ...(trace.model === undefined ? {} : { model: trace.model }),
  ...(trace.authIndex === undefined ? {} : { authIndex: trace.authIndex }),
  ...(trace.attempts === 0 ? {} : { attempts: trace.attempts }),
});

const logRequest = (
  fields: ReturnType<typeof logFields> & { readonly failed?: boolean },
  status: number,
) => {
  const log = status >= 500 ? Effect.logError : status >= 400 ? Effect.logWarning : Effect.logInfo;

  return log("request").pipe(Effect.annotateLogs(fields));
};

/**
 * Global middleware: gives every request a trace state, sets `X-CPA-TRACE-ID` (the request id) on the response and logs one structured
 * line per request (method, pathname, status, latency, caller and credential index; never query strings, headers or
 * bodies). The pipeline fills in the caller and credential. Unmatched routes fail inside the router (the CORS layer
 * turns them into 404s further out), so those requests are logged as failures without a status.
 */
export const TraceLayer = HttpRouter.middleware()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trace = newTraceState();
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(Effect.provideService(app, RequestTrace, trace));
      const latencyMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
      const path = new URL(request.originalUrl, "http://localhost").pathname;
      // Like Go, health probes are not logged.
      const quiet = path === "/healthz";

      if (Exit.isFailure(exit)) {
        if (!quiet)
          yield* logRequest(
            { ...logFields(trace, request.method, path, 0, latencyMs), failed: true },
            400,
          );

        return yield* exit;
      }

      const response = exit.value;

      if (!quiet)
        yield* logRequest(
          logFields(trace, request.method, path, response.status, latencyMs),
          response.status,
        );

      return quiet
        ? response
        : HttpServerResponse.setHeader(response, CPA_TRACE_ID_HEADER, trace.requestId);
    }),
  { global: true },
);
