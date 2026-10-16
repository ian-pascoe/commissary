/**
 * Where the model catalog comes from: the `models.catalog` setting (`config/schema.ts`) as a source. Shared by the
 * refresh (`refresh.ts`), the readers (`catalog-store.ts`, `opencode-catalog.ts`) and the panel's status
 * (`catalog-status.ts`). Imports nothing, so every one of them can use it.
 */

/** Where the models.dev document comes from by default. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

export type CatalogSource =
  | { readonly mode: "fetch"; readonly url: string }
  | { readonly mode: "embed" }
  | { readonly mode: "disabled"; readonly reason?: string };

/** `models.catalog` config value: empty = the official URL, `embed`/`disabled`, otherwise one http(s) URL. */
export const resolveSource = (configured: string): CatalogSource => {
  const value = configured.trim();

  if (value === "") return { mode: "fetch", url: MODELS_DEV_URL };

  if (value === "embed") return { mode: "embed" };

  if (value === "disabled") return { mode: "disabled" };

  try {
    const url = new URL(value);

    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "")
      return { mode: "fetch", url: value };
  } catch {
    // Falls through to the rejection below.
  }

  return { mode: "disabled", reason: "must be an http(s) URL" };
};

/** Whether the setting asks for the catalog compiled into the Worker only (the stored copy is not read). */
export const usesEmbeddedCatalog = (configured: string): boolean =>
  resolveSource(configured).mode === "embed";
