// The org chooser: the panel's address without an org (`/`) when the caller manages several, or asked for it
// (`/?choose`). Each org opens its panel (`/o/<slug>/`); a platform admin also creates orgs here.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import { createOrgAtom, meAtom, ORGS } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { orgPanelPath } from "../lib/org.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Orgs.module.css";

const NewOrg = () => {
  const create = useAction(createOrgAtom);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [privateCredentials, setPrivateCredentials] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ids = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const outcome = await create.run({
      payload: {
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        private_credentials: privateCredentials,
      },
      reactivityKeys: ORGS,
    });

    if (outcome.ok) {
      window.location.assign(orgPanelPath(outcome.value.slug));

      return;
    }

    setProblem(outcome.detail ?? outcome.message);
  };

  return (
    <form className={styles["create"]} onSubmit={submit} aria-label="Create an org">
      <h2 className={kit["sectionTitle"]}>New org</h2>
      <label className={kit["field"]} htmlFor={`${ids}-name`}>
        <span className={kit["fieldLabel"]}>Name</span>
        <input
          id={`${ids}-name`}
          className={kit["input"]}
          value={name}
          maxLength={100}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={kit["field"]} htmlFor={`${ids}-slug`}>
        <span className={kit["fieldLabel"]}>Address</span>
        <input
          id={`${ids}-slug`}
          className={kit["input"]}
          value={slug}
          maxLength={63}
          required
          autoCapitalize="none"
          spellCheck={false}
          placeholder="acme"
          aria-invalid={problem !== undefined}
          onChange={(event) => setSlug(event.target.value)}
        />
      </label>
      <p className={kit["muted"]}>
        Lowercase letters, digits and hyphens; the panel opens at /o/{slug.trim() || "acme"}/.
      </p>
      <label className={styles["choice"]} htmlFor={`${ids}-private`}>
        <input
          id={`${ids}-private`}
          type="checkbox"
          checked={privateCredentials}
          onChange={(event) => setPrivateCredentials(event.target.checked)}
        />
        <span>Let members connect private accounts and API keys</span>
      </label>
      <p className={kit["muted"]}>
        A private account or API key is used only for its owner&rsquo;s requests; org admins see
        that it exists, not how it is used. Org admins can change this later.
      </p>
      {problem === undefined ? null : <p className={kit["fieldError"]}>{problem}</p>}
      <div>
        <button type="submit" className={kit["primary"]} disabled={create.busy}>
          {create.busy ? "Creating…" : "Create org"}
        </button>
      </div>
    </form>
  );
};

export const OrgsPage = () => {
  usePageTitle("Choose an org");
  const result = useAtomValue(meAtom);
  const retry = useAtomRefresh(meAtom);

  return (
    <main id="main" className={styles["page"]}>
      <h1 className={styles["title"]}>Choose an org</h1>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading orgs…
          </p>
        ),
        onFailure: () => <Problem onRetry={retry}>Could not load your orgs.</Problem>,
        onSuccess: ({ value }) => (
          <>
            {value.orgs.length === 0 ? (
              <p className={kit["muted"]}>You do not manage any org.</p>
            ) : (
              <ul className={styles["list"]}>
                {value.orgs.map((org) => (
                  <li key={org.slug}>
                    <a className={styles["org"]} href={orgPanelPath(org.slug)}>
                      <span className={styles["orgName"]}>{org.name}</span>
                      <span className={styles["orgSlug"]}>/o/{org.slug}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {value.platform_admin ? <NewOrg /> : null}
          </>
        ),
      })}
    </main>
  );
};
