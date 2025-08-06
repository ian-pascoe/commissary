import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

interface EnvironmentMultiselectorProps {
  value?: Record<string, string>;
  onChange?: (value: Record<string, string>) => void;
  placeholder?: string;
  className?: string;
}

export function EnvironmentMultiselector({
  value = {},
  onChange,
  className,
}: EnvironmentMultiselectorProps) {
  const [envName, setEnvName] = useState("");
  const [envValue, setEnvValue] = useState("");

  const addEnvironmentVar = () => {
    const trimmedName = envName.trim();
    const trimmedValue = envValue.trim();
    if (!trimmedName || !trimmedValue) return;
    const newValue = {
      ...value,
      [trimmedName]: trimmedValue,
    };
    onChange?.(newValue);
    setEnvName("");
    setEnvValue("");
  };

  const removeEnvironmentVar = (envId: string) => {
    const newValue = { ...value };
    delete newValue[envId];
    onChange?.(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addEnvironmentVar();
    }
  };

  const envNames = useMemo(() => Object.keys(value), [value]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="env-name" className="font-medium text-sm">
            Variable Name
          </Label>
          <Input
            id="env-name"
            value={envName}
            onChange={(e) => setEnvName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="API_KEY"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="env-value" className="font-medium text-sm">
            Value
          </Label>
          <Input
            id="env-value"
            value={envValue}
            onChange={(e) => setEnvValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="your-api-key"
          />
        </div>
        <Button
          type="button"
          size="icon"
          onClick={addEnvironmentVar}
          disabled={!envName.trim() || !envValue.trim()}
          className="self-end"
        >
          <Plus />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {envNames.map((envName) => (
          <Button
            key={envName}
            variant="secondary"
            className="flex items-center justify-between gap-2 rounded-full"
            onClick={() => removeEnvironmentVar(envName)}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-xs">{envName}</span>
              <span className="truncate text-muted-foreground text-xs">
                {value[envName]}
              </span>
            </div>
            <div>
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {envName}</span>
            </div>
          </Button>
        ))}
      </div>
      {envNames.length > 0 && (
        <div className="text-muted-foreground text-sm">
          {envNames.length} environment variable
          {envNames.length === 1 ? "" : "s"} added
        </div>
      )}
    </div>
  );
}
