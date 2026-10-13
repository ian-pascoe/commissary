/**
 * The move from config admin lists to members (ADR 0022). New in the Workers port, no Go counterpart.
 *
 * Before members, `global` was managed by the platform admins plus the config document's `access.admin-emails` and
 * `access.admin-service-tokens`. The first time a ControlPlane is used after the upgrade, those people keep their
 * rights as members of `global`: the platform admins of the time become org owners, the config admins org admins, the
 * admin service tokens service tokens with the owner role (they could download credentials before, ADR 0006). The
 * lists then leave the config. In any other org the lists never granted anything, so they are only removed.
 */
import type { ConfigStore } from "../config/store.ts";
import type { MemberStore } from "./store.ts";

/**
 * Runs the migration once per ControlPlane (a no-op afterwards). `platformAdminEmails`: `PLATFORM_ADMIN_EMAILS` (and
 * its deprecated alias) at the time. Members and config change in one transaction (the stores share the storage).
 */
export const migrateLegacyAdmins = (
  config: ConfigStore,
  members: MemberStore,
  platformAdminEmails: Iterable<string>,
  transaction: <T>(body: () => T) => T = (body) => body(),
): void => {
  if (members.adminsMigrated()) return;
  const lists = config.legacyAdmins();

  transaction(() => {
    members.migrateAdmins({
      owners: [...platformAdminEmails],
      admins: lists.emails,
      serviceTokens: lists.serviceTokens,
    });
    config.dropLegacyAdmins();
  });
};
