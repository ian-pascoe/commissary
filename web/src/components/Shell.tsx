// The page frame: the shell bar (name and host, page links, Connect account, Refresh, the theme menu) above the page.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  credentialsAtom,
  meAtom,
  panelOrgSlug,
  usageEpochAtom,
  usageLastDayAtom,
} from "../api/client.ts";
import { orgPanelPath } from "../lib/org.ts";
import { AsyncResult } from "effect/reactivity";
import { NotAllowed } from "../pages/NotAllowed.tsx";
import { canManageMembers, homeFor, pageAllowed, pagesFor } from "../lib/role.ts";
import { type RoleState, useRole } from "../lib/use-role.ts";
import { canCreateOrg } from "../lib/hosted.ts";
import { DeleteAccount } from "./DeleteAccount.tsx";
import { Problem } from "./Kit.tsx";
import styles from "./Shell.module.css";
import { SignOut } from "./SignOut.tsx";
import { ThemeMenu } from "./ThemeMenu.tsx";

const RefreshIcon = ({
  busy,
  onRefresh,
}: {
  readonly busy: boolean;
  readonly onRefresh: () => void;
}) => (
  <button
    type="button"
    className={styles["refresh"]}
    aria-label="Refresh"
    title="Refresh"
    aria-busy={busy}
    onClick={onRefresh}
  >
    <RefreshCw
      aria-hidden="true"
      size={18}
      strokeWidth={2.25}
      className={busy ? styles["spinning"] : undefined}
    />
  </button>
);

/** A plain member's Refresh: their usage only (they may not read the accounts). */
const UsageRefresh = () => {
  const usage = useAtomValue(usageLastDayAtom);
  const bumpUsage = useAtomSet(usageEpochAtom);

  return <RefreshIcon busy={usage.waiting} onRefresh={() => bumpUsage((epoch) => epoch + 1)} />;
};

/** An org admin's Refresh: the accounts and the usage. */
const OrgAdminRefresh = () => {
  const credentials = useAtomValue(credentialsAtom);
  const usage = useAtomValue(usageLastDayAtom);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const bumpUsage = useAtomSet(usageEpochAtom);

  return (
    <RefreshIcon
      busy={credentials.waiting || usage.waiting}
      onRefresh={() => {
        refreshCredentials();
        bumpUsage((epoch) => epoch + 1);
      }}
    />
  );
};

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
    <label className={styles["org"]}>
      <span className={styles["orgLabel"]}>Org</span>
      <select
        className={styles["orgSelect"]}
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

/** Sign out, on a hosted proxy only: a self-hosted panel has no session of its own (Cloudflare Access holds it). */
const AccountSignOut = () => {
  const me = useAtomValue(meAtom);

  return AsyncResult.isSuccess(me) && me.value.hosted === true ? (
    <SignOut className={styles["signOut"]} />
  ) : null;
};

/**
 * Narrow screens scroll the page links sideways: keep the current page's link in view, and mark which ends of the
 * strip have more links beyond them (the stylesheet fades those edges).
 */
const usePageLinkStrip = () => {
  const nav = useRef<HTMLElement>(null);
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const strip = nav.current;

    if (strip === null) return;

    const mark = () => {
      strip.dataset["start"] = String(strip.scrollLeft <= 1);
      strip.dataset["end"] = String(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    };

    mark();
    strip.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);

    return () => {
      strip.removeEventListener("scroll", mark);
      window.removeEventListener("resize", mark);
    };
  }, []);

  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return nav;
};

/** The page, once the caller's role is known and opens it; otherwise what is going on instead. */
const Gate = ({ role }: { readonly role: RoleState }) => {
  const pathname = useLocation({ select: (location) => location.pathname });

  switch (role.kind) {
    case "loading":
      return (
        <p aria-busy="true" className={styles["gate"]}>
          Loading…
        </p>
      );
    case "failed":
      return (
        <div className={styles["gate"]}>
          <Problem onRetry={role.retry}>Could not check your access to this org.</Problem>
        </div>
      );
    case "ready":
      // A plain member's home is Usage.
      if (
        pathname === "/" &&
        !pageAllowed(role.caller.role, pathname, role.caller.privateCredentials)
      )
        return <Navigate to={homeFor(role.caller.role)} replace />;

      return pageAllowed(role.caller.role, pathname, role.caller.privateCredentials) ? (
        <Outlet />
      ) : (
        <NotAllowed home={homeFor(role.caller.role)} />
      );
  }
};

export const Shell = () => {
  const nav = usePageLinkStrip();
  const role = useRole();

  const pages =
    role.kind === "ready" ? pagesFor(role.caller.role, role.caller.privateCredentials) : [];

  const admin = role.kind === "ready" && canManageMembers(role.caller);
  // A plain member connects private accounts where the org allows it (ADR 0023).
  const connects = admin || (role.kind === "ready" && role.caller.privateCredentials);

  return (
    <>
      <a className={styles["skip"]} href="#main">
        Skip to content
      </a>
      <header className={styles["bar"]}>
        <div className={styles["inner"]}>
          <Link
            to={role.kind === "ready" ? homeFor(role.caller.role) : "/"}
            className={styles["brand"]}
          >
            <span className={styles["name"]}>cf-llm-proxy</span>
            <span className={styles["host"]} title={window.location.host}>
              {window.location.host}
            </span>
          </Link>
          <nav ref={nav} aria-label="Main" className={styles["nav"]}>
            <ul>
              {pages.map((page) => (
                <li key={page.to}>
                  <Link
                    to={page.to}
                    activeOptions={{ exact: page.to === "/" }}
                    className={styles["navLink"]}
                  >
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className={styles["actions"]}>
            <OrgSwitcher />
            {connects ? (
              <Link to="/accounts/connect" className={styles["connect"]}>
                <Plus aria-hidden="true" size={16} strokeWidth={2.5} />
                <span className={styles["connectLabel"]}>Connect account</span>
              </Link>
            ) : null}
            {role.kind === "ready" ? admin ? <OrgAdminRefresh /> : <UsageRefresh /> : null}
            <ThemeMenu />
            <AccountSignOut />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={styles["main"]}>
        <Gate role={role} />
      </main>
      {role.kind === "ready" ? <DeleteAccount /> : null}
    </>
  );
};
