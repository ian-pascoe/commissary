// The read-only parts of the Settings page: payload rule counts, the account error rules, the deployment's own admins,
// and the keys that do nothing on Workers (each with Remove). Payload and error rules are edited in the configuration
// editor once it lands; until then the classic panel (OLD_PANEL) edits them.
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { RequestScopedErrorRule } from "#contract/api-keys.ts";
import type { SettingsView } from "#contract/settings.ts";
import { removeSettingAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { formatCount } from "../lib/format.ts";
import { OLD_PANEL } from "../lib/old-panel.ts";
import { providerName } from "../lib/providers.ts";
import { removalPatch } from "../lib/settings.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Settings.module.css";

/** Where payload and error rules are edited until the configuration editor lands. */
const ClassicPanel = ({ what }: { readonly what: string }) => (
  <p className={styles["quiet"]}>
    Editing {what} comes with the configuration editor. Until then,{" "}
    <a href={OLD_PANEL}>edit them in the classic panel</a>.
  </p>
);

/** A section without a form: heading and body. */
export const PlainSection = ({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <section id={id} className={styles["section"]} aria-labelledby={`${id}-title`}>
    <header className={styles["sectionHead"]}>
      <h2 id={`${id}-title`} className={styles["sectionTitle"]}>
        {title}
      </h2>
    </header>
    {children}
  </section>
);

const PAYLOAD_KINDS: ReadonlyArray<readonly [keyof SettingsView["payload"], string, string]> = [
  ["default", "Default", "Set a parameter only when the request does not have it."],
  ["default-raw", "Default, raw JSON", "The same, with a raw JSON value."],
  ["override", "Override", "Set a parameter, replacing what the client sent."],
  ["override-raw", "Override, raw JSON", "The same, with a raw JSON value."],
  ["filter", "Filter", "Remove a parameter from the request."],
];

export const PayloadRules = ({ payload }: { readonly payload: SettingsView["payload"] }) => (
  <PlainSection id="payload" title="Payload rules">
    <p className={styles["lead"]}>
      Rules that change request bodies for the models they name, as the last step before a request
      goes to the provider.
    </p>
    <ul className={styles["counts"]}>
      {PAYLOAD_KINDS.map(([kind, name, meaning]) => (
        <li key={kind} className={styles["countRow"]}>
          <span className={styles["count"]}>{formatCount(payload[kind])}</span>
          <span className={styles["countName"]}>{name}</span>
          <span className={styles["countMeaning"]}>{meaning}</span>
        </li>
      ))}
    </ul>
    <ClassicPanel what="payload rules" />
  </PlainSection>
);

const ACTIONS = new Map([
  ["stop", "Answer with the error"],
  ["stop-and-cooldown", "Answer with the error and cool the account down"],
  ["continue", "Try the next credential"],
  ["continue-and-cooldown", "Cool the account down and try the next"],
]);

const matchText = (rule: RequestScopedErrorRule): string => {
  const texts = (rule.match ?? []).map((text) => `“${text}”`);
  const patterns = (rule["match-regexr"] ?? []).map((pattern) => `/${pattern}/`);
  const all = [...texts, ...patterns];

  return all.length === 0 ? "Any body" : all.join(" or ");
};

/** `oauth.request-scoped-errors`, compactly: one row per rule, the provider once per group. */
export const ErrorRules = ({
  rules,
}: {
  readonly rules: SettingsView["request_scoped_errors"];
}) => {
  const providers = Object.entries(rules).filter(([, list]) => list.length > 0);

  return (
    <div className={styles["sub"]}>
      <h3 className={styles["subTitle"]}>Account error rules</h3>
      <p className={styles["hint"]}>
        What a failed request does next, per provider, for accounts without rules of their own.
      </p>
      {providers.length === 0 ? (
        <p className={styles["quiet"]}>No account error rules.</p>
      ) : (
        <table className={styles["table"]}>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Status</th>
              <th scope="col">Body contains</th>
              <th scope="col">Then</th>
            </tr>
          </thead>
          <tbody>
            {providers.flatMap(([provider, list]) =>
              list.map((rule, index) => (
                <tr key={`${provider}-${String(index)}`}>
                  <td>{index === 0 ? providerName(provider) : null}</td>
                  <td data-label="Status">
                    {rule.status === undefined ? "Any" : String(rule.status)}
                  </td>
                  <td className={styles["matchCell"]}>{matchText(rule)}</td>
                  <td data-label="Then">
                    {ACTIONS.get(rule.action ?? "") ?? rule.action ?? "Default"}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <ClassicPanel what="error rules" />
    </div>
  );
};

/** `ACCESS_ADMIN_EMAILS` / `ACCESS_ADMIN_SERVICE_TOKENS`: admins this page cannot remove. */
export const DeploymentAdmins = ({ admins }: { readonly admins: SettingsView["env_admins"] }) => {
  const all = [...admins.emails, ...admins.service_tokens];

  return (
    <div className={styles["sub"]}>
      <h3 className={styles["subTitle"]}>Always admins</h3>
      <p className={styles["hint"]}>
        Set on the deployment (ACCESS_ADMIN_EMAILS, ACCESS_ADMIN_SERVICE_TOKENS); not editable here.
      </p>
      {all.length === 0 ? (
        <p className={styles["quiet"]}>None set on the deployment.</p>
      ) : (
        <ul className={styles["admins"]}>
          {all.map((admin) => (
            <li key={admin}>{admin}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const NotAppliedRow = ({
  entry,
  view,
}: {
  readonly entry: SettingsView["not_applied"][number];
  readonly view: SettingsView;
}) => {
  const remove = useAction(removeSettingAtom(entry.key));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const removable = removalPatch(entry.key) !== undefined;

  return (
    <li className={styles["inertRow"]}>
      <code className={styles["inertKey"]}>{entry.key}</code>
      <span className={styles["inertReason"]}>{entry.reason}</span>
      {removable ? (
        <button
          type="button"
          className={kit["secondary"]}
          disabled={remove.busy}
          aria-label={`Remove ${entry.key}`}
          onClick={async () => {
            setProblem(undefined);
            const outcome = await remove.run(view);

            if (!outcome.ok) setProblem(outcome.message);
          }}
        >
          {remove.busy ? "Removing…" : "Remove"}
        </button>
      ) : (
        <Link to="/keys" className={styles["inertLink"]}>
          On the API keys page
        </Link>
      )}
      {problem === undefined ? null : (
        <div className={styles["inertProblem"]}>
          <Problem>Could not remove it. {problem}</Problem>
        </div>
      )}
    </li>
  );
};

export const NotApplied = ({ view }: { readonly view: SettingsView }) => (
  <PlainSection id="not-applied" title="Not applied on Workers">
    <p className={styles["lead"]}>
      The configuration sets these, but they do nothing on Workers. Removing one changes nothing
      else; values are never shown.
    </p>
    <ul className={styles["inert"]}>
      {view.not_applied.map((entry) => (
        <NotAppliedRow key={entry.key} entry={entry} view={view} />
      ))}
    </ul>
  </PlainSection>
);
