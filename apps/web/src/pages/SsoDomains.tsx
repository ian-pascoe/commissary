// The email domains of the org (Single sign-on page): each is proved with a DNS TXT record, and a verified one may
// require single sign-on, which refuses GitHub and Google for its people and ends their sessions. Org owners change
// them; org admins read.
import { Check, Plus, ShieldCheck, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import type { SsoDomainView, SsoSettings } from "@commissary/contract/sso";
import {
  addSsoDomainAtom,
  removeSsoDomainAtom,
  SSO,
  updateSsoDomainAtom,
  verifySsoDomainAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { CopyValue } from "../components/CopyValue.tsx";
import { kit } from "../components/Kit.tsx";
import {
  domainProblem,
  domainStatus,
  normalizeDomain,
  requireBlock,
  SSO_DOMAINS_MAX,
  sortDomains,
} from "../lib/sso.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Sso.module.css";
import { SsoNoteLine, useSsoNote } from "./SsoNote.tsx";

const AddDomain = ({ count }: { readonly count: number }) => {
  const id = useId();
  const add = useAction(addSsoDomainAtom);
  const { note, settle, clear } = useSsoNote();
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const problem = tried ? domainProblem(text) : undefined;
  const full = count >= SSO_DOMAINS_MAX;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    clear();
    const domain = normalizeDomain(text);

    if (domain === undefined) return;

    if (
      settle(
        await add.run({ payload: { domain }, reactivityKeys: SSO }),
        `Added ${domain}. Publish its TXT record, then verify it.`,
      )
    ) {
      setText("");
      setTried(false);
    }
  };

  return (
    <div className={styles["stack"]}>
      <form className={styles["form"]} onSubmit={submit} noValidate aria-label="Add a domain">
        <div className={styles["formRow"]}>
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${id}-domain`}>
              Domain
            </label>
            <input
              id={`${id}-domain`}
              className={kit["input"]}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="acme.com"
              value={text}
              disabled={full}
              aria-invalid={problem !== undefined}
              aria-describedby={`${id}-hint`}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className={kit["secondary"]}
            disabled={add.busy || full}
            aria-busy={add.busy}
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
            {add.busy ? "Adding…" : "Add domain"}
          </button>
        </div>
        <p id={`${id}-hint`} className={problem === undefined ? kit["muted"] : kit["fieldError"]}>
          {problem ??
            (full
              ? `An org has at most ${SSO_DOMAINS_MAX} domains.`
              : "The part of your work emails after the @. A subdomain is a domain of its own.")}
        </p>
      </form>
      <SsoNoteLine note={note} />
    </div>
  );
};

/** What turning single sign-on on for a domain does, said before it is done. */
const requireRequest = (domain: string, run: () => Promise<void>): ConfirmRequest => ({
  title: `Require single sign-on for ${domain}?`,
  body: (
    <div className={styles["stack"]}>
      <p>
        Everyone with an email at <strong>{domain}</strong> is signed out now, and GitHub and Google
        are refused for them from here on. They sign in again with your identity provider.
      </p>
      <p>
        If your own email is at {domain}, this signs you out too. Test the provider first, so you
        can sign back in.
      </p>
    </div>
  ),
  action: "Require single sign-on",
  busyAction: "Requiring…",
  tone: "primary",
  keep: "Cancel",
  run,
});

const DomainRow = ({
  domain,
  provider,
  owner,
}: {
  readonly domain: SsoDomainView;
  readonly provider: SsoSettings["provider"];
  readonly owner: boolean;
}) => {
  const id = useId();
  const verify = useAction(verifySsoDomainAtom);
  const update = useAction(updateSsoDomainAtom);
  const remove = useAction(removeSsoDomainAtom);
  const { note, settle, clear } = useSsoNote();
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const busy = verify.busy || update.busy || remove.busy;
  const blocked = requireBlock(domain, provider);
  const params = { domain: domain.domain };

  const setRequired = async (required: boolean) => {
    settle(
      await update.run({ params, payload: { require_sso: required }, reactivityKeys: SSO }),
      required
        ? `Single sign-on is required for ${domain.domain}. Its people were signed out.`
        : `${domain.domain} may use GitHub and Google again.`,
    );
  };

  const askRemove = () => {
    clear();

    setConfirm({
      title: `Remove ${domain.domain}?`,
      body: (
        <p>
          People with an email at {domain.domain} can no longer sign in through your identity
          provider
          {domain.require_sso ? ", and the requirement for this domain ends" : ""}. The domain is
          released: another org can verify it.
        </p>
      ),
      action: "Remove domain",
      busyAction: "Removing…",
      run: async () => {
        settle(await remove.run({ params, reactivityKeys: SSO }), `Removed ${domain.domain}.`);
      },
    });
  };

  return (
    <li className={styles["domain"]}>
      <div className={styles["domainHead"]}>
        <h3 className={styles["domainName"]}>{domain.domain}</h3>
        <span className={styles["status"]} data-verified={domain.verified}>
          {domain.verified ? <Check aria-hidden="true" size={14} strokeWidth={2.75} /> : null}
          {domainStatus(domain)}
        </span>
        {owner ? (
          <div className={styles["domainActions"]}>
            {domain.verified ? null : (
              <button
                type="button"
                className={kit["secondary"]}
                disabled={busy}
                aria-busy={verify.busy}
                onClick={async () => {
                  clear();

                  settle(
                    await verify.run({ params, reactivityKeys: SSO }),
                    `Verified ${domain.domain}.`,
                  );
                }}
              >
                <ShieldCheck aria-hidden="true" size={16} strokeWidth={2.25} />
                {verify.busy ? "Checking DNS…" : "Verify"}
              </button>
            )}
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Remove ${domain.domain}`}
              title="Remove"
              disabled={busy}
              onClick={askRemove}
            >
              <X aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
          </div>
        ) : null}
      </div>
      {domain.verified ? (
        <div className={styles["stack"]}>
          <label className={styles["toggle"]}>
            <input
              type="checkbox"
              checked={domain.require_sso}
              disabled={!owner || busy || blocked !== undefined}
              aria-describedby={`${id}-require`}
              onChange={(event) => {
                clear();

                if (event.target.checked)
                  setConfirm(requireRequest(domain.domain, () => setRequired(true)));
                else void setRequired(false);
              }}
            />
            <span>Require single sign-on for this domain</span>
          </label>
          <p id={`${id}-require`} className={kit["muted"]}>
            {blocked ??
              (domain.require_sso
                ? "On: people with an email here must sign in with your identity provider. GitHub and Google are refused for them."
                : "Off: people with an email here may still sign in with GitHub or Google.")}
          </p>
        </div>
      ) : (
        <div className={styles["stack"]}>
          <p className={styles["lead"]}>
            {owner
              ? "Publish this TXT record where the domain’s DNS is managed, then verify. DNS changes can take a few minutes to spread."
              : "An org owner proves the domain by publishing this TXT record in its DNS."}
          </p>
          <CopyValue label="Record name" value={domain.record.name} />
          <CopyValue label="Record value" value={domain.record.value} />
        </div>
      )}
      <SsoNoteLine note={note} />
      <ConfirmDialog
        request={confirm}
        busy={update.busy || remove.busy}
        onClose={() => setConfirm(undefined)}
      />
    </li>
  );
};

export const DomainsSection = ({
  settings,
  owner,
}: {
  readonly settings: SsoSettings;
  readonly owner: boolean;
}) => (
  <div className={styles["stack"]}>
    <p className={styles["lead"]}>
      People whose work email is at a verified domain sign in at{" "}
      <strong>{`${window.location.origin}${SIGN_IN_PAGE_PATH}`}</strong> with “Sign in with your
      work email”, and join this org as members, unless an org admin removed them.
    </p>
    {settings.domains.length === 0 ? (
      <p className={styles["empty"]}>
        No domains yet.{" "}
        {owner ? "Add the domain your people’s work emails use." : "An org owner adds the domains."}
      </p>
    ) : (
      <ul className={styles["domains"]}>
        {sortDomains(settings.domains).map((domain) => (
          <DomainRow
            key={domain.domain}
            domain={domain}
            provider={settings.provider}
            owner={owner}
          />
        ))}
      </ul>
    )}
    {owner ? <AddDomain count={settings.domains.length} /> : null}
  </div>
);
