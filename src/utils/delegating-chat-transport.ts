import type {
  ChatRequestOptions,
  ChatTransport,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UITools,
} from "ai";

export class DelegatingChatTransport implements ChatTransport<UIMessage> {
  private readonly delegator: () => ChatTransport<UIMessage>;
  constructor(options: {
    delegator: () => ChatTransport<UIMessage>;
  }) {
    this.delegator = options.delegator;
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
    const transport = this.delegator();
    console.log("Delegating sendMessages to transport:", transport);
    return transport.sendMessages(options);
  }
  async reconnectToStream(
    options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const transport = this.delegator();
    return transport.reconnectToStream(options);
  }
}
