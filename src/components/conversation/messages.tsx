import { useMutation } from "@tanstack/react-query";
import { downloadDir, join } from "@tauri-apps/api/path";
import { writeFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileIcon } from "lucide-react";
import mime from "mime";
import { toast } from "sonner";
import { useChat } from "~/contexts/chat";
import { useUser } from "~/hooks/use-auth";
import { Button } from "../ui/button";
import {
  AIConversation,
  AIConversationContent,
  AIConversationScrollButton,
} from "../ui/kibo-ui/ai/conversation";
import { AIMessage, AIMessageContent } from "../ui/kibo-ui/ai/message";
import { AIResponse } from "../ui/kibo-ui/ai/response";

export type ConversationMessagesProps = {
  className?: string;
};

export const ConversationMessages = ({
  className,
}: ConversationMessagesProps) => {
  const user = useUser();
  const { messages } = useChat((ctx) => ({
    messages: ctx.messages,
  }));
  const downloadMutation = useMutation({
    mutationFn: async (url: string) => {
      let downloadPath: string;
      // download the file, accounting for data URLs
      if (url.startsWith("data:")) {
        // Data URL
        const dataUrlMatch = url.match(/^data:(.+);base64,(.*)$/);
        if (!dataUrlMatch) {
          throw new Error("Invalid data URL");
        }
        const mimeType = dataUrlMatch[1]!;
        const base64Data = dataUrlMatch[2]!;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });

        downloadPath = await join(
          await downloadDir(),
          `commissary_${Date.now()}.${mime.getExtension(mimeType) || "txt"}`,
        );
        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(downloadPath, new Uint8Array(arrayBuffer));
      } else {
        // Regular URL
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to download file: ${response.statusText}`);
        }
        downloadPath = await join(
          await downloadDir(),
          url.split("/").pop() || `commissary_${Date.now()}.txt`,
        );
        await writeFile(
          downloadPath,
          new Uint8Array(await response.arrayBuffer()),
        );
      }
      // Open the file in the default application
      await openPath(downloadPath);
    },
    onMutate: () => {
      const toastId = toast.loading("Downloading file...");
      return { toastId };
    },
    onSuccess: (_, __, context) => {
      if (context?.toastId) {
        toast.dismiss(context.toastId);
      }
      toast.success("File opened in default application");
    },
    onError: (error, __, context) => {
      if (context?.toastId) {
        toast.dismiss(context.toastId);
      }
      toast.error(
        `Failed to open file: ${error.message ?? JSON.stringify(error)}`,
      );
    },
    onSettled: (_, __, ___, context) => {
      if (context?.toastId) {
        toast.dismiss(context.toastId);
      }
    },
  });

  return (
    <AIConversation className={className}>
      <AIConversationContent>
        {messages.map((message) => (
          <AIMessage
            key={message.id}
            from={message.role as "user" | "assistant"}
            className="[&>div]:max-w-full"
          >
            <AIMessageContent>
              <div className="flex flex-col gap-2">
                {message.parts.map((part, index) => {
                  const key = `${message.id}-${index}`;
                  switch (part.type) {
                    case "text": {
                      return <AIResponse key={key}>{part.text}</AIResponse>;
                    }
                    case "file": {
                      return (
                        <Button
                          key={key}
                          onClick={() => downloadMutation.mutate(part.url)}
                        >
                          <FileIcon size={16} />
                          {part.filename || "Unnamed File"}
                        </Button>
                      );
                    }
                    default: {
                      return null;
                    }
                  }
                })}
              </div>
            </AIMessageContent>
          </AIMessage>
        ))}
        <AIConversationScrollButton
          variant="default"
          className="bottom-32 z-50"
        />
        <div className="h-36" />
      </AIConversationContent>
    </AIConversation>
  );
};
