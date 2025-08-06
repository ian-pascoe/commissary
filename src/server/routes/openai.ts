import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import {
  type AssistantContent,
  type EmbeddingModel,
  embedMany,
  type FilePart,
  type FinishReason,
  experimental_generateImage as generateImage,
  experimental_generateSpeech as generateSpeech,
  generateText,
  type ImageModel,
  type ImagePart,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type SpeechModel,
  smoothStream,
  streamText as streamTextAI,
  type TextPart,
  type Tool,
  type ToolCallPart,
  type ToolContent,
  type ToolResultPart,
  type TranscriptionModel,
  experimental_transcribe as transcribe,
  type UserContent,
} from "ai";
import { Groq } from "groq-sdk";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamText as streamTextHono } from "hono/streaming";
import OpenAI from "openai";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import type {
  TranscriptionCreateParams,
  TranscriptionCreateResponse,
} from "openai/resources/audio/transcriptions.mjs";
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
import type { Model } from "openai/resources/models";
import { Together } from "together-ai";
import { createId } from "~/utils/id";
import { providers } from "../lib/providers";
import { env } from "../utils/env";
import { factory } from "../utils/factory";

const STOP_REASON: Record<
  FinishReason,
  "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
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
  languageModels:
    | Record<string, LanguageModel>
    | ((
        modelId: string,
      ) => Promise<LanguageModel | null> | LanguageModel | null);
  imageModels:
    | Record<string, ImageModel>
    | ((modelId: string) => Promise<ImageModel | null> | ImageModel | null);
  embeddingModels:
    | Record<string, EmbeddingModel<unknown>>
    | ((
        modelId: string,
      ) =>
        | Promise<EmbeddingModel<unknown> | null>
        | EmbeddingModel<unknown>
        | null);
  speechModels:
    | Record<string, SpeechModel>
    | ((modelId: string) => Promise<SpeechModel | null> | SpeechModel | null);
  transcriptionModels:
    | Record<string, TranscriptionModel>
    | ((
        modelId: string,
      ) => Promise<TranscriptionModel | null> | TranscriptionModel | null);

  middleware: MiddlewareHandler;
}

type SDKInit = Parameters<typeof generateText>[0] &
  Parameters<typeof streamTextAI>[0];

/**
 * Create Hono App from AI SDK
 * @param init Options to init
 * @returns Hono app
 */
export const createOpenAICompat = (init: Init) => {
  const app = factory
    .createApp()
    .use(init.middleware)
    .get("/v1/models", async (c) => {
      const { registry: _registry, ...resolvedProviders } = providers();
      const models: Model[] = [];

      // Create promises for each provider's model fetching
      const modelPromises = Object.keys(resolvedProviders).map(
        async (provider) => {
          const providerModels: Model[] = [];

          try {
            switch (provider as keyof typeof resolvedProviders) {
              case "anthropic": {
                const anthropic = new Anthropic({
                  apiKey: env().ANTHROPIC_API_KEY,
                });
                const anthropicModels = await anthropic.models.list({
                  limit: 1000,
                });
                for (const model of anthropicModels.data) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: new Date(model.created_at).getTime() / 1000,
                    owned_by: provider,
                  });
                }
                break;
              }
              case "deepseek": {
                const deepseek = new OpenAI({
                  baseURL: "https://api.deepseek.com",
                  apiKey: env().DEEPSEEK_API_KEY,
                });
                const deepseekModels = await deepseek.models.list();
                for (const model of deepseekModels.data) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: model.created,
                    owned_by: provider,
                  });
                }
                break;
              }
              case "google": {
                const google = new GoogleGenAI({
                  apiKey: env().GOOGLE_API_KEY,
                });
                const googleModels = await google.models.list({
                  config: { pageSize: 1000 },
                });
                for (const model of googleModels.page) {
                  if (model.name) {
                    providerModels.push({
                      id: model.name.split("/").pop() ?? "",
                      object: "model",
                      created: Date.now() / 1000,
                      owned_by: provider,
                    });
                  }
                }
                break;
              }
              case "groq": {
                const groq = new Groq({
                  apiKey: env().GROQ_API_KEY,
                });
                const groqModels = await groq.models.list();
                for (const model of groqModels.data) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: model.created,
                    owned_by: provider,
                  });
                }
                break;
              }
              case "openai": {
                const openai = new OpenAI({
                  apiKey: env().OPENAI_API_KEY,
                });
                const openaiModels = await openai.models.list();
                for (const model of openaiModels.data) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: model.created,
                    owned_by: provider,
                  });
                }
                break;
              }
              case "openrouter": {
                const url = "https://openrouter.ai/api/v1/models";
                const options = { method: "GET" };
                const response = await fetch(url, options);
                if (!response.ok) {
                  throw new Error(
                    `Failed to fetch models from OpenRouter: ${response.statusText}`,
                  );
                }
                const { data } = (await response.json()) as any;
                for (const model of data) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: model.created,
                    owned_by: provider,
                  });
                }
                break;
              }
              case "togetherai": {
                const togetherai = new Together({
                  apiKey: env().TOGETHERAI_API_KEY,
                });
                const togetheraiModels = await togetherai.models.list();
                for (const model of togetheraiModels) {
                  providerModels.push({
                    id: model.id,
                    object: "model",
                    created: model.created,
                    owned_by: provider,
                  });
                }
                break;
              }
              default: {
                console.warn(`Unhandled provider: ${provider}`);
                break;
              }
            }
          } catch (error) {
            console.error(
              `Error fetching models for provider ${provider}:`,
              error,
            );
          }

          return providerModels;
        },
      );

      // Wait for all providers to finish fetching models
      const providerModelArrays = await Promise.all(modelPromises);

      // Flatten all provider models into the main models array
      for (const providerModels of providerModelArrays) {
        models.push(...providerModels);
      }

      return c.json({
        object: "list",
        data: models,
      });
    })
    .post("/v1/chat/completions", async (c) => {
      const body = await c.req.json<ChatCompletionCreateParams>();

      const model =
        typeof init.languageModels === "function"
          ? await init.languageModels(body.model)
          : init.languageModels[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const aiSDKInit: SDKInit = {
        abortSignal: c.req.raw.signal,
        model,
        messages: body.messages.flatMap((message): ModelMessage => {
          if (message.role === "assistant") {
            const content: AssistantContent = message.content
              ? typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map((c) => ({
                    type: "text",
                    text: c.type === "refusal" ? c.refusal : c.text,
                  }))
              : [];
            if (message.refusal) {
              content.push({ type: "text", text: message.refusal });
            }
            if (message.tool_calls) {
              content.push(
                ...message.tool_calls.map(
                  (toolCall): ToolCallPart => ({
                    type: "tool-call",
                    toolCallId: toolCall.id,
                    toolName: toolCall.function.name,
                    input: JSON.parse(toolCall.function.arguments),
                  }),
                ),
              );
            }
            if (message.function_call) {
              content.push({
                type: "tool-call",
                toolCallId: message.function_call.name,
                toolName: message.function_call.name,
                input: JSON.parse(message.function_call.arguments),
              });
            }
            return { role: "assistant", content };
          } else if (message.role === "user") {
            const content: UserContent =
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map((c): TextPart | ImagePart | FilePart => {
                    if (c.type === "text") {
                      return {
                        type: "text",
                        text: c.text,
                      };
                    }
                    if (c.type === "image_url") {
                      try {
                        return {
                          type: "image",
                          image: new URL(c.image_url.url),
                        };
                      } catch {
                        throw new HTTPException(400, {
                          message: `Invalid image URL: ${c.image_url.url}`,
                        });
                      }
                    }
                    if (c.type === "file") {
                      // Use the file's media type if available, otherwise default
                      const mediaType =
                        (c.file as any).mime_type || "application/octet-stream";
                      return {
                        type: "file",
                        data: c.file.file_data ?? "",
                        mediaType,
                        filename: c.file.filename,
                      };
                    }
                    if (c.type === "input_audio") {
                      return {
                        type: "file",
                        data: c.input_audio.data,
                        mediaType:
                          c.input_audio.format === "mp3"
                            ? "audio/mpeg"
                            : "audio/wav",
                      };
                    }
                    // Fallback for unknown content types
                    throw new HTTPException(400, {
                      message: `Unsupported content type: ${(c as any).type}`,
                    });
                  });
            return { role: "user", content };
          } else if (message.role === "developer") {
            const content: string =
              typeof message.content === "string"
                ? message.content
                : message.content.map((c) => c.text).join("");
            return { role: "system", content };
          } else if (message.role === "function") {
            return { role: "system", content: message.content ?? "" };
          } else if (message.role === "system") {
            const content: string =
              typeof message.content === "string"
                ? message.content
                : message.content.map((c) => c.text).join("");
            return { role: "system", content };
          } else if (message.role === "tool") {
            const content: ToolContent =
              typeof message.content === "string"
                ? [
                    {
                      type: "tool-result",
                      toolCallId: message.tool_call_id,
                      toolName: message.tool_call_id,
                      output: { type: "text", value: message.content },
                    },
                  ]
                : message.content.map(
                    (c): ToolResultPart => ({
                      type: "tool-result",
                      toolCallId: message.tool_call_id,
                      toolName: message.tool_call_id,
                      output: { type: "text", value: c.text },
                    }),
                  );
            return { role: "tool", content };
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
              body.tools?.map((tool): [string, Tool] => {
                return [
                  tool.function.name,
                  {
                    type: "function",
                    description: tool.function.description,
                    inputSchema: jsonSchema(tool.function.parameters),
                  },
                ];
              }),
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
        experimental_transform: [smoothStream()],
      };

      if (body.stream) {
        const aiStream = streamTextAI(aiSDKInit);

        return streamTextHono(c, async (stream) => {
          const streamChunk = async (data: ChatCompletionChunk) => {
            await stream.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          const model =
            typeof aiSDKInit.model === "string"
              ? aiSDKInit.model
              : aiSDKInit.model.modelId;

          for await (const chunk of aiStream.fullStream) {
            console.log("Streamed chunk:", JSON.stringify(chunk));
            if (chunk.type === "error") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                // @ts-expect-error
                error: chunk.error,
              });
              break;
            } else if (chunk.type === "finish") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: STOP_REASON[chunk.finishReason],
                  },
                ],
                usage: chunk.totalUsage
                  ? {
                      completion_tokens: chunk.totalUsage.outputTokens ?? 0,
                      prompt_tokens: chunk.totalUsage.inputTokens ?? 0,
                      total_tokens: chunk.totalUsage.totalTokens ?? 0,
                    }
                  : undefined,
              });
              break;
            } else if (chunk.type === "text-delta") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: chunk.text,
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (chunk.type === "tool-call") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: chunk.toolCallId,
                          function: {
                            name: chunk.toolName,
                            arguments: JSON.stringify(chunk.input),
                          },
                          type: "function",
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              });
            } else if (chunk.type === "tool-input-start") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: chunk.id,
                          function: {
                            name: chunk.toolName,
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (chunk.type === "tool-input-delta") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: chunk.id,
                          function: {
                            arguments: chunk.delta,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (chunk.type === "reasoning-start") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      // @ts-expect-error
                      reasoning_content: "",
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (chunk.type === "reasoning-delta") {
              await streamChunk({
                id: createId(),
                object: "chat.completion.chunk",
                created: Date.now() / 1000,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      // @ts-expect-error
                      reasoning_content: chunk.text,
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else {
              console.warn(`Unhandled streamed chunk type: ${chunk.type}`);
            }
          }

          await stream.write("data: [DONE]\n\n");
          await stream.close();
        });
      }

      const generated = await generateText(aiSDKInit);
      return c.json({
        id: generated.response.id,
        object: "chat.completion",
        created: generated.response.timestamp.getTime() / 1000,
        model: generated.response.modelId,
        choices: [
          {
            index: 0,
            finish_reason: STOP_REASON[generated.finishReason],
            logprobs: null,
            message: {
              role: "assistant",
              content: generated.text,
              refusal: "",
              tool_calls: generated.toolCalls.map(
                (call): ChatCompletionMessageToolCall => ({
                  id: call.toolCallId,
                  type: "function",
                  function: {
                    name: call.toolName,
                    arguments: JSON.stringify(call.input),
                  },
                }),
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
      } satisfies ChatCompletion);
    })
    .post("/v1/images/generations", async (c) => {
      const body = await c.req.json<ImageGenerateParams>();
      if (!body.model) {
        throw new HTTPException(400, {
          message: "Model is required",
        });
      }
      const model =
        typeof init.imageModels === "function"
          ? await init.imageModels(body.model)
          : init.imageModels[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await generateImage({
        abortSignal: c.req.raw.signal,
        model,
        prompt: body.prompt,
        n: body.n ?? undefined,
        size: body.size === "auto" ? undefined : (body.size ?? undefined),
      });
      return c.json({
        created:
          (generated.responses[0]?.timestamp ?? new Date()).getTime() / 1000,
        data: generated.images.map((image) => ({
          b64_json: image.base64,
        })),
      } satisfies ImagesResponse);
    })
    .post("/v1/embeddings", async (c) => {
      const body = await c.req.json<EmbeddingCreateParams>();
      const model =
        typeof init.embeddingModels === "function"
          ? await init.embeddingModels(body.model)
          : init.embeddingModels[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await embedMany({
        abortSignal: c.req.raw.signal,
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
    })
    .post("/v1/audio/speech", async (c) => {
      const body = await c.req.json<SpeechCreateParams>();
      const model =
        typeof init.speechModels === "function"
          ? await init.speechModels(body.model)
          : init.speechModels[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }
      const generated = await generateSpeech({
        abortSignal: c.req.raw.signal,
        model,
        text: body.input,
        instructions: body.instructions,
        speed: body.speed,
        voice: body.voice,
        outputFormat: body.response_format,
      });
      return c.body(generated.audio.uint8Array, {
        headers: {
          "Content-Type": generated.audio.mediaType,
          "Content-Length": generated.audio.uint8Array.byteLength.toString(),
        },
      });
    })
    .post("/v1/audio/transcription", async (c) => {
      const body = await c.req.json<TranscriptionCreateParams>();
      const model =
        typeof init.transcriptionModels === "function"
          ? await init.transcriptionModels(body.model)
          : init.transcriptionModels[body.model];
      if (!model) {
        throw new HTTPException(400, {
          message: "Invalid model",
        });
      }

      let audio: ArrayBuffer;
      if (body.file instanceof File || body.file instanceof Blob) {
        audio = await body.file.arrayBuffer();
      } else if (body.file instanceof Response) {
        audio = await body.file.arrayBuffer();
      } else if (isAsyncIterable(body.file)) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body.file) {
          chunks.push(new Uint8Array(chunk));
        }
        const totalLength = chunks.reduce(
          (sum, chunk) => sum + chunk.length,
          0,
        );
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        audio = result.buffer;
      } else {
        throw new HTTPException(400, {
          message: "Invalid file type",
        });
      }

      const generated = await transcribe({
        abortSignal: c.req.raw.signal,
        model,
        audio,
      });
      return c.json({
        text: generated.text,
        duration: generated.durationInSeconds,
        language: generated.language,
      } satisfies TranscriptionCreateResponse);
    });

  return app;
};

function isAsyncIterable(obj: any): obj is AsyncIterable<ArrayBuffer> {
  return (
    obj &&
    typeof obj[Symbol.asyncIterator] === "function" &&
    typeof obj.next === "function"
  );
}
