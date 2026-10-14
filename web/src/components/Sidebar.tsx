// The shell's sidebar: which org the panel shows and the pages of the caller's role (`pageGroupsFor`, the only source
// of the links), grouped under small headings. Persistent on wide screens; below `WIDE` it is a drawer behind the
// bar's menu button: a modal <dialog>, so the page behind it is inert while it is open (focus stays in the drawer),
// Tab and Shift+Tab wrap around its controls, Escape closes it, and closing returns focus to the menu button. Following
// a link closes it too.
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { meAtom, panelOrgSlug } from "../api/client.ts";
import { canCreateOrg } from "../lib/hosted.ts";
import { orgPanelPath } from "../lib/org.ts";
import type { PageGroup } from "../lib/role.ts";
import { kit } from "./Kit.tsx";
import styles from "./Sidebar.module.css";

/** Where the sidebar stays in view; narrower screens get the drawer (`Sidebar.module.css` uses the same width). */
const WIDE = "(width >= 64rem)";

const CHOOSER = "/?choose";

/**
 * Which org the panel shows, and the way to another: the orgs the caller manages (`GET /me`), and the chooser where a
 * platform admin creates more. Nothing for a caller of one org who cannot create others.
 */
const OrgSwitcher = () => {
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me)) return null;
  const { orgs, platform_admin: platformAdmin } = me.value;
  // Where the caller may create orgs (everyone on a hosted proxy) the chooser is worth a way in.
  const creates = canCreateOrg(me.value);

  if (orgs.length < 2 && !creates) return null;
  const current = orgs.find((org) => org.slug === panelOrgSlug);

  return (
    <label className={`${kit["field"]} ${styles["org"]}`}>
      <span className={kit["fieldLabel"]}>Org</span>
      <select
        className={`${kit["input"]} ${styles["orgSelect"]}`}
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
    </label>
  );
};

/** The org switcher over the page links, group by group; `onNavigate` runs when a link is followed. */
const SideNav = ({
  groups,
  onNavigate,
}: {
  readonly groups: ReadonlyArray<PageGroup>;
  readonly onNavigate?: (() => void) | undefined;
}) => {
  const id = useId();

  return (
    <>
      <OrgSwitcher />
      <nav aria-label="Main" className={styles["nav"]}>
        {groups.map((group) => (
          <div key={group.id} className={styles["group"]}>
            {group.heading === undefined ? null : (
              <p id={`${id}-${group.id}`} className={styles["heading"]}>
                {group.heading}
              </p>
            )}
            <ul aria-labelledby={group.heading === undefined ? undefined : `${id}-${group.id}`}>
              {group.pages.map((page) => (
                <li key={page.to}>
                  <Link
                    to={page.to}
                    activeOptions={{ exact: page.to === "/" || page.exact === true }}
                    className={styles["link"]}
                    onClick={onNavigate}
                  >
                    <span className={styles["label"]}>{page.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
};

/** The persistent sidebar of wide screens (hidden by the stylesheet below `WIDE`). */
export const Sidebar = ({ groups }: { readonly groups: ReadonlyArray<PageGroup> }) => (
  <aside aria-label="Org and pages" className={styles["sidebar"]}>
    <div className={styles["sidebarBody"]}>
      <SideNav groups={groups} />
    </div>
  </aside>
);

/**
 * Tab past the drawer's last control comes back to its first, and Shift+Tab past the first goes to the last (the
 * WAI-ARIA dialog pattern): a modal <dialog> alone would let focus leave for the browser's own controls.
 */
const keepFocusIn = (event: KeyboardEvent<HTMLDialogElement>) => {
  if (event.key !== "Tab") return;

  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button, select"),
  ];

  const first = controls.at(0);
  const last = controls.at(-1);

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};

/** The bar's menu button of narrow screens and the drawer it opens. */
export const SidebarDrawer = ({ groups }: { readonly groups: ReadonlyArray<PageGroup> }) => {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const drawerId = useId();
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const element = dialog.current;

    if (element === null) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  // Another page (a link, Back, Forward) closes the drawer; so does a window wide enough for the sidebar.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);

    const closeWhenWide = () => {
      if (wide.matches) setOpen(false);
    };

    wide.addEventListener("change", closeWhenWide);

    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  return (
    <>
      <button
        type="button"
        className={styles["menuButton"]}
        aria-label="Menu"
        title="Menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen(true)}
      >
        <Menu aria-hidden="true" size={18} strokeWidth={2.25} />
      </button>
      <dialog
        ref={dialog}
        id={drawerId}
        aria-label="Org and pages"
        className={styles["drawer"]}
        onClose={() => setOpen(false)}
        onKeyDown={keepFocusIn}
        onClick={(event) => {
          // A press on the backdrop (the dialog itself, outside its content) closes it.
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        {/* Mounted only while open, so the page has one Main nav at a time. */}
        {open ? (
          <div className={styles["drawerBody"]}>
            <button
              type="button"
              className={styles["close"]}
              aria-label="Close menu"
              title="Close menu"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
            <SideNav groups={groups} onNavigate={() => setOpen(false)} />
          </div>
        ) : null}
      </dialog>
    </>
  );
};
