import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

interface HeaderMultiselectorProps {
  value?: Record<string, string>;
  onChange?: (value: Record<string, string>) => void;
  placeholder?: string;
  className?: string;
}

export function HeaderMultiselector({
  value = {},
  onChange,
  className,
}: HeaderMultiselectorProps) {
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");

  const addHeader = () => {
    const trimmedName = headerName.trim();
    const trimmedValue = headerValue.trim();
    if (!trimmedName || !trimmedValue) return;
    const newValue = {
      ...value,
      [trimmedName]: trimmedValue,
    };
    onChange?.(newValue);
  };

  const removeHeader = (headerId: string) => {
    const newValue = { ...value };
    delete newValue[headerId];
    onChange?.(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addHeader();
    }
  };

  const headerNames = useMemo(() => Object.keys(value), [value]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="header-name" className="font-medium text-sm">
            Name
          </Label>
          <Input
            id="header-name"
            value={headerName}
            onChange={(e) => setHeaderName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="header-value" className="font-medium text-sm">
            Value
          </Label>
          <Input
            id="header-value"
            value={headerValue}
            onChange={(e) => setHeaderValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Value"
          />
        </div>
        <Button
          type="button"
          size="icon"
          onClick={addHeader}
          disabled={!headerName.trim() || !headerValue.trim()}
          className="self-end"
        >
          <Plus />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {headerNames.map((headerName) => (
          <Button
            key={headerName}
            variant="secondary"
            className="flex items-center justify-between gap-2 rounded-full"
            onClick={() => removeHeader(headerName)}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-xs">{headerName}</span>
              <span className="truncate text-muted-foreground text-xs">
                {value[headerName]}
              </span>
            </div>
            <div>
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {headerName}</span>
            </div>
          </Button>
        ))}
      </div>
      {headerNames.length > 0 && (
        <div className="text-muted-foreground text-sm">
          {headerNames.length} header{headerNames.length === 1 ? "" : "s"} added
        </div>
      )}
    </div>
  );
}
