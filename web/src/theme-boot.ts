// Applies the stored theme choice before the first paint, so a page never flashes the other theme. The CSP allows no
// inline script, so vite.config.ts builds this file on its own into a classic, render-blocking script under /assets
// and puts it at the end of <head>, after the metas it updates.
import { applyThemeChoice, readThemeChoice } from "./lib/theme-document.ts";

applyThemeChoice(readThemeChoice());
