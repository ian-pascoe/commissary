/**
 * `GET /v9/management/models/catalog` and `POST /v9/management/models/catalog/refresh` (`CatalogGroup` in
 * @commissary/contract/catalog): the Models page's catalog status line and "Refresh catalog" button.
 *
 * Workers addition, no Go counterpart. The refresh is the cron task's operation (`refreshModelsDev`,
 * src/models/registry/refresh.ts) with the stored `models.catalog` setting, read from the ControlPlane so a setting just
 * saved applies. The catalog is shared by every org, so the setting is always the `global` org's (only its config can
 * set it, `config/store.ts`) and so is the refresh lease: a refresh from another org's panel refreshes the same shared
 * catalog from the same source. It is refused (`409 catalog_not_fetched`) when that setting means the catalog is not fetched (`embed`,
 * `disabled`), and while another refresh holds the refresh lease (`409 catalog_refresh_running`, the scheduled task's
 * included; nothing is downloaded). Anything else that goes wrong (download, size, validation, storage) is a `200` with
 * `status: "failed"` and a fixed message: the stored catalog stays. Admin-only and CSRF-protected like every management
 * write (Access gate over the `/v9/management` prefix).
 */
import { Effect } from "effect";
import { catalogMode, catalogStatus } from "../registry/catalog-status.ts";
import { refreshModelsDev } from "../registry/refresh.ts";
import { handled, jsonReply, replyError, CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { storedConfig } from "./settings-routes.ts";

const configured = storedConfig.pipe(
  Effect.map((current) => current.config.models.catalog),
  Effect.provideService(CurrentOrg, GLOBAL_ORG),
);

const status = Effect.gen(function* () {
  return jsonReply(200, yield* catalogStatus(yield* configured));
});

const MODE_NAMES = { embed: "Embedded copy", disabled: "Off" } as const;

const refresh = Effect.gen(function* () {
  const value = yield* configured;
  const { mode, problem } = catalogMode(value);

  if (mode === "embed" || mode === "disabled")
    return yield* replyError(409, "catalog_not_fetched", {
      message:
        problem === undefined
          ? `the catalog source is “${MODE_NAMES[mode]}” (models.catalog): the catalog is not fetched, so there is nothing to refresh`
          : `${problem}: the catalog is not fetched, so there is nothing to refresh`,
    });

  const outcome = yield* refreshModelsDev(value, "panel");

  if (outcome.status === "running")
    return yield* replyError(409, "catalog_refresh_running", {
      message: outcome.message ?? "another refresh is running",
    });

  // `skipped` cannot happen here: the modes that skip were refused above.
  const result = outcome.status === "skipped" ? "failed" : outcome.status;

  return jsonReply(200, {
    status: result,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
    ...(outcome.added === undefined ? {} : { added: outcome.added }),
    ...(outcome.removed === undefined ? {} : { removed: outcome.removed }),
    ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
    catalog: yield* catalogStatus(value),
  });
});

/** Needs `HttpClient` and `CatalogStore` (bound in `routes.ts`). */
export const catalogStatusHandler = handled(status);

export const catalogRefreshHandler = handled(refresh);
