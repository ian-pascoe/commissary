// The shell's theme menu: follow the system, or pin Light or Dark (lib/theme.ts). A menu button with three radio
// items (lib/use-menu-button.ts): arrows, Home and End move between the items, Enter or Space picks one and closes the
// menu, Escape closes it, and both return focus to the button.
import { Check, type LucideIcon, Moon, Sun, SunMoon } from "lucide-react";
import { useEffect, useState } from "react";
import { useMenuButton } from "../lib/use-menu-button.ts";
import { onStoredThemeChange, readThemeChoice, storeThemeChoice } from "../lib/theme-document.ts";
import { THEME_CHOICES, type ThemeChoice } from "../lib/theme.ts";
import styles from "./BarMenu.module.css";

const OPTIONS: Record<ThemeChoice, { readonly label: string; readonly icon: LucideIcon }> = {
  system: { label: "System", icon: SunMoon },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

export const ThemeMenu = () => {
  const [choice, setChoice] = useState(readThemeChoice);
  // An open menu starts on the current choice.
  const menu = useMenuButton(() => THEME_CHOICES.indexOf(readThemeChoice()));

  useEffect(() => onStoredThemeChange(setChoice), []);

  const choose = (next: ThemeChoice) => {
    storeThemeChoice(next);
    setChoice(next);
    menu.close();
  };

  const Current = OPTIONS[choice].icon;

  return (
    <div ref={menu.root} className={styles["root"]}>
      <button
        type="button"
        className={styles["button"]}
        aria-label={`Theme: ${OPTIONS[choice].label}`}
        title={`Theme: ${OPTIONS[choice].label}`}
        {...menu.buttonProps}
      >
        <Current aria-hidden="true" size={18} strokeWidth={2.25} />
      </button>
      <div aria-label="Theme" className={styles["menu"]} {...menu.menuProps}>
        <p className={styles["caption"]} aria-hidden="true">
          Theme
        </p>
        {THEME_CHOICES.map((option, index) => {
          const { label, icon: Icon } = OPTIONS[option];

          return (
            <button
              key={option}
              ref={menu.item(index)}
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
