/**
 * OpenCode Zen `gemini` protocol: Gemini `generateContent` / `streamGenerateContent` at `{base}/models/{model}:{action}`.
 *
 * Go source (engine): internal/runtime/executor/gemini_executor.go through the shared Google engine
 * (`gemini/google.ts`), as an API-key Gemini variant whose target is the gateway: `x-goog-api-key` plus the OpenCode
 * client and session headers. Interactions are never used natively (they translate to `generateContent`).
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"): upstream errors are re-classified with the gateway rules (`errors.ts`), before the stream and mid-stream
 * alike, and OpenCode Go has no Gemini endpoint
 * (`protocol.ts` falls back to chat there).
 */
import { Clock, Effect, Stream } from "effect";
import type { TranslatorRegistry } from "../../translator/registry.ts";
import type { ExecutionError } from "../errors.ts";
import { makeGoogleExecutor } from "../gemini/google.ts";
import type { ProviderExecutor } from "../types.ts";
import { openCodeEndpoint } from "./attempt.ts";
import { reclassifyOpenCodeError } from "./errors.ts";
import { openCodeIdentityHeaders } from "./headers.ts";
import type { OpenCodeProvider } from "./providers.ts";

/** The Google engine pointed at the gateway (execute and executeStream only; token counting stays local). */
export const makeOpenCodeGeminiEngine = (
  provider: OpenCodeProvider,
  registry: TranslatorRegistry,
): Pick<ProviderExecutor, "execute" | "executeStream"> => {
  const engine = makeGoogleExecutor({
    identifier: provider,
    vertex: false,
    translators: registry,
    nativeInteractions: () => false,
    resolveTarget: (context, options) =>
      Effect.map(openCodeEndpoint(context, provider), ({ baseUrl, apiKey }) => ({
        url: (action, model) => `${baseUrl}/models/${encodeURIComponent(model)}:${action}`,
        interactionsUrl: () => `${baseUrl}/interactions`,
        authHeaders: { ...openCodeIdentityHeaders(options), "x-goog-api-key": apiKey },
      })),
  });

  const reclassify = (error: ExecutionError) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Effect.fail(reclassifyOpenCodeError(provider, error, nowMs)),
    );

  return {
    execute: (context, request, options) =>
      engine.execute(context, request, options).pipe(Effect.catch(reclassify)),
    executeStream: (context, request, options) =>
      engine.executeStream(context, request, options).pipe(
        Effect.map((result) => ({
          ...result,
          chunks: result.chunks.pipe(Stream.catch((error) => Stream.fromEffect(reclassify(error)))),
        })),
        Effect.catch(reclassify),
      ),
  };
};
