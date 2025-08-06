import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { toMerged } from "es-toolkit";
import { PlusIcon } from "lucide-react";
import mime from "mime";
import { useCallback, useMemo, useState } from "react";
import { type FileData, useChat } from "~/contexts/chat";
import { useModels } from "~/hooks/use-models";
import { useProvidersConfig } from "~/hooks/use-providers";
import { preloadedProviders } from "~/lib/preloaded-providers";
import { cn } from "~/lib/utils";
import type {
  ProviderConfig,
  ProviderModelConfig,
} from "~/schemas/config/provider";
import { ProviderIcon } from "../provider/icon";
import { Combobox, ComboboxContent, ComboboxTrigger } from "../ui/combobox";
import {
  AIInput,
  AIInputButton,
  AIInputSubmit,
  AIInputTextarea,
  AIInputToolbar,
  AIInputTools,
} from "../ui/kibo-ui/ai/input";
import { FileAttachments } from "./file-attachments";
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
    stop,
    messages,
    input,
    setInput,
    model,
    setModel,
    isListening,
    handleSubmit,
    status,
    setFileData,
  } = useChat((ctx) => ({
    stop: ctx.stop,
    messages: ctx.messages,
    input: ctx.input,
    setInput: ctx.setInput,
    model: ctx.model,
    setModel: ctx.setModel,
    isListening: ctx.isListening,
    handleSubmit: ctx.handleSubmit,
    status: ctx.status,
    setFileData: ctx.setFileData,
  }));

  const { data: models } = useModels();
  const { data: providersConfig } = useProvidersConfig();
  const resolvedProvidersConfig = useMemo(() => {
    const resolvedProvidersConfig = toMerged(
      providersConfig ?? {},
      preloadedProviders,
    );
    return Object.entries(resolvedProvidersConfig).reduce(
      (acc, [providerId, config]) => {
        acc[providerId] = {
          ...config,
          models: {
            ...config.models,
            ...Object.fromEntries(
              Object.entries(config.models ?? {}).map(
                ([modelId, modelConfig]) => [modelId, modelConfig],
              ),
            ),
            ...models?.data
              .filter((m) => m.owned_by === providerId)
              .reduce(
                (acc, model) => {
                  acc[model.id] = {};
                  return acc;
                },
                {} as Record<string, ProviderModelConfig>,
              ),
          },
        };
        return acc;
      },
      {} as Record<string, ProviderConfig>,
    );
  }, [providersConfig, models]);

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

  const history = useMemo(() => {
    return messages.filter((m) => m.role === "user");
  }, [messages]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        // Handle up arrow key press
        if (historyIndex < history.length - 1) {
          setHistoryIndex((prev) => prev + 1);
          const historyItem = history[history.length - 1 - (historyIndex + 1)];
          setInput(
            historyItem?.parts
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("") || "",
          );
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        // Handle down arrow key press
        if (historyIndex > -1) {
          setHistoryIndex((prev) => prev - 1);
          const historyItem = history[history.length - 1 - (historyIndex - 1)];
          setInput(
            historyItem?.parts
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("") || "",
          );
        }
      } else {
        if (historyIndex !== -1) {
          setHistoryIndex(-1);
        }
      }
    },
    [history, historyIndex, setInput],
  );

  return (
    <>
      <FileAttachments />
      <AIInput
        className={cn(
          "bg-background/70 backdrop-blur-md transition-all duration-200",
          isListening && "ring-2 ring-red-500/50",
          className,
        )}
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (status === "streaming") {
            stop();
          } else {
            handleSubmit(e);
            setHistoryIndex(-1);
          }
        }}
      >
        <AIInputTextarea
          disabled={isListening || disabled}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isListening ? "Listening..." : "Type your message here..."
          }
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={handleKeyDown}
        />
        <AIInputToolbar>
          <AIInputTools>
            <AIInputButton onClick={handleFileSelect}>
              <PlusIcon size={16} />
            </AIInputButton>
            <MicButton />
            <Combobox
              value={model}
              onValueChange={setModel}
              items={Object.entries(resolvedProvidersConfig)
                .flatMap(([providerId, providersConfig]) =>
                  Object.keys(providersConfig.models ?? {}).length
                    ? {
                        label: providersConfig.name || providerId,
                        labelComponent: (
                          <span className="flex items-center gap-1 border-b pb-2">
                            <ProviderIcon
                              providerId={providerId}
                              className="size-4"
                            />
                            {providersConfig.name || providerId}
                          </span>
                        ),
                        value: Object.entries(providersConfig.models ?? {}).map(
                          ([modelId, modelConfig]) => ({
                            label: modelConfig.name || modelId,
                            selectedLabelComponent: (
                              <span className="flex items-center gap-1">
                                <ProviderIcon
                                  providerId={providerId}
                                  className="size-4"
                                />
                                {modelConfig.name || modelId}
                              </span>
                            ),
                            value: `${providerId}:${modelId}`,
                          }),
                        ),
                      }
                    : null,
                )
                .filter((i) => i !== null)}
            >
              <ComboboxTrigger className="w-fit min-w-[200px] max-w-[350px]" />
              <ComboboxContent
                align="start"
                className="min-w-[300px] max-w-[350px]"
              />
            </Combobox>
          </AIInputTools>
          <AIInputSubmit disabled={disabled} status={status} />
        </AIInputToolbar>
      </AIInput>
    </>
  );
};
