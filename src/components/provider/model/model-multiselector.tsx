import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

interface ModelMultiselectorProps {
  value?: Record<string, { name?: string }>;
  onChange?: (value: Record<string, { name?: string }>) => void;
  placeholder?: string;
  className?: string;
}

export function ModelMultiselector({
  value = {},
  onChange,
  className,
}: ModelMultiselectorProps) {
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");

  const addModel = () => {
    const trimmedId = modelId.trim();
    const trimmedName = modelName.trim();
    if (trimmedId && !value[trimmedId]) {
      onChange?.({
        ...value,
        [trimmedId]: { name: trimmedName || undefined },
      });
      setModelId("");
      setModelName("");
    }
  };

  const removeModel = (modelId: string) => {
    const newValue = { ...value };
    delete newValue[modelId];
    onChange?.(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addModel();
    }
  };

  const modelIds = Object.keys(value);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="model-id" className="font-medium text-sm">
            Model ID
          </Label>
          <Input
            id="model-id"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Model ID"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="model-name" className="font-medium text-sm">
            Name (optional)
          </Label>
          <Input
            id="model-name"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Display name"
          />
        </div>
        <Button
          type="button"
          onClick={addModel}
          disabled={!modelId.trim()}
          className="self-end"
        >
          Add Model
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {modelIds.map((modelId) => (
          <Button
            key={modelId}
            variant="secondary"
            className="flex items-center justify-between gap-2 rounded-full"
            onClick={() => removeModel(modelId)}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-xs">{modelId}</span>
              {value[modelId]?.name && (
                <span className="truncate text-muted-foreground text-xs">
                  {value[modelId].name}
                </span>
              )}
            </div>
            <div>
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {modelId}</span>
            </div>
          </Button>
        ))}
      </div>
      {modelIds.length > 0 && (
        <div className="text-muted-foreground text-sm">
          {modelIds.length} model{modelIds.length === 1 ? "" : "s"} added
        </div>
      )}
    </div>
  );
}
