/**
 * Deleting an org's data (ADR 0027), new in the Workers port: an org that is deleted leaves nothing behind. One call
 * removes, in this order:
 *
 * 1. its usage records in D1 (`deleteOrgUsage`),
 * 2. the `SessionState` instances it registered (`session-state/instances.ts`), each wiped,
 * 3. its keys in the `CACHE` KV namespace (the names `org.<org>.…` of `orgScopedName`),
 * 4. its ControlPlane's whole storage: credentials, config entries, members, API keys, private data, OAuth logins and
 *    the refresh alarm (`ControlPlane.wipeOrg`),
 * 5. and last its Platform registry entry (the org, its people's index and its service tokens), which frees the slug.
 *
 * The registry entry goes last so a deletion that stops half way can be run again: the org is still listed, and every
 * earlier step finds less to do. Each call may use at most {@link DELETION_BUDGET} subrequests (a Worker invocation has
 * a limit); a big org answers `incomplete` and the caller runs the deletion again. `global` is never deleted.
 */
import type { ModelsBindings } from "../models/env.ts";
import type { StateBindings } from "../state/env.ts";
import { deleteOrgUsage } from "../usage/d1.ts";
import { controlPlaneOf, GLOBAL_ORG, type OrgId } from "./org.ts";
import { platformOf } from "./registry.ts";

/** The most Durable Object, KV and D1 calls one deletion makes before it asks to be run again. */
export const DELETION_BUDGET = 400;

/** `SessionState` instances wiped between two reads of the registered ones. */
const INSTANCES_PER_READ = 50;

/** Keys read and deleted per page: each key is one KV call. */
const KV_PAGE = 100;

export type OrgDeletion =
  | { readonly state: "deleted" }
  | { readonly state: "incomplete"; readonly step: "usage" | "sessions" | "cache" }
  | {
      readonly state: "refused";
      readonly reason: "global" | "not_found";
      readonly message: string;
    };

export interface DeletionOptions {
  /** Epoch ms, the caller's clock. */
  readonly now: number;
  /** Overrides {@link DELETION_BUDGET} (tests). */
  readonly budget?: number;
}

/**
 * Deletes every trace of `org`; see the module comment. Never rejects for an org that is already half deleted. `models`
 * holds the Models data (usage records, `CACHE` keys), `state` the Durable Objects.
 */
export const deleteOrg = async (
  state: StateBindings,
  models: Pick<ModelsBindings, "USAGE" | "CACHE">,
  org: OrgId,
  options: DeletionOptions,
): Promise<OrgDeletion> => {
  if (org === GLOBAL_ORG)
    return { state: "refused", reason: "global", message: "the first org cannot be deleted" };

  let budget = options.budget ?? DELETION_BUDGET;
  const plane = controlPlaneOf(state, org);

  // 1. Usage: each batch is one D1 call; the helper bounds its own loop.
  const usage = await deleteOrgUsage(models.USAGE, org);
  budget -= usage.calls;

  if (!usage.complete) return { state: "incomplete", step: "usage" };

  // 2. The SessionState instances the org registered.
  for (;;) {
    if (budget < INSTANCES_PER_READ + 2) return { state: "incomplete", step: "sessions" };
    const names = await plane.sessionInstances(options.now, INSTANCES_PER_READ);
    budget -= 1;

    if (names.length === 0) break;

    await Promise.all(names.map(async (name) => await state.SESSION_STATE.getByName(name).wipe()));
    budget -= names.length;
    await plane.forgetSessionInstances(names);
    budget -= 1;
  }

  // 3. KV: keys of the org, a page at a time.
  const prefix = `org.${org}.`;

  for (;;) {
    if (budget < KV_PAGE + 2) return { state: "incomplete", step: "cache" };
    const page = await models.CACHE.list({ prefix, limit: KV_PAGE });
    budget -= 1;

    await Promise.all(page.keys.map(async (key) => await models.CACHE.delete(key.name)));
    budget -= page.keys.length;

    if (page.list_complete) break;
  }

  // 4. The ControlPlane's storage.
  await plane.wipeOrg();

  // 5. The registry entry, last.
  const removed = await platformOf(state).deleteOrg(org);

  if (!removed.ok && removed.error !== "not_found")
    return { state: "refused", reason: removed.error, message: removed.message };

  return { state: "deleted" };
};
