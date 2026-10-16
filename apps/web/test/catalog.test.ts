// The Models page's catalog line and refresh outcome (src/lib/catalog.ts).
import { describe, expect, it } from "@effect/vitest";
import type { CatalogRefresh, CatalogStatus } from "@commissary/contract/catalog";
import { catalogLine, catalogProblem, refreshHint, refreshNote } from "../src/lib/catalog.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");

const status = (extra: Partial<CatalogStatus> = {}): CatalogStatus => ({
  mode: "official",
  stored: true,
  refreshed_at: "2026-10-12T10:00:00Z",
  models: { anthropic: 10 },
  ...extra,
});

const refreshed = (extra: Partial<CatalogRefresh> = {}): CatalogRefresh => ({
  status: "updated",
  catalog: status(),
  ...extra,
});

describe("catalogLine", () => {
  it("says when the stored catalog was refreshed and from where", () => {
    expect(catalogLine(status(), NOW)).toBe("Catalog refreshed 2 h ago · from models.dev");
    expect(catalogLine(status({ mode: "custom", source_host: "catalog.example.test" }), NOW)).toBe(
      "Catalog refreshed 2 h ago · from catalog.example.test",
    );
    expect(catalogLine(status({ refreshed_at: "2026-10-12T11:59:40Z" }), NOW)).toBe(
      "Catalog refreshed just now · from models.dev",
    );
  });

  it("names the shipped copy while nothing is stored", () => {
    const { refreshed_at: _, ...rest } = status({ stored: false });

    expect(catalogLine(rest, NOW)).toBe("Catalog: shipped copy · from models.dev");
  });

  it("says what the embedded and Off sources mean", () => {
    expect(catalogLine(status({ mode: "embed", stored: false }), NOW)).toBe(
      "Catalog: embedded copy · never fetched",
    );
    expect(
      catalogLine(
        status({ mode: "disabled", source_problem: "models.catalog must be an http(s) URL" }),
        NOW,
      ),
    ).toBe("Catalog refresh is off · models.catalog must be an http(s) URL");
    expect(catalogLine(status({ mode: "disabled" }), NOW)).toBe(
      "Catalog refresh is off · last refreshed 2 h ago",
    );
    expect(catalogLine(status({ mode: "disabled", stored: false }), NOW)).toBe(
      "Catalog refresh is off · shipped copy",
    );
  });
});

describe("catalogProblem", () => {
  const failed = (at: string) => ({
    last_attempt: { at, status: "failed" as const, message: "catalog source answered HTTP 503" },
  });

  it("reports a failure after the last success only", () => {
    expect(catalogProblem(status(failed("2026-10-12T11:00:00Z")))).toBe(
      "The last refresh failed: catalog source answered HTTP 503. The catalog in use is unchanged.",
    );
    expect(catalogProblem(status(failed("2026-10-12T09:00:00Z")))).toBeUndefined();
    expect(catalogProblem(status())).toBeUndefined();
  });

  it("reports a failure when nothing was ever stored", () => {
    const { refreshed_at: _, ...rest } = status({
      stored: false,
      ...failed("2026-10-12T11:00:00Z"),
    });

    expect(catalogProblem(rest)).toContain("The last refresh failed");
  });
});

describe("refreshHint", () => {
  it("turns the button off, with the reason, when nothing is fetched", () => {
    expect(refreshHint(status())).toBeUndefined();
    expect(refreshHint(status({ mode: "custom" }))).toBeUndefined();
    expect(refreshHint(status({ mode: "embed" }))).toContain("Embedded copy");
    expect(refreshHint(status({ mode: "disabled" }))).toContain("Off");
    expect(
      refreshHint(
        status({ mode: "disabled", source_problem: "models.catalog must be an http(s) URL" }),
      ),
    ).toContain("must be an http(s) URL");
  });
});

describe("refreshNote", () => {
  it("counts the models an update added and removed", () => {
    expect(refreshNote({ ok: true, value: refreshed({ added: 3, removed: 1 }) })).toEqual({
      tone: "done",
      text: "Catalog updated: 3 models added, 1 model removed.",
    });
    expect(refreshNote({ ok: true, value: refreshed({ added: 2, removed: 0 }) }).text).toBe(
      "Catalog updated: 2 models added.",
    );
    expect(refreshNote({ ok: true, value: refreshed({ added: 0, removed: 0 }) }).text).toBe(
      "Catalog updated: no served models changed.",
    );
  });

  it("says how many entries of the document were left out", () => {
    expect(
      refreshNote({ ok: true, value: refreshed({ added: 1, removed: 0, skipped: 2 }) }).text,
    ).toBe(
      "Catalog updated: 1 model added. 2 entries in the document could not be read and were left out.",
    );
  });

  it("says when nothing was new", () => {
    expect(refreshNote({ ok: true, value: refreshed({ status: "unchanged" }) })).toEqual({
      tone: "done",
      text: "The catalog is already up to date.",
    });
  });

  it("gives the reason a refresh failed and that the catalog stayed", () => {
    expect(
      refreshNote({
        ok: true,
        value: refreshed({ status: "failed", message: "catalog source answered HTTP 503" }),
      }),
    ).toEqual({
      tone: "problem",
      text: "Refresh failed: catalog source answered HTTP 503. The catalog in use is unchanged.",
    });
  });

  it("explains a refresh refused because another one runs, and other refusals", () => {
    expect(
      refreshNote({
        ok: false,
        message: "Catalog_refresh_running.",
        error: "catalog_refresh_running",
        detail: "a refresh started by the panel is still running",
      }).text,
    ).toBe("A refresh is already running. Wait a moment, then try again.");

    expect(
      refreshNote({
        ok: false,
        message: "Catalog_not_fetched.",
        error: "catalog_not_fetched",
        detail: "the catalog source is “Off”",
      }).text,
    ).toBe("Could not refresh the catalog. the catalog source is “Off”");
  });
});
