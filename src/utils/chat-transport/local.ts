import type { LanguageModelV2 } from "@openrouter/ai-sdk-provider";
import type {
  experimental_MCPClient as McpClient,
  ModelMessage,
  ToolSet,
} from "ai";
import {
  type ChatRequestOptions,
  type ChatTransport,
  convertToModelMessages,
  createUIMessageStream,
  smoothStream,
  stepCountIs,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { LRUCache } from "lru-cache";
import * as z from "zod";
import type { Config } from "~/schemas/config";
import anthropicSpoof from "../../prompts/anthropic-spoof.txt?raw";
import { constructLocalModel } from "../construct-local-model";

export const LocalChatTransportBody = z.object({
  modelId: z.string().min(1),
});

// Global model cache shared across all LocalChatTransport instances
export const globalModelCache = new LRUCache<string, LanguageModelV2>({
  max: 20,
  ttl: 1000 * 60 * 5, // 5 minutes
});

// Simple hash function for creating cache keys
function createHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

export class LocalChatTransport<Message extends UIMessage>
  implements ChatTransport<Message>
{
  private readonly providersConfig: Config["providers"];
  private readonly mcpClients: Record<string, McpClient> | undefined;
  private readonly mcpConfig: Config["mcp"];

  constructor({
    providersConfig,
    mcpClients,
    mcpConfig,
  }: {
    providersConfig: Config["providers"];
    mcpClients: Record<string, McpClient> | undefined;
    mcpConfig: Config["mcp"];
  }) {
    this.providersConfig = providersConfig;
    this.mcpClients = mcpClients;
    this.mcpConfig = mcpConfig;
  }

  private createCacheKey(modelId: string): string {
    // Create a deterministic string representation of providers and modelId
    const sortedKeys = Object.keys(this.providersConfig ?? {}).sort();
    const providersString = JSON.stringify(this.providersConfig, sortedKeys);
    const cacheData = `${modelId}:${providersString}`;
    return createHash(cacheData);
  }

  private async getOrCreateModel(modelId: string) {
    const cacheKey = this.createCacheKey(modelId);

    // Check if model is already cached
    const cachedModel = globalModelCache.get(cacheKey);
    if (cachedModel) {
      return cachedModel;
    }

    // Construct new model and cache it
    const model = await constructLocalModel({
      modelId,
      providersConfig: this.providersConfig,
    });

    globalModelCache.set(cacheKey, model);
    return model;
  }

  async sendMessages(
    options: {
      chatId: string;
      messages: Message[];
      abortSignal: AbortSignal | undefined;
    } & {
      trigger: "submit-message" | "regenerate-message";
      messageId: string | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const body = LocalChatTransportBody.parse(options.body);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const model = await this.getOrCreateModel(body.modelId);

        let system = ["You are a helpful assistant."];
        if ((model as any).needsAnthropicSpoof) {
          system = [anthropicSpoof, ...system];
        }

        const convertedMessages = convertToModelMessages(options.messages);

        const toolPromises = Object.values(this.mcpClients ?? {}).map(
          async (mcpClient) => {
            const tools = await mcpClient.tools();
            Object.keys(tools).forEach((toolName) => {
              if (
                this.mcpConfig &&
                Object.values(this.mcpConfig).some((cfg) =>
                  cfg.excludeTools?.includes(toolName),
                )
              ) {
                console.log(
                  `[MCP] Excluding tool "${toolName}" from MCP client due to configuration`,
                );
                delete tools[toolName];
              }
            });
            return tools;
          },
        );
        const toolResults = await Promise.all(toolPromises);
        const tools: ToolSet = toolResults.reduce(
          (acc, toolSet) => ({ ...acc, ...toolSet }),
          {},
        );

        const result = streamText({
          model,
          messages: [
            ...system.map(
              (s) =>
                ({
                  role: "system",
                  content: s,
                }) satisfies ModelMessage,
            ),
            ...convertedMessages,
          ],
          tools,
          abortSignal: options.abortSignal,
          stopWhen: [stepCountIs(100)],
          experimental_transform: [smoothStream()],
        });

        const uiStream = result.toUIMessageStream();
        writer.merge(uiStream);
      },
      onError: (error) => {
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
