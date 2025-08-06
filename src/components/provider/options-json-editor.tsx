import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

interface JsonEditorProps {
  value?: Record<string, any>;
  onChange?: (value: Record<string, any>) => void;
  className?: string;
  placeholder?: string;
}

export function JsonEditor({
  value = {},
  onChange,
  className,
  placeholder = "Enter JSON options...",
}: JsonEditorProps) {
  const [jsonText, setJsonText] = useState(() => {
    return Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "";
  });
  const [error, setError] = useState<string | null>(null);

  const validateAndUpdate = (text: string) => {
    setJsonText(text);

    if (text.trim() === "") {
      setError(null);
      onChange?.({});
      return;
    }

    try {
      const parsed = JSON.parse(text);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        setError("JSON must be an object");
        return;
      }
      setError(null);
      onChange?.(parsed);
    } catch (e) {
      console.error("Invalid JSON:", e);
      setError("Invalid JSON syntax");
    }
  };

  const formatJson = () => {
    try {
      if (jsonText.trim() === "") return;
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);
      setJsonText(formatted);
    } catch (_e) {
      // Do nothing if JSON is invalid
    }
  };

  const clearJson = () => {
    setJsonText("");
    setError(null);
    onChange?.({});
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <Label htmlFor="json-editor" className="font-medium text-sm">
          Provider Options (JSON)
        </Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={formatJson}
            disabled={!jsonText.trim() || !!error}
          >
            Format
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearJson}
            disabled={!jsonText.trim()}
          >
            Clear
          </Button>
        </div>
      </div>
      <Textarea
        id="json-editor"
        value={jsonText}
        onChange={(e) => validateAndUpdate(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "min-h-[120px] font-mono text-sm",
          error && "border-destructive focus:border-destructive",
        )}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
      {!error && jsonText.trim() && (
        <p className="text-muted-foreground text-sm">
          Valid JSON object with {Object.keys(value).length} propert
          {Object.keys(value).length === 1 ? "y" : "ies"}
        </p>
      )}
    </div>
  );
}
