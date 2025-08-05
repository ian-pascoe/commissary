"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

type Item = {
  label: string;
  value: string | Item[];
};

export type ComboboxContextType = {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  value: string | undefined;
  setValue: React.Dispatch<React.SetStateAction<string | undefined>>;
  items: Item[];
};

const ComboboxContext = React.createContext<ComboboxContextType | null>(null);

export function useComboboxContext() {
  const ctx = React.useContext(ComboboxContext);
  if (ctx === null) {
    throw new Error("useComboboxContext must be used within a Combobox");
  }
  return ctx;
}

export type ComboboxProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  value?: string;
  onValueChange?: (value?: string) => void;
  defaultValue?: string;
  valuePlaceholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  items: Item[];
  children: React.ReactNode;
};

export function Combobox(props: ComboboxProps) {
  const [open, setOpen] = useControllableState({
    prop: props.open,
    defaultProp: props.defaultOpen ?? false,
    onChange: props.onOpenChange,
  });
  const [value, setValue] = useControllableState({
    prop: props.value,
    defaultProp: props.defaultValue,
    onChange: props.onValueChange,
  });

  return (
    <ComboboxContext.Provider
      value={{
        open,
        setOpen,
        value,
        setValue,
        items: props.items,
      }}
    >
      <Popover open={open} onOpenChange={setOpen}>
        {props.children}
      </Popover>
    </ComboboxContext.Provider>
  );
}

export type ComboboxTriggerProps = Omit<
  React.ComponentProps<typeof Button>,
  "children"
> & {
  placeholder?: string;
};
export function ComboboxTrigger({
  className,
  placeholder = "Select an option...",
  ...props
}: ComboboxTriggerProps) {
  const { value, open, items } = useComboboxContext();

  const findItemByValue = React.useCallback(
    (items: Item[], searchValue: string): Item | undefined => {
      for (const item of items) {
        if (typeof item.value === "string" && item.value === searchValue) {
          return item;
        }
        if (Array.isArray(item.value)) {
          const found = findItemByValue(item.value, searchValue);
          if (found) return found;
        }
      }
      return undefined;
    },
    [],
  );

  return (
    <PopoverTrigger asChild>
      {/* biome-ignore lint/a11y/useSemanticElements: shadcn/ui */}
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className={cn("w-[200px] justify-between", className)}
        {...props}
      >
        <span className="truncate">
          {value ? findItemByValue(items, value)?.label : placeholder}
        </span>
        <ChevronsUpDown className="opacity-50" />
      </Button>
    </PopoverTrigger>
  );
}

export type ComboboxContentProps = Omit<
  React.ComponentProps<typeof PopoverContent>,
  "children"
> & {
  placeholder?: string;
  emptyText?: string;
};
export function ComboboxContent({
  className,
  placeholder = "Search...",
  emptyText = "No options found.",
  ...props
}: ComboboxContentProps) {
  const { value, setValue, setOpen, items } = useComboboxContext();

  const renderItems = React.useCallback(
    (items: Item[]): React.ReactNode => {
      return items.map((item, index) => {
        if (typeof item.value === "string") {
          // Leaf item - render as CommandItem
          return (
            <CommandItem
              key={item.value}
              value={item.value}
              keywords={[item.value, item.label]}
              onSelect={(currentValue) => {
                setValue(currentValue === value ? "" : currentValue);
                setOpen(false);
              }}
            >
              {item.label}
              <Check
                className={cn(
                  "ml-auto",
                  value === item.value ? "opacity-100" : "opacity-0",
                )}
              />
            </CommandItem>
          );
        } else {
          // Group item - render as CommandGroup with nested items
          return (
            <CommandGroup key={`${item.label}-${index}`} heading={item.label}>
              {renderItems(item.value)}
            </CommandGroup>
          );
        }
      });
    },
    [value, setValue, setOpen],
  );

  return (
    <PopoverContent
      className={cn(
        "w-(--radix-popover-trigger-width) min-w-[250px] p-0",
        className,
      )}
      {...props}
    >
      <Command>
        <CommandInput placeholder={placeholder} className="h-9" />
        <CommandList>
          <CommandEmpty>{emptyText}</CommandEmpty>
          {renderItems(items)}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}
