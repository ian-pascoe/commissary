import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { GlobeIcon, PlusIcon } from "lucide-react";
import mime from "mime";
import { useCallback } from "react";
import { type FileData, useChat } from "~/contexts/chat";
import { cn } from "~/lib/utils";
import {
  AIInput,
  AIInputButton,
  AIInputModelSelect,
  AIInputModelSelectContent,
  AIInputModelSelectItem,
  AIInputModelSelectTrigger,
  AIInputModelSelectValue,
  AIInputSubmit,
  AIInputTextarea,
  AIInputToolbar,
  AIInputTools,
} from "../ui/kibo-ui/ai/input";
import { MicButton } from "./mic-button";

export type ConversationInputProps = {
  disabled?: boolean;
  className?: string;
};

export const ConversationInput = ({
  disabled = false,
  className,
}: ConversationInputProps) => {
  const {
    input,
    setInput,
    model,
    setModel,
    isListening,
    handleSubmit,
    status,
    setFileData,
    resolvedProviders,
  } = useChat((ctx) => ({
    input: ctx.input,
    setInput: ctx.setInput,
    model: ctx.model,
    setModel: ctx.setModel,
    isListening: ctx.isListening,
    setIsListening: ctx.setIsListening,
    handleSubmit: ctx.handleSubmit,
    status: ctx.status,
    setFileData: ctx.setFileData,
    resolvedProviders: ctx.resolvedProviders,
  }));

  const handleFilesSelected = useCallback(
    async (paths: string[]) => {
      const fileData = await Promise.all(
        paths.map(async (path) => {
          const fileContent = await readFile(path);
          const mediaType = mime.getType(path) || "text/plain";
          const base64Content = btoa(String.fromCharCode(...fileContent));
          return {
            path: path,
            filename: path.split("/").pop(),
            mediaType,
            url: `data:${mediaType};base64,${base64Content}`,
          } satisfies FileData;
        }),
      );
      setFileData(fileData);
    },
    [setFileData],
  );

  const handleFileSelect = useCallback(async () => {
    const filePaths = await openDialog({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "PDFs, Text, Images",
          extensions: ["pdf", "txt", "png", "jpg", "jpeg", "gif"],
        },
      ],
    });
    if (filePaths) {
      handleFilesSelected(filePaths);
    }
  }, [handleFilesSelected]);

  return (
    <AIInput
      className={cn(
        "rounded-b-none bg-background/70 backdrop-blur-md transition-all duration-200",
        isListening && "ring-2 ring-red-500/50",
        className,
      )}
      onSubmit={handleSubmit}
    >
      <AIInputTextarea
        disabled={isListening || disabled}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={isListening ? "Listening..." : "Type your message here..."}
      />
      <AIInputToolbar>
        <AIInputTools>
          <AIInputButton onClick={handleFileSelect}>
            <PlusIcon size={16} />
          </AIInputButton>
          <MicButton />
          <AIInputButton>
            <GlobeIcon size={16} />
            <span>Search</span>
          </AIInputButton>
          <AIInputModelSelect value={model} onValueChange={setModel}>
            <AIInputModelSelectTrigger>
              <AIInputModelSelectValue />
            </AIInputModelSelectTrigger>
            <AIInputModelSelectContent>
              {Object.entries(resolvedProviders).map(
                ([provider, { models = {} }]) =>
                  Object.entries(models).map(([modelId, { name }]) => (
                    <AIInputModelSelectItem
                      key={modelId}
                      value={`${provider}:${modelId}`}
                    >
                      {provider}:{name ?? modelId}
                    </AIInputModelSelectItem>
                  )),
              )}
            </AIInputModelSelectContent>
          </AIInputModelSelect>
        </AIInputTools>
        <AIInputSubmit disabled={!input || disabled} status={status} />
      </AIInputToolbar>
    </AIInput>
  );
};
