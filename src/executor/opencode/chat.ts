/**
 * OpenCode Zen/Go `chat` protocol: OpenAI Chat Completions at `{base}/chat/completions`.
 *
 * Go source (shaping and response handling): internal/runtime/executor/openai_compat_executor.go (Execute,
 * ExecuteStream, CountTokens). Per attempt: translate to Chat Completions -> thinking -> max-token field normalisation
 * (`use-max-completion-tokens` of the config model entry) -> `stream_options.include_usage` (stream) -> payload rules.
 * The stream goes through the openai-compat stream reader (`openai-compat/stream.ts`).
 *
 * Deliberate deviation from Go (no OpenCode provider there): the openai-compat executor itself is not reused because
 * it reads its settings from the `openai-compatibility` group of the credential (`resolveCompatConfig`) and sends its
 * own User-Agent; no `prompt_cache_key` is derived (the gateway keys caching on `x-opencode-session`). See
 * docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 */
import { Effect, Stream } from "effect";
import { splitLines } from "../../http/sse.ts";
import { get, tryParseJson } from "../../json/index.ts";
import { encodingForModel, getCodec } from "../../tokenizer/index.ts";
import { Formats } from "../../translator/formats.ts";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
} from "../../usage/record.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { normalizeOpenAIMaxTokens, setBoolIfDifferent } from "../helps/openai-compat-models.ts";
import { buildOpenAIUsageJson, countOpenAIChatTokens } from "../helps/token-count.ts";
import { OpenAICompatStreamReader, TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import { type ExecutorResponse, responseFormatOf, type StreamResult } from "../types.ts";
import {
  finalizeForOpenCode,
  type OpenCodeAttempt,
  type OpenCodeShaping,
  openCodeResponseContext,
  postJson,
  transportError,
  translateForOpenCode,
} from "./attempt.ts";
import { openCodeHeaders } from "./headers.ts";

const PATH = "/chat/completions";

/** The Chat Completions body of an attempt (payload rules applied last). */
export const prepareChatBody = Effect.fnUntraced(function* (
  shaping: OpenCodeShaping,
  stream: boolean,
  forCount = false,
) {
  const translated = yield* translateForOpenCode(shaping, Formats.OpenAI, stream);
  let body = translated.body;

  if (!forCount) {
    body = normalizeOpenAIMaxTokens(
      body,
      shaping.resolved.entry?.["use-max-completion-tokens"] === true,
    );

    // Ask for usage in the final chunk so token statistics are captured.
    if (stream) body = setBoolIfDifferent(body, "stream_options.include_usage", true);
    const effort = get(body, "reasoning_effort");
    shaping.context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);
  }

  return finalizeForOpenCode(shaping, Formats.OpenAI, translated.original, body);
});

const send = Effect.fnUntraced(function* (attempt: OpenCodeAttempt, stream: boolean) {
  const body = yield* prepareChatBody(attempt, stream);

  const headers = openCodeHeaders({
    credential: attempt.context.credential,
    options: attempt.options,
    protocol: "chat",
    apiKey: attempt.apiKey,
    stream,
  });

  const response = yield* postJson(attempt, `${attempt.baseUrl}${PATH}`, headers, body);

  return { body, response };
});

export const executeChat = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const { body, response } = yield* send(attempt, options.stream);
  const text = yield* response.text.pipe(Effect.mapError(transportError));
  context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));

  const out = registry.translateNonStream(
    responseFormat,
    Formats.OpenAI,
    openCodeResponseContext(attempt, body),
    text,
  );

  if (out === undefined || out === "") {
    return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
  }

  context.usage.publish(parseOpenAIUsage(text));

  const payload =
    responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out;

  return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
});

export const executeChatStream = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const { body, response } = yield* send(attempt, true);

  const reader = new OpenAICompatStreamReader({
    registry,
    responseFormat: responseFormatOf(options),
    providerFormat: Formats.OpenAI,
    context: openCodeResponseContext(attempt, body),
  });

  const observe = (line: string) => {
    const usage = parseOpenAIStreamUsage(line);

    if (usage !== undefined) context.usage.publish(usage);
    context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));
  };

  const chunks = splitLines(response.stream).pipe(
    Stream.mapError(transportError),
    Stream.mapAccum(
      () => reader,
      (state, line: string) => {
        observe(line);

        return [state, [state.push(line)]] as const;
      },
      { onHalt: (state) => [state.end()] },
    ),
    Stream.takeUntil((step) => step.stop),
    Stream.flatMap((step) => {
      const emitted = Stream.fromIterable(step.chunks);

      if (step.error === undefined) return emitted;
      const error = step.error;
      context.usage.fail(
        error.status,
        step.payloadError === true ? "upstream stream returned an error payload" : error.message,
      );

      return Stream.concat(emitted, Stream.fail(error));
    }),
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
});

/** Local token count of the Chat Completions body with the model's BPE encoding. */
export const countChatTokens = Effect.fnUntraced(function* (shaping: OpenCodeShaping) {
  const body = yield* prepareChatBody(shaping, false, true);
  const count = countOpenAIChatTokens(getCodec(encodingForModel(shaping.baseModel)), body);

  return {
    payload: shaping.registry.translateTokenCount(
      responseFormatOf(shaping.options),
      Formats.OpenAI,
      count,
      buildOpenAIUsageJson(count),
    ),
    headers: new Headers(),
  } satisfies ExecutorResponse;
});
