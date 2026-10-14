// A menu button on the shell bar (WAI-ARIA menu button pattern), shared by the theme and account menus: arrows, Home
// and End move between the items, Escape closes the menu and returns focus to the button, Tab closes it, and a press
// anywhere outside closes it.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

/** The item a key moves focus to from the focused `index` of `count` items, wrapping at both ends. */
const menuMove = (key: string, index: number, count: number): number | undefined => {
  const last = count - 1;

  switch (key) {
    case "ArrowDown":
      return index >= last ? 0 : index + 1;
    case "ArrowUp":
      return index <= 0 ? last : index - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return undefined;
  }
};

/** `start`: the item an opening menu focuses first. */
export const useMenuButton = (start: () => number = () => 0) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const first = useRef(start);

  first.current = start;

  useEffect(() => {
    if (!open) return undefined;

    items.current[first.current()]?.focus();

    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true)
        setOpen(false);
    };

    document.addEventListener("pointerdown", closeOutside);

    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  /** Closes the menu and puts focus back on its button. */
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const present = items.current.filter((item) => item !== null);
    const index = present.findIndex((item) => item === document.activeElement);
    const target = menuMove(event.key, index, present.length);

    if (target !== undefined) {
      event.preventDefault();
      present[target]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  /** Registers the item at `index` (a ref callback). */
  const item = (index: number) => (element: HTMLButtonElement | null) => {
    items.current[index] = element;
  };

  return {
    open,
    close,
    root,
    item,
    buttonProps: {
      ref: button,
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
      "aria-controls": menuId,
      onClick: () => setOpen((wasOpen) => !wasOpen),
      onKeyDown: onButtonKeyDown,
    },
    menuProps: { id: menuId, role: "menu" as const, hidden: !open, onKeyDown: onMenuKeyDown },
  };
};
