// The shell's theme menu: follow the system, or pin Light or Dark (lib/theme.ts). A menu button with three radio
// items (WAI-ARIA menu button pattern): arrows, Home and End move between the items, Enter or Space picks one and
// closes the menu, Escape closes it, and both return focus to the button.
import { Check, type LucideIcon, Moon, Sun, SunMoon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { onStoredThemeChange, readThemeChoice, storeThemeChoice } from "../lib/theme-document.ts";
import { THEME_CHOICES, type ThemeChoice } from "../lib/theme.ts";
import styles from "./ThemeMenu.module.css";

const OPTIONS: Record<ThemeChoice, { readonly label: string; readonly icon: LucideIcon }> = {
  system: { label: "System", icon: SunMoon },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

const LAST = THEME_CHOICES.length - 1;

/** The item a key moves focus to from the focused `index`, wrapping at both ends; `undefined` for other keys. */
const menuMove = (key: string, index: number): number | undefined => {
  switch (key) {
    case "ArrowDown":
      return index >= LAST ? 0 : index + 1;
    case "ArrowUp":
      return index <= 0 ? LAST : index - 1;
    case "Home":
      return 0;
    case "End":
      return LAST;
    default:
      return undefined;
  }
};

export const ThemeMenu = () => {
  const [choice, setChoice] = useState(readThemeChoice);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => onStoredThemeChange(setChoice), []);

  // An open menu starts on the current choice; a press anywhere outside it closes it.
  useEffect(() => {
    if (!open) return;

    items.current[THEME_CHOICES.indexOf(readThemeChoice())]?.focus();

    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true)
        setOpen(false);
    };

    document.addEventListener("pointerdown", closeOutside);

    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const choose = (next: ThemeChoice) => {
    storeThemeChoice(next);
    setChoice(next);
    close();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.current.findIndex((item) => item === document.activeElement);

    const target = menuMove(event.key, index);

    if (target !== undefined) {
      event.preventDefault();
      items.current[target]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const Current = OPTIONS[choice].icon;

  return (
    <div ref={root} className={styles["root"]}>
      <button
        ref={button}
        type="button"
        className={styles["button"]}
        aria-label={`Theme: ${OPTIONS[choice].label}`}
        title={`Theme: ${OPTIONS[choice].label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onButtonKeyDown}
      >
        <Current aria-hidden="true" size={18} strokeWidth={2.25} />
      </button>
      <div
        id={menuId}
        role="menu"
        aria-label="Theme"
        hidden={!open}
        className={styles["menu"]}
        onKeyDown={onMenuKeyDown}
      >
        <p className={styles["caption"]} aria-hidden="true">
          Theme
        </p>
        {THEME_CHOICES.map((option, index) => {
          const { label, icon: Icon } = OPTIONS[option];

          return (
            <button
              key={option}
              ref={(item) => {
                items.current[index] = item;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={option === choice}
              tabIndex={-1}
              className={styles["item"]}
              onClick={() => choose(option)}
            >
              <Icon aria-hidden="true" size={16} strokeWidth={2.25} />
              {label}
              {option === choice && (
                <Check aria-hidden="true" size={16} strokeWidth={2.5} className={styles["check"]} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
