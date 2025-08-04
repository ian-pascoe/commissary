import type { experimental_MCPClient as McpClient, ToolSet } from "ai";
import {
  type ChatRequestOptions,
  type ChatTransport,
  convertToModelMessages,
  createUIMessageStream,
  type LanguageModel,
  smoothStream,
  streamText,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
  type UITools,
} from "ai";
import { LRUCache } from "lru-cache";
import * as z from "zod";
import type { Config } from "~/schemas/config";
import { constructLocalModel } from "../construct-local-model";

export const LocalChatTransportBody = z.object({
  modelId: z.string().min(1),
});

// Global model cache shared across all LocalChatTransport instances
export const globalModelCache = new LRUCache<string, LanguageModel>({
  max: 20,
  ttl: 1000 * 60 * 5, // 5 minutes
});

// Simple hash function for creating cache keys
function createHash(data: string): string {
  const startTime = performance.now();
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const result = hash.toString(36);
  const hashTime = performance.now() - startTime;

  if (hashTime > 0.1) {
    // Only log if hash takes more than 0.1ms (for large data)
    console.log(
      `[Performance] Hash generation took ${hashTime.toFixed(3)}ms for ${data.length} characters`,
    );
  }

  return result;
}

export class LocalChatTransport implements ChatTransport<UIMessage> {
  private readonly providersConfig: Config["providers"];
  private readonly mcpClients: Map<string, McpClient> | undefined;

  constructor({
    providersConfig,
    mcpClients,
  }: {
    providersConfig: Config["providers"];
    mcpClients: Map<string, McpClient> | undefined;
  }) {
    this.providersConfig = providersConfig;
    this.mcpClients = mcpClients;
  }

  private createCacheKey(modelId: string): string {
    const startTime = performance.now();

    // Create a deterministic string representation of providers and modelId
    const sortedKeys = Object.keys(this.providersConfig ?? {}).sort();
    const providersString = JSON.stringify(this.providersConfig, sortedKeys);
    const cacheData = `${modelId}:${providersString}`;
    const cacheKey = createHash(cacheData);

    const cacheKeyTime = performance.now() - startTime;
    console.log(
      `[Performance] Cache key generation for modelId "${modelId}" took ${cacheKeyTime.toFixed(2)}ms:`,
      {
        modelId,
        providersKeys: sortedKeys,
        cacheData:
          cacheData.substring(0, 100) + (cacheData.length > 100 ? "..." : ""),
        cacheKey,
      },
    );

    return cacheKey;
  }

  private async getOrCreateModel(modelId: string): Promise<LanguageModel> {
    const overallStart = performance.now();
    const cacheKey = this.createCacheKey(modelId);

    const cacheLookupStart = performance.now();
    console.log(`[Performance] Cache lookup for key "${cacheKey}":`, {
      cacheSize: globalModelCache.size,
      cacheKeys: Array.from(globalModelCache.keys()),
      hasKey: globalModelCache.has(cacheKey),
    });

    // Check if model is already cached
    const cachedModel = globalModelCache.get(cacheKey);
    const cacheLookupTime = performance.now() - cacheLookupStart;

    if (cachedModel) {
      const totalTime = performance.now() - overallStart;
      console.log(
        `[Performance] ✅ Using cached model for ${modelId} (cache lookup: ${cacheLookupTime.toFixed(2)}ms, total: ${totalTime.toFixed(2)}ms)`,
      );
      return cachedModel;
    }

    // Construct new model and cache it
    const modelCreateStart = performance.now();
    console.log(`[Performance] 🏗️ Creating new model for ${modelId}`);
    const model = await constructLocalModel({
      modelId,
      providers: this.providersConfig,
    });
    const modelCreateTime = performance.now() - modelCreateStart;

    const cacheSetStart = performance.now();
    globalModelCache.set(cacheKey, model);
    const cacheSetTime = performance.now() - cacheSetStart;

    const totalTime = performance.now() - overallStart;
    console.log(
      `[Performance] 💾 Cached model for ${modelId} (create: ${modelCreateTime.toFixed(2)}ms, cache set: ${cacheSetTime.toFixed(2)}ms, total: ${totalTime.toFixed(2)}ms)`,
    );
    return model;
  }

  async sendMessages(
    options: {
      chatId: string;
      messages: UIMessage<unknown, UIDataTypes, UITools>[];
      abortSignal: AbortSignal | undefined;
    } & {
      trigger: "submit-message" | "regenerate-message";
      messageId: string | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const startTime = performance.now();
    const messageCount = options.messages.length;

    console.log(
      `[Performance] Starting sendMessages for chat ${options.chatId} with ${messageCount} messages`,
    );

    const parseStart = performance.now();
    const body = LocalChatTransportBody.parse(options.body);
    const parseTime = performance.now() - parseStart;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const modelStart = performance.now();
        const model = await this.getOrCreateModel(body.modelId);
        const modelTime = performance.now() - modelStart;

        const convertStart = performance.now();
        const convertedMessages = convertToModelMessages(options.messages);
        const convertTime = performance.now() - convertStart;

        const toolStart = performance.now();
        const toolPromises = Array.from(this.mcpClients?.values() ?? []).map(
          (mcpClient) => mcpClient.tools(),
        );
        const toolResults = await Promise.all(toolPromises);
        const tools: ToolSet = toolResults.reduce(
          (acc, toolSet) => ({ ...acc, ...toolSet }),
          {},
        );
        const toolTime = performance.now() - toolStart;

        const streamStart = performance.now();
        const result = streamText({
          model,
          messages: convertedMessages,
          tools,
          abortSignal: options.abortSignal,
          experimental_transform: [smoothStream()],
        });
        const streamSetupTime = performance.now() - streamStart;

        console.log(
          `[Performance] Stream setup completed (parse: ${parseTime.toFixed(2)}ms, model: ${modelTime.toFixed(2)}ms, convert: ${convertTime.toFixed(2)}ms, tools: ${toolTime.toFixed(2)}ms, stream: ${streamSetupTime.toFixed(2)}ms)`,
        );

        const mergeStart = performance.now();
        const uiStream = result.toUIMessageStream();
        const uiStreamTime = performance.now() - mergeStart;

        // Track time to first chunk
        let firstChunkReceived = false;
        let firstChunkProcessed = false;
        const firstChunkStart = performance.now();

        // Wrap the stream to track first chunk timing at multiple stages
        const transformedStream = new TransformStream({
          transform(chunk, controller) {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              const timeToFirstChunk = performance.now() - firstChunkStart;
              console.log(
                `[Performance] ⚡ First chunk received in transform after ${timeToFirstChunk.toFixed(2)}ms (total time from start: ${(performance.now() - startTime).toFixed(2)}ms)`,
              );
              console.log(`[Performance] First chunk details:`, {
                type: chunk.type,
                hasText: "text" in chunk ? chunk.text?.length || 0 : "N/A",
                hasData: "data" in chunk ? !!chunk.data : "N/A",
              });
            }

            // Track when chunk is actually enqueued
            const enqueueStart = performance.now();
            controller.enqueue(chunk);
            const enqueueTime = performance.now() - enqueueStart;

            if (!firstChunkProcessed) {
              firstChunkProcessed = true;
              console.log(
                `[Performance] 🚀 First chunk enqueued after ${enqueueTime.toFixed(3)}ms (total processing: ${(performance.now() - firstChunkStart).toFixed(2)}ms)`,
              );
            }
          },
        });

        console.log(
          `[Performance] About to merge stream (ui stream setup: ${uiStreamTime.toFixed(2)}ms)`,
        );

        const writerMergeStart = performance.now();
        writer.merge(uiStream.pipeThrough(transformedStream));
        const writerMergeTime = performance.now() - writerMergeStart;

        const totalTime = performance.now() - startTime;
        console.log(
          `[Performance] sendMessages completed (ui stream: ${uiStreamTime.toFixed(2)}ms, writer merge: ${writerMergeTime.toFixed(2)}ms, total: ${totalTime.toFixed(2)}ms)`,
        );
      },
      onError: (error) => {
        const totalTime = performance.now() - startTime;
        console.log(
          `[Performance] sendMessages failed after ${totalTime.toFixed(2)}ms:`,
          error,
        );
        return error instanceof Error ? error.message : String(error);
      },
    });
    return stream;
  }

  async reconnectToStream(
    _options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    throw new Error("Method not implemented.");
  }
}
