import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

interface ToolsMultiselectorProps {
  value?: string[];
  onChange?: (value: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function ToolsMultiselector({
  value = [],
  onChange,
  className,
}: ToolsMultiselectorProps) {
  const [toolName, setToolName] = useState("");

  const addTool = () => {
    const trimmedName = toolName.trim();
    if (!trimmedName || value.includes(trimmedName)) return;
    const newValue = [...value, trimmedName];
    onChange?.(newValue);
    setToolName("");
  };

  const removeTool = (toolToRemove: string) => {
    const newValue = value.filter((tool) => tool !== toolToRemove);
    onChange?.(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTool();
    }
  };

  const tools = useMemo(() => value || [], [value]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="tool-name" className="font-medium text-sm">
            Tool Name
          </Label>
          <Input
            id="tool-name"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="file_reader"
          />
        </div>
        <Button
          type="button"
          size="icon"
          onClick={addTool}
          disabled={!toolName.trim() || value.includes(toolName.trim())}
          className="self-end"
        >
          <Plus />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tools.map((tool) => (
          <Button
            key={tool}
            variant="secondary"
            className="flex items-center justify-between gap-2 rounded-full"
            onClick={() => removeTool(tool)}
          >
            <span className="truncate font-medium text-xs">{tool}</span>
            <div>
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {tool}</span>
            </div>
          </Button>
        ))}
      </div>
      {tools.length > 0 && (
        <div className="text-muted-foreground text-sm">
          {tools.length} tool{tools.length === 1 ? "" : "s"} excluded
        </div>
      )}
    </div>
  );
}
