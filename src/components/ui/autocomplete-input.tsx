import { Command as CommandPrimitive } from "cmdk";
import { Check } from "lucide-react";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "./command";
import { Input } from "./input";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { Skeleton } from "./skeleton";

type AutoCompleteInputProps<T extends string> = Omit<
  ComponentProps<typeof CommandPrimitive.Input>,
  "asChild" | "value" | "onValueChange"
> & {
  selectedValue: T;
  onSelectedValueChange: (value: T) => void;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  items: { value: T; label: string }[];
  isLoading?: boolean;
  emptyMessage?: string;
  resetOnSelect?: boolean;
  allowCustomValues?: boolean;
};

export function AutoCompleteInput<T extends string>({
  selectedValue,
  onSelectedValueChange,
  searchValue,
  onSearchValueChange,
  items,
  isLoading,
  emptyMessage = "No items.",
  resetOnSelect = false,
  allowCustomValues = false,
  placeholder = "Select an option...",
  onKeyDown: propsOnKeyDown,
  onMouseDown: propsOnMouseDown,
  onBlur: propsOnBlur,
  onFocus: propsOnFocus,
  ...props
}: AutoCompleteInputProps<T>) {
  const [open, setOpen] = useState(false);

  const labels = useMemo(
    () =>
      items.reduce(
        (acc, item) => {
          acc[item.value] = item.label;
          return acc;
        },
        {} as Record<string, string>,
      ),
    [items],
  );

  const reset = useCallback(() => {
    onSelectedValueChange("" as T);
    onSearchValueChange("");
  }, [onSelectedValueChange, onSearchValueChange]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      setOpen(e.key !== "Escape");
      propsOnKeyDown?.(e);
    },
    [propsOnKeyDown],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      setOpen((open) => !!searchValue || !open);
      propsOnMouseDown?.(e);
    },
    [propsOnMouseDown, searchValue],
  );

  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (
        !e.relatedTarget?.hasAttribute("cmdk-list") &&
        labels[selectedValue] !== searchValue
      ) {
        if (allowCustomValues && searchValue.trim()) {
          onSelectedValueChange(searchValue.trim() as T);
        } else {
          reset();
        }
      }
      propsOnBlur?.(e);
    },
    [
      propsOnBlur,
      labels,
      reset,
      searchValue,
      selectedValue,
      allowCustomValues,
      onSelectedValueChange,
    ],
  );

  const onFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setOpen(true);
      propsOnFocus?.(e);
    },
    [propsOnFocus],
  );

  const onSelectItem = useCallback(
    (inputValue: string) => {
      if (inputValue === selectedValue && resetOnSelect) {
        reset();
      } else {
        onSelectedValueChange(inputValue as T);
        onSearchValueChange(labels[inputValue] ?? inputValue);
      }
      setOpen(false);
    },
    [
      reset,
      onSelectedValueChange,
      onSearchValueChange,
      labels,
      selectedValue,
      resetOnSelect,
    ],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <CommandPrimitive>
        <PopoverAnchor asChild>
          <CommandPrimitive.Input
            asChild
            value={searchValue}
            onValueChange={onSearchValueChange}
            onKeyDown={onKeyDown}
            onMouseDown={onMouseDown}
            onBlur={onBlur}
            onFocus={onFocus}
            placeholder={placeholder}
            {...props}
          >
            <Input />
          </CommandPrimitive.Input>
        </PopoverAnchor>
        {!open && <CommandList aria-hidden="true" className="hidden" />}
        <PopoverContent
          asChild
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (
              e.target instanceof Element &&
              e.target.hasAttribute("cmdk-input")
            ) {
              e.preventDefault();
            }
          }}
          className="w-(--radix-popover-trigger-width) p-0"
        >
          <CommandList>
            {isLoading && (
              <CommandPrimitive.Loading>
                <div className="p-1">
                  <Skeleton className="h-6 w-full" />
                </div>
              </CommandPrimitive.Loading>
            )}
            {items.length > 0 && !isLoading ? (
              <CommandGroup>
                {items.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onMouseDown={(e) => e.preventDefault()}
                    onSelect={onSelectItem}
                    className="flex items-center justify-between"
                  >
                    {option.label}
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedValue === option.value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {allowCustomValues &&
            searchValue.trim() &&
            !items.some(
              (item) =>
                item.value.toLowerCase() === searchValue.toLowerCase() ||
                item.label.toLowerCase() === searchValue.toLowerCase(),
            ) &&
            !isLoading ? (
              <CommandGroup>
                <CommandItem
                  value={searchValue.trim()}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => onSelectItem(searchValue.trim())}
                >
                  {searchValue.trim()}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {!isLoading ? (
              <CommandEmpty>{emptyMessage ?? "No items."}</CommandEmpty>
            ) : null}
          </CommandList>
        </PopoverContent>
      </CommandPrimitive>
    </Popover>
  );
}
