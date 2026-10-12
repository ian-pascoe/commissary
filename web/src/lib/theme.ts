// The colour theme. The panel follows the system's light or dark preference unless the operator picks Light or Dark
// in the shell; that choice is kept in localStorage. `theme-document.ts` applies it to the page (before the first
// paint through `theme-boot.ts`, and again whenever the shell's theme menu changes it); the stylesheets do the rest:
// `data-theme` on <html> pins the root's color-scheme, which resolves every light-dark() token (styles/tokens.css).

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The localStorage key of a Light or Dark choice; following the system stores nothing. */
export const THEME_STORAGE_KEY = "cf-llm-proxy.theme";

/** A stored value as a choice; anything else (nothing stored, an old or foreign value) follows the system. */
export const parseThemeChoice = (stored: string | null): ThemeChoice =>
  stored === "light" || stored === "dark" ? stored : "system";

/**
 * The `media` of the `theme-color` meta for one scheme: the system's preference decides, unless a choice pins one
 * scheme on (`all`) and the other off (`not all`).
 */
export const themeColorMedia = (choice: ThemeChoice, scheme: "light" | "dark"): string => {
  if (choice === "system") return `(prefers-color-scheme: ${scheme})`;

  return choice === scheme ? "all" : "not all";
};

/** The `color-scheme` meta's content: both while following the system, else the chosen one. */
export const colorSchemeContent = (choice: ThemeChoice): string =>
  choice === "system" ? "light dark" : choice;
