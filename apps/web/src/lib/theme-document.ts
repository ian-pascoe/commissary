// Reading, keeping and applying the theme choice (lib/theme.ts) in the browser: localStorage, <html data-theme> and
// the color-scheme and theme-color metas of index.html.
import {
  colorSchemeContent,
  parseThemeChoice,
  THEME_STORAGE_KEY,
  themeColorMedia,
  type ThemeChoice,
} from "./theme.ts";

/** The stored choice; storage that is unavailable (blocked, private mode) reads as following the system. */
export const readThemeChoice = (): ThemeChoice => {
  try {
    return parseThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
};

/** Point <html> and the color-scheme and theme-color metas at a choice. */
export const applyThemeChoice = (choice: ThemeChoice) => {
  const root = document.documentElement;

  if (choice === "system") root.removeAttribute("data-theme");
  else root.dataset["theme"] = choice;

  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", colorSchemeContent(choice));

  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = meta.getAttribute("data-scheme");

    if (scheme === "light" || scheme === "dark")
      meta.setAttribute("media", themeColorMedia(choice, scheme));
  }
};

/** Keep and apply a choice; "system" forgets the stored one. Unavailable storage still applies it to this page. */
export const storeThemeChoice = (choice: ThemeChoice) => {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not kept: the choice lasts until the page is reloaded.
  }

  applyThemeChoice(choice);
};

/** Follow a choice made in another tab of the panel; returns the unsubscribe. */
export const onStoredThemeChange = (listener: (choice: ThemeChoice) => void) => {
  const handle = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      const choice = readThemeChoice();

      applyThemeChoice(choice);
      listener(choice);
    }
  };

  window.addEventListener("storage", handle);

  return () => window.removeEventListener("storage", handle);
};
