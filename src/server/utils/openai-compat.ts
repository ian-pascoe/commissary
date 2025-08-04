/**
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { createOpenAIHono } from '@ns/ai-to-openai-hono'
 *
 * import { anthropic } from  'npm:@ai-sdk/anthropic' // or your favorite provider
 *
 * const app = new Hono()
 *
 * app.route('/my-ai-endpoint', createOpenAIHono({
 *   languageModels: {
 *     'claude-3.7-sonnet': anthropic('claude-3-7-sonnet-20250219') // or your favorite model,
 *     // ...
 *   },
 *   verifyAPIKey(key) {
 *     return key === 'this-is-super-secret-key'
 *   }
 * }))
 *
 * export default app
 * ```
 * @module
 */

import type {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV2,
  LanguageModelV2FinishReason,
  SpeechModelV2,
} from "@ai-sdk/provider";
import {
  embedMany,
  type FilePart,
  experimental_generateImage as generateImage,
  experimental_generateSpeech as generateSpeech,
  generateText,
  type ImagePart,
  type ModelMessage,
  streamText as streamTextAI,
  type TextPart,
} from "ai";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamText as streamTextHono } from "hono/streaming";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "openai/resources/embeddings";
import type {
  ImageGenerateParams,
  ImagesResponse,
} from "openai/resources/images";

const STOP_REASON: Record<
  LanguageModelV2FinishReason,
  "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null
> = {
  length: "length",
  stop: "stop",
  "content-filter": "content_filter",
  "tool-calls": "tool_calls",
  unknown: "stop",
  error: "stop",
  other: "stop",
};

/**
 * Options to init
 */
export interface Init {
  languageModels?:
    | Record<string, LanguageModelV2>
    | ((
        modelId: string,
      ) => Promise<LanguageModelV2 | null> | LanguageModelV2 | null);
  imageModels?:
    | Record<string, ImageModelV2>
    | ((modelId: string) => Promise<ImageModelV2 | null> | ImageModelV2 | null);
  embeddingModels?:
    | Record<string, EmbeddingModelV2<unknown>>
    | ((
        modelId: string,
      ) =>
        | Promise<EmbeddingModelV2<unknown> | null>
        | EmbeddingModelV2<unknown>
        | null);
  speechModels?:
    | Record<string, SpeechModelV2>
    | ((
        modelId: string,
      ) => Promise<SpeechModelV2 | null> | SpeechModelV2 | null);

  middleware?: MiddlewareHandler;
}

type SDKInit = Parameters<typeof generateText>[0] &
  Parameters<typeof streamTextAI>[0];

/**
 * Create Hono App from AI SDK
 * @param init Options to init
 * @returns Hono app
 */
export const createOpenAICompat = (init: Init): Hono => {
  const app = new Hono();

  if (init.middleware) {
    app.use(init.middleware);
  }

  if (init.languageModels) {
    const models = init.languageModels;
    app.post("/v1/chat/completions", async (c) => {
      const body = await c.req.json<ChatCompletionCreateParams>();
      console.log(
        "[OpenAI Compat] Chat completion request:",
        JSON.stringify(body),
      );

      const model =
        typeof models === "function"
          ? await models(body.model)
          : models[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const aiSDKInit: SDKInit = {
        model,
        messages: body.messages.map((message): ModelMessage => {
          if (message.role === "assistant") {
            return {
              role: "assistant",
              content: message.content
                ? typeof message.content === "string"
                  ? message.content
                  : message.content
                      .map((c) => (c.type === "text" ? c.text : c.refusal))
                      .join("")
                : "",
            };
          } else if (message.role === "user") {
            return {
              role: "user",
              content:
                typeof message.content === "string"
                  ? message.content
                  : message.content.map(
                      (c): TextPart | ImagePart | FilePart => {
                        if (c.type === "text") {
                          return {
                            type: "text",
                            text: c.text,
                          };
                        }
                        if (c.type === "image_url") {
                          return {
                            type: "image",
                            image: new URL(c.image_url.url),
                          };
                        }
                        if (c.type === "file") {
                          return {
                            type: "file",
                            data: c.file.file_data ?? "",
                            mediaType: "",
                          };
                        }
                        return {
                          type: "file",
                          data: c.input_audio.data,
                          mediaType:
                            c.input_audio.format === "mp3"
                              ? "audio/mpeg"
                              : "audio/wav",
                        };
                      },
                    ),
            };
          } else if (message.role === "developer") {
            return {
              role: "system",
              content:
                typeof message.content === "string"
                  ? message.content
                  : message.content.map((c) => c.text).join(""),
            };
          } else if (message.role === "function") {
            return {
              role: "system",
              content: message.content ?? "",
            };
          } else if (message.role === "system") {
            return {
              role: "system",
              content:
                typeof message.content === "string"
                  ? message.content
                  : message.content.map((c) => c.text).join(""),
            };
          } else if (message.role === "tool") {
            return {
              role: "tool",
              content:
                typeof message.content === "string"
                  ? []
                  : message.content.map((c) => ({
                      type: "tool-result",
                      toolCallId: message.tool_call_id,
                      toolName: message.tool_call_id,
                      output: { type: "text", value: c.text },
                    })),
            };
          }
          throw new Error(`Unreachable`);
        }),
        temperature: body.temperature ?? undefined,
        topP: body.top_p ?? undefined,
        frequencyPenalty: body.frequency_penalty ?? undefined,
        presencePenalty: body.presence_penalty ?? undefined,
        maxOutputTokens: body.max_completion_tokens ?? undefined,
        stopSequences: body.stop
          ? typeof body.stop === "string"
            ? [body.stop]
            : body.stop
          : undefined,
        tools: body.tools
          ? Object.fromEntries(
              body.tools?.map((tool) => [
                tool.function.name,
                {
                  type: "function",
                  description: tool.function.description,
                  parameters: tool.function.parameters,
                },
              ]),
            )
          : undefined,
        toolChoice: body.tool_choice
          ? typeof body.tool_choice === "string"
            ? body.tool_choice
            : {
                type: "tool",
                toolName: body.tool_choice.function.name,
              }
          : undefined,
        seed: body.seed ?? undefined,
      };
      if (body.stream) {
        const aiStream = streamTextAI(aiSDKInit);

        return streamTextHono(c, async (stream) => {
          const streamChunk = async (data: ChatCompletionChunk) => {
            await stream.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          const reader = aiStream.fullStream.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (value) {
              if (value.type === "error") {
                await streamChunk({
                  id: crypto.randomUUID(),
                  object: "chat.completion.chunk",
                  created: Date.now() / 1000,
                  model:
                    typeof aiSDKInit.model === "string"
                      ? aiSDKInit.model
                      : aiSDKInit.model.modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                });
                break;
              } else if (value.type === "finish") {
                await streamChunk({
                  id: crypto.randomUUID(),
                  object: "chat.completion.chunk",
                  created: Date.now() / 1000,
                  model:
                    typeof aiSDKInit.model === "string"
                      ? aiSDKInit.model
                      : aiSDKInit.model.modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: STOP_REASON[value.finishReason],
                    },
                  ],
                  usage: value.totalUsage
                    ? {
                        completion_tokens: value.totalUsage.outputTokens ?? 0,
                        prompt_tokens: value.totalUsage.inputTokens ?? 0,
                        total_tokens: value.totalUsage.totalTokens ?? 0,
                      }
                    : undefined,
                });
                break;
              } else if (value.type === "text-delta") {
                await streamChunk({
                  id: crypto.randomUUID(),
                  object: "chat.completion.chunk",
                  created: Date.now() / 1000,
                  model:
                    typeof aiSDKInit.model === "string"
                      ? aiSDKInit.model
                      : aiSDKInit.model.modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        content: value.text,
                      },
                      finish_reason: null,
                    },
                  ],
                });
              } else if (value.type === "tool-call") {
                await streamChunk({
                  id: crypto.randomUUID(),
                  object: "chat.completion.chunk",
                  created: Date.now() / 1000,
                  model:
                    typeof aiSDKInit.model === "string"
                      ? aiSDKInit.model
                      : aiSDKInit.model.modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        tool_calls: [
                          {
                            id: value.toolCallId,
                            index: 0,
                            function: {
                              name: value.toolName,
                              arguments: JSON.stringify(value.input),
                            },
                          },
                        ],
                      },
                      finish_reason: "stop",
                    },
                  ],
                });
                break;
              }
            }
            if (done) {
              break;
            }
          }

          await stream.write("data: [DONE]\n\n");
          await stream.close();
        });
      }

      const generated = await generateText(aiSDKInit);
      const resultJSON: ChatCompletion = {
        id: generated.response.id,
        object: "chat.completion",
        created: generated.response.timestamp.getTime() / 1000,
        model: generated.response.modelId,
        choices: [
          {
            index: 0,
            //@ts-expect-error idk
            finish_reason: STOP_REASON[generated.finishReason],
            logprobs: null,
            message: {
              role: "assistant",
              content: generated.text,
              refusal: "",
              tool_calls: generated.toolCalls.map(
                (call) =>
                  ({
                    id: call.toolCallId,
                    type: "function",
                    function: {
                      name: call.toolName,
                      arguments: JSON.stringify(call.input),
                    },
                  }) satisfies ChatCompletionMessageToolCall,
              ),
            },
          },
        ],
        usage: generated.totalUsage
          ? {
              completion_tokens: generated.totalUsage.outputTokens ?? 0,
              prompt_tokens: generated.totalUsage.inputTokens ?? 0,
              total_tokens: generated.totalUsage.totalTokens ?? 0,
            }
          : undefined,
      };
      return c.json(resultJSON);
    });
  }

  if (init.imageModels) {
    const models = init.imageModels;
    app.post("/v1/images/generations", async (c) => {
      const body = await c.req.json<ImageGenerateParams>();
      if (!body.model) {
        throw new HTTPException(400, {
          message: "Model is required",
        });
      }
      const model =
        typeof models === "function"
          ? await models(body.model)
          : models[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await generateImage({
        model,
        prompt: body.prompt,
        n: body.n ?? undefined,
        size: body.size === "auto" ? undefined : (body.size ?? undefined),
      });
      const resultJSON: ImagesResponse = {
        created: generated.responses[0]!.timestamp.getTime() / 1000,
        data: generated.images.map((image) => ({
          b64_json: image.base64,
        })),
      };
      return c.json(resultJSON);
    });
  }
  if (init.embeddingModels) {
    const models = init.embeddingModels;
    app.post("/v1/embeddings", async (c) => {
      const body = await c.req.json<EmbeddingCreateParams>();
      const model =
        typeof models === "function"
          ? await models(body.model)
          : models[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await embedMany({
        model,
        values: Array.isArray(body.input) ? body.input : [body.input],
      });
      return c.json({
        object: "list",
        data: generated.embeddings.map((embedding, index) => ({
          object: "embedding",
          embedding: embedding,
          index,
        })),
        model: model.modelId,
        usage: {
          prompt_tokens: generated.usage.tokens,
          total_tokens: generated.usage.tokens,
        },
      } satisfies CreateEmbeddingResponse);
    });
  }

  if (init.speechModels) {
    const models = init.speechModels;
    app.post("/v1/audio/speech", async (c) => {
      const body = await c.req.json<SpeechCreateParams>();
      const model =
        typeof models === "function"
          ? await models(body.model)
          : models[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await generateSpeech({
        model,
        text: body.input,
        instructions: body.instructions,
        speed: body.speed ?? undefined,
        voice: body.voice,
        outputFormat: body.response_format,
      });
      return c.body(generated.audio.uint8Array, {
        headers: {
          "Content-Type": generated.audio.mediaType,
          "Content-Length": generated.audio.uint8Array.byteLength.toString(),
        },
      });
    });
  }

  return app;
};
