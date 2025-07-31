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
    const startTime = performance.now();
    const transport = this.delegator();
    console.log(
      "[Performance] Delegating sendMessages to transport:",
      transport,
    );

    const stream = await transport.sendMessages(options);
    const delegationTime = performance.now() - startTime;
    console.log(
      `[Performance] Delegation setup completed in ${delegationTime.toFixed(2)}ms`,
    );

    // Track chunks flowing through the delegator
    let firstChunkThroughDelegator = false;
    const firstChunkDelegatorStart = performance.now();

    const transformedStream = new TransformStream({
      transform(chunk, controller) {
        if (!firstChunkThroughDelegator) {
          firstChunkThroughDelegator = true;
          const timeToFirstChunk = performance.now() - firstChunkDelegatorStart;
          console.log(
            `[Performance] 🎯 First chunk through delegator after ${timeToFirstChunk.toFixed(2)}ms (total from delegation start: ${(performance.now() - startTime).toFixed(2)}ms)`,
          );
        }
        controller.enqueue(chunk);
      },
    });

    return stream.pipeThrough(transformedStream);
  }
  async reconnectToStream(
    options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const transport = this.delegator();
    return transport.reconnectToStream(options);
  }
}
