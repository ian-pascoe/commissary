// The shell bar's org switcher, right of the name: which org the panel shows, and the way to another. The orgs are
// the ones the caller belongs to (`GET /me`); the chooser at the end is where a caller who may create orgs makes more.
// A caller of one org who cannot create others sees nothing.
import { useAtomValue } from "@effect/atom-react";
import { ChevronDown } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { meAtom, panelOrgSlug } from "../api/client.ts";
import { canCreateOrg } from "../lib/hosted.ts";
import { orgPanelPath } from "../lib/org.ts";
import { kit } from "./Kit.tsx";
import styles from "./OrgSwitcher.module.css";

const CHOOSER = "/?choose";

export const OrgSwitcher = () => {
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me)) return null;
  const { orgs, platform_admin: platformAdmin } = me.value;
  // Where the caller may create orgs (everyone on Commissary Cloud) the chooser is worth a way in.
  const creates = canCreateOrg(me.value);

  if (orgs.length < 2 && !creates) return null;
  const current = orgs.find((org) => org.slug === panelOrgSlug);

  return (
    <label className={styles["org"]}>
      <span className={kit["visuallyHidden"]}>Org</span>
      <select
        className={styles["select"]}
        value={current?.slug ?? panelOrgSlug ?? ""}
        onChange={(event) => {
          const slug = event.target.value;

          // A full load: the typed client addresses its org once, from the address the panel was opened at.
          window.location.assign(slug === CHOOSER ? CHOOSER : orgPanelPath(slug));
        }}
      >
        {current === undefined && panelOrgSlug !== undefined ? (
          <option value={panelOrgSlug}>{panelOrgSlug}</option>
        ) : null}
        {orgs.map((org) => (
          <option key={org.slug} value={org.slug}>
            {org.name}
          </option>
        ))}
        {creates ? (
          <option value={CHOOSER}>{platformAdmin ? "All orgs…" : "Your orgs…"}</option>
        ) : null}
      </select>
      <ChevronDown aria-hidden="true" size={16} strokeWidth={2.5} className={styles["chevron"]} />
    </label>
  );
};
