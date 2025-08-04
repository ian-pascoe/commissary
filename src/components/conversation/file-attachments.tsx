import { X } from "lucide-react";
import { useCallback } from "react";
import { useChat } from "~/contexts/chat";
import { AISuggestion, AISuggestions } from "../ui/kibo-ui/ai/suggestion";

export const FileAttachments = () => {
  const { fileData, setFileData } = useChat((ctx) => ({
    fileData: ctx.fileData,
    setFileData: ctx.setFileData,
  }));

  const handleFileRemove = useCallback(
    (path: string) => {
      setFileData((prev) => prev.filter((f) => f.path !== path));
    },
    [setFileData],
  );

  if (!fileData.length) return null;

  return (
    <AISuggestions>
      {fileData.map((file) => (
        <AISuggestion
          key={file.path}
          suggestion={file.path}
          onClick={(suggestion) => handleFileRemove(suggestion)}
          className="bg-background/70 text-xs backdrop-blur-md"
        >
          <span>{file.filename || file.path}</span>
          <X size={16} />
        </AISuggestion>
      ))}
    </AISuggestions>
  );
};
