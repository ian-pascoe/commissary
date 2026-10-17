/**
 * Static `registry.LookupModelInfo` over the embedded catalog, for the Gemini request shaping (`shaping.ts`): the
 * output token limit of a model.
 */
import {
  embeddedCatalogs,
  lookupStaticModelInfo,
  lookupStaticModelInfoByChannel,
} from "../../registry/catalog.ts";
import type { ModelInfo } from "../../registry/model-info.ts";

/** Static `LookupModelInfo(model, provider)`: the provider's catalog section first, then every section. */
export const lookupModelInfo = (model: string, provider: string): ModelInfo | undefined => {
  const catalogs = embeddedCatalogs();

  return (
    lookupStaticModelInfoByChannel(catalogs, model, provider) ??
    lookupStaticModelInfo(catalogs, model)
  );
};
