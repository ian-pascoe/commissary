// The identity provider of the org (Single sign-on page): what is saved (never its client secret: the server sends
// none), Commissary's addresses the provider must be told, and, for org owners, the form that sets or replaces it, a
// test and removal. Org admins read.
import { Plug, Save, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { SsoProviderView, SsoSettings } from "@commissary/contract/sso";
import {
  removeSsoProviderAtom,
  setSsoProviderAtom,
  SSO,
  testSsoProviderAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { CopyValue } from "../components/CopyValue.tsx";
import { kit } from "../components/Kit.tsx";
import { asSentence } from "../lib/failure.ts";
import {
  draftOf,
  type Fact,
  PROVIDER_KINDS,
  type ProviderDraft,
  type ProviderField,
  type ProviderKind,
  providerFacts,
  providerKindLabel,
  providerPayload,
  providerProblems,
  removeProviderBlock,
  secretStored,
  serviceProviderFacts,
} from "../lib/sso.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Sso.module.css";
import { SsoNoteLine, useSsoNote } from "./SsoNote.tsx";

/** What the identity provider has to be told about Commissary, each with its Copy button. */
const ServiceProviderValues = ({
  service,
  kinds,
}: {
  readonly service: SsoSettings["service_provider"];
  readonly kinds: ReadonlyArray<ProviderKind>;
}) => (
  <div className={styles["stack"]}>
    {kinds.map((kind) => (
      <div key={kind} className={styles["stack"]}>
        {kinds.length > 1 ? (
          <h4 className={styles["subtitle"]}>{providerKindLabel(kind)}</h4>
        ) : null}
        {serviceProviderFacts(service, kind).map((fact) => (
          <CopyValue key={fact.label} label={fact.label} value={fact.value} />
        ))}
      </div>
    ))}
  </div>
);

const Facts = ({ facts }: { readonly facts: ReadonlyArray<Fact> }) => (
  <dl className={styles["facts"]}>
    {facts.map((fact) => (
      <div key={fact.label} className={styles["fact"]}>
        <dt>{fact.label}</dt>
        <dd>{fact.value}</dd>
      </div>
    ))}
  </dl>
);

/** A labelled text field of the provider form, with its problem or hint beneath. */
const FormField = ({
  label,
  value,
  problem,
  hint,
  onChange,
  multiline = false,
  secret = false,
  placeholder,
  inputMode,
}: {
  readonly label: string;
  readonly value: string;
  readonly problem: string | undefined;
  readonly hint: ReactNode;
  readonly onChange: (value: string) => void;
  readonly multiline?: boolean;
  readonly secret?: boolean;
  readonly placeholder?: string | undefined;
  readonly inputMode?: "url";
}) => {
  const id = useId();

  const common = {
    id,
    value,
    spellCheck: false,
    autoComplete: secret ? "new-password" : "off",
    autoCapitalize: "none",
    "aria-invalid": problem !== undefined,
    "aria-describedby": `${id}-hint`,
    placeholder,
  } as const;

  return (
    <div className={kit["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          {...common}
          className={`${kit["input"]} ${styles["textarea"]}`}
          rows={6}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          className={kit["input"]}
          type={secret ? "password" : "text"}
          {...(inputMode === undefined ? {} : { inputMode })}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <p id={`${id}-hint`} className={problem === undefined ? kit["muted"] : kit["fieldError"]}>
        {problem ?? hint}
      </p>
    </div>
  );
};

const KindChoice = ({
  kind,
  stored,
  onChange,
}: {
  readonly kind: ProviderKind;
  readonly stored: SsoProviderView | null;
  readonly onChange: (kind: ProviderKind) => void;
}) => (
  <fieldset className={styles["choices"]}>
    <legend className={kit["fieldLabel"]}>Protocol</legend>
    {PROVIDER_KINDS.map((choice) => (
      <label key={choice} className={styles["choice"]}>
        <input
          type="radio"
          name="sso-protocol"
          checked={kind === choice}
          onChange={() => onChange(choice)}
        />
        <span>{providerKindLabel(choice)}</span>
      </label>
    ))}
    {stored !== null && stored.kind !== kind ? (
      <p className={kit["muted"]}>
        Saving replaces your {providerKindLabel(stored.kind)} provider: an org has one.
      </p>
    ) : null}
  </fieldset>
);

const ProviderForm = ({
  settings,
  draft,
  onDraft,
}: {
  readonly settings: SsoSettings;
  readonly draft: ProviderDraft;
  readonly onDraft: (draft: ProviderDraft) => void;
}) => {
  const stored = settings.provider;
  const save = useAction(setSsoProviderAtom);
  const { note, settle, clear } = useSsoNote();
  const [tried, setTried] = useState(false);
  const problems = tried ? providerProblems(draft, stored) : {};

  const set = (field: ProviderField) => (value: string) => onDraft({ ...draft, [field]: value });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    clear();

    if (Object.keys(providerProblems(draft, stored)).length > 0) return;
    const payload = providerPayload(draft);

    // The generated call takes one request per member of the payload union: narrow it first.
    const outcome = await save.run(
      payload.kind === "oidc" ? { payload, reactivityKeys: SSO } : { payload, reactivityKeys: SSO },
    );

    if (settle(outcome, "Saved the identity provider.")) {
      // The secret and the certificate are never read back: the fields start empty again.
      onDraft({ ...draft, clientSecret: "", certificate: "" });
      setTried(false);
    }
  };

  return (
    <form
      className={styles["form"]}
      onSubmit={submit}
      noValidate
      aria-label={stored === null ? "Set the identity provider" : "Change the identity provider"}
    >
      <KindChoice
        kind={draft.kind}
        stored={stored}
        onChange={(kind) => onDraft({ ...draft, kind })}
      />
      {draft.kind === "oidc" ? (
        <>
          <FormField
            label="Issuer"
            value={draft.issuer}
            problem={problems.issuer}
            hint="The issuer address of your provider, like https://login.example.com. We read its discovery document when you save."
            placeholder="https://login.example.com"
            inputMode="url"
            onChange={set("issuer")}
          />
          <FormField
            label="Client ID"
            value={draft.clientId}
            problem={problems.clientId}
            hint="The client ID of the app you registered for Commissary."
            onChange={set("clientId")}
          />
          <FormField
            label="Client secret"
            value={draft.clientSecret}
            problem={problems.clientSecret}
            hint={
              secretStored(stored)
                ? "A secret is stored. Leave this blank to keep it, or type a new one to replace it."
                : "The client secret of that app. It is stored and never shown again."
            }
            placeholder={secretStored(stored) ? "Secret stored" : undefined}
            secret
            onChange={set("clientSecret")}
          />
        </>
      ) : (
        <>
          <FormField
            label="Sign-in URL"
            value={draft.entryPoint}
            problem={problems.entryPoint}
            hint="Where people are sent to sign in: the provider’s SAML single sign-on URL."
            placeholder="https://idp.example.com/sso"
            inputMode="url"
            onChange={set("entryPoint")}
          />
          <FormField
            label="Entity ID"
            value={draft.idpEntityId}
            problem={problems.idpEntityId}
            hint="The provider’s entity ID (its issuer)."
            onChange={set("idpEntityId")}
          />
          <FormField
            label="Signing certificate"
            value={draft.certificate}
            problem={problems.certificate}
            hint={
              stored?.kind === "saml"
                ? "The certificate is not shown again. Paste it again to save changes."
                : "The X.509 certificate the provider signs with, as PEM text or its base64 body."
            }
            multiline
            onChange={set("certificate")}
          />
        </>
      )}
      <div className={styles["actions"]}>
        <button type="submit" className={kit["primary"]} disabled={save.busy} aria-busy={save.busy}>
          <Save aria-hidden="true" size={16} strokeWidth={2.25} />
          {save.busy ? "Saving…" : stored === null ? "Save provider" : "Save changes"}
        </button>
      </div>
      <SsoNoteLine note={note} />
    </form>
  );
};

/** The saved provider: its facts, a test of it and its removal (owners). */
const SavedProvider = ({
  settings,
  provider,
  owner,
}: {
  readonly settings: SsoSettings;
  readonly provider: SsoProviderView;
  readonly owner: boolean;
}) => {
  const test = useAction(testSsoProviderAtom);
  const remove = useAction(removeSsoProviderAtom);
  const { note, settle, clear } = useSsoNote();
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const blocked = removeProviderBlock(settings.domains);

  const askRemove = () => {
    clear();

    setConfirm({
      title: "Remove the identity provider?",
      body: (
        <p>
          Nobody can sign in with single sign-on until you set a provider again. Your domains stay
          verified; people keep their memberships and can still use GitHub or Google.
        </p>
      ),
      action: "Remove provider",
      busyAction: "Removing…",
      run: async () => {
        settle(await remove.run({ reactivityKeys: SSO }), "Removed the identity provider.");
      },
    });
  };

  return (
    <>
      <Facts facts={providerFacts(provider)} />
      {owner ? (
        <div className={styles["actions"]}>
          <button
            type="button"
            className={kit["secondary"]}
            disabled={test.busy || remove.busy}
            aria-busy={test.busy}
            onClick={async () => {
              clear();
              const outcome = await test.run({});

              settle(
                outcome,
                outcome.ok ? `Test passed. ${asSentence(outcome.value.message)}` : "",
              );
            }}
          >
            <Plug aria-hidden="true" size={16} strokeWidth={2.25} />
            {test.busy ? "Testing…" : "Test provider"}
          </button>
          <button
            type="button"
            className={kit["danger"]}
            disabled={blocked !== undefined || test.busy || remove.busy}
            aria-describedby={blocked === undefined ? undefined : "sso-remove-block"}
            onClick={askRemove}
          >
            <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
            Remove provider
          </button>
        </div>
      ) : null}
      {owner && blocked !== undefined ? (
        <p id="sso-remove-block" className={kit["muted"]}>
          {blocked}
        </p>
      ) : null}
      <SsoNoteLine note={note} />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

export const ProviderSection = ({
  settings,
  owner,
}: {
  readonly settings: SsoSettings;
  readonly owner: boolean;
}) => {
  const provider = settings.provider;
  // The form is lifted here: the addresses to register follow the protocol it is set to.
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(provider));

  const kinds = owner ? [draft.kind] : provider === null ? PROVIDER_KINDS : [provider.kind];

  return (
    <div className={styles["stack"]}>
      {provider === null ? (
        <p className={styles["lead"]}>
          No identity provider yet.{" "}
          {owner
            ? "Register Commissary as an app with your provider, then enter its details here."
            : "An org owner sets one up."}
        </p>
      ) : (
        <SavedProvider settings={settings} provider={provider} owner={owner} />
      )}
      <div className={styles["stack"]}>
        <h3 className={styles["subtitle"]}>Register Commissary with your provider</h3>
        <p className={styles["lead"]}>
          Your identity provider asks for these when you add Commissary as an app.
        </p>
        <ServiceProviderValues service={settings.service_provider} kinds={kinds} />
      </div>
      {owner ? (
        <div className={styles["stack"]}>
          <h3 className={styles["subtitle"]}>
            {provider === null ? "Set the provider" : "Change the provider"}
          </h3>
          <ProviderForm settings={settings} draft={draft} onDraft={setDraft} />
        </div>
      ) : null}
    </div>
  );
};
