// The services of Models' management routes (`ManagementServicesLive` of `@commissary/models/management`) with the
// outbound HTTP client replaced, for harnesses that mock the providers.
import { Layer } from "effect";
import type { HttpClient } from "effect/http";
import { CatalogStore } from "../../src/registry/catalog-store.ts";
import { ModelRegistryLive } from "../../src/registry/live.ts";

/** `ManagementServicesLive` with `http` in place of the global `fetch`. */
export const managementServicesWith = (http: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.mergeAll(ModelRegistryLive, http, CatalogStore.layer);
