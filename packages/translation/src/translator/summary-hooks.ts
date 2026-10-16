/**
 * The reasoning-summary hooks the translator registry runs around request transforms.
 *
 * Go source: sdk/translator/registry.go (the summary extraction before and application after a request transform),
 * internal/thinking/summary.go (`ExtractTranslatedSummaryConfig`, `ApplySummaryConfigForModel`).
 */
import { Predicate } from "effect";
import {
  applySummaryConfigForModel,
  extractTranslatedSummaryConfig,
  type SummaryConfig,
  UNSPECIFIED_SUMMARY,
} from "../thinking/index.ts";
import type { SummaryHooks } from "./registry.ts";

const isSummaryConfig = (value: unknown): value is SummaryConfig =>
  Predicate.hasProperty(value, "mode") && Predicate.hasProperty(value, "detail");

/** Summary hooks run by the translator registry around request transforms (`sdk/translator/registry.go`). */
export const summaryHooks: SummaryHooks = {
  extract: (body, client, provider) => extractTranslatedSummaryConfig(body, client, provider),
  apply: (body, provider, model, summary) =>
    applySummaryConfigForModel(
      body,
      provider,
      model,
      isSummaryConfig(summary) ? summary : UNSPECIFIED_SUMMARY,
    ) ?? body,
};
