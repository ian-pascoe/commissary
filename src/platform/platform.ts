/**
 * `Platform` Durable Object: the Platform registry (ADR 0021), one object per deployment (`platformOf`, registry.ts).
 * It holds what spans orgs: the list of orgs, an index of which orgs each person and each Access service token belong to
 * (the orgs' ControlPlanes stay authoritative for membership), and the lease that keeps one refresh of the shared model
 * catalog at a time. It stays out of the request path for clients, which name their org with their proxy key. New in the
 * Workers port.
 *
 * The platform admins are not stored here: the deployment's variables name them, so they can always repair this
 * registry. Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
import { DurableObject } from "cloudflare:workers";
import { type SweepSource, SweepLeaseStore, type TakeLease } from "../quota/sweep-lease.ts";
import {
  type IndexRepair,
  type OrgIndex,
  type OrgInput,
  type OrgPatch,
  type OrgRecord,
  type OrgWriteResult,
  PlatformStore,
} from "./registry-store.ts";

export class Platform extends DurableObject<Env> {
  readonly #store: PlatformStore;
  readonly #catalogLease: SweepLeaseStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new PlatformStore(ctx.storage.sql);

    // The shared catalog's refresh lease lived in the ControlPlane of `global` before the registry existed.
    this.#catalogLease = new SweepLeaseStore(
      ctx.storage.sql,
      () => Date.now(),
      "catalog_refresh_lease",
    );
  }

  /** Every org: the seeded `global` first, then oldest first. */
  listOrgs(): ReadonlyArray<OrgRecord> {
    return this.#store.listOrgs();
  }

  getOrgBySlug(slug: string): OrgRecord | undefined {
    return this.#store.orgBySlug(slug);
  }

  getOrgById(id: string): OrgRecord | undefined {
    return this.#store.orgById(id);
  }

  /** `now` is the caller's clock (Effect `Clock`, so tests control it). */
  createOrg(input: OrgInput, now: number = Date.now()): OrgWriteResult {
    return this.#store.createOrg(input, now);
  }

  /** Renames the org addressed by `slug` (its name, its slug, or both). */
  updateOrg(slug: string, patch: OrgPatch): OrgWriteResult {
    return this.#store.updateOrg(slug, patch);
  }

  orgsOfEmail(email: string): ReadonlyArray<OrgRecord> {
    return this.#store.orgsOfEmail(email);
  }

  orgOfServiceToken(clientId: string): OrgRecord | undefined {
    return this.#store.orgOfServiceToken(clientId);
  }

  /** Rebuilds one org's membership index from the lists its ControlPlane holds. */
  replaceOrgIndex(org: string, index: OrgIndex): IndexRepair {
    return this.#store.replaceOrgIndex(org, index);
  }

  /** The shared model catalog's refresh lease (`SweepLeaseStore`): taken at the start of a download. */
  takeCatalogRefreshLease(source: SweepSource): TakeLease {
    return this.#catalogLease.take(source);
  }

  releaseCatalogRefreshLease(token: string): void {
    this.#catalogLease.release(token);
  }
}
