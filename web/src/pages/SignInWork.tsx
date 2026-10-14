// The sign-in page's work email form (issue #76): the person types their work email, the proxy finds the org that
// verified its domain and answers the address of that org's identity provider, where the browser goes next. The same
// bot check as the GitHub and Google buttons guards it. An email no org has a domain for is answered inline.
import { Option, Schema } from "effect";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AUTH_ROUTES } from "#contract/sign-in.ts";
import { kit } from "../components/Kit.tsx";
import { workEmailProblem, workSignInProblem } from "../lib/sso.ts";
import styles from "./SignIn.module.css";

const decodeStart = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

export const WorkEmail = ({
  token,
  busy,
  steer,
  onBusy,
  onSettled,
}: {
  /** The bot check's token; `undefined` until it has one. */
  readonly token: string | undefined;
  readonly busy: boolean;
  /** A refused GitHub or Google sign-in sent the person here: put the cursor in the field. */
  readonly steer: boolean;
  readonly onBusy: (busy: boolean) => void;
  /** The attempt is over without leaving the page: the token is spent. */
  readonly onSettled: () => void;
}) => {
  const ids = useId();
  const field = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const message = (tried ? workEmailProblem(email) : undefined) ?? refusal;

  useEffect(() => {
    if (steer) field.current?.focus();
  }, [steer]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setRefusal(undefined);

    if (token === undefined || workEmailProblem(email) !== undefined) return;
    onBusy(true);

    try {
      const response = await fetch(AUTH_ROUTES.signInSso, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-captcha-response": token },
        body: JSON.stringify({ email: email.trim() }),
      });

      const body = await response.json().catch(() => undefined);
      const started = response.ok ? decodeStart(body) : Option.none();

      if (Option.isSome(started)) {
        window.location.assign(started.value.url);

        return;
      }

      const refused = decodeRefusal(body);

      setRefusal(
        workSignInProblem(
          response.status,
          Option.isSome(refused) ? refused.value.error : undefined,
        ),
      );
    } catch {
      setRefusal("Could not reach the server. Check your connection and try again.");
    }

    onBusy(false);
    onSettled();
  };

  return (
    <section className={styles["work"]} aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className={styles["workTitle"]}>
        Sign in with your work email
      </h2>
      <p className={kit["muted"]}>
        If your organization signs people in through its own identity provider, enter your work
        email and we send you there.
      </p>
      <form className={styles["workForm"]} onSubmit={submit} noValidate>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-email`}>
            Work email
          </label>
          <input
            id={`${ids}-email`}
            ref={field}
            className={kit["input"]}
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@company.com"
            value={email}
            aria-invalid={message !== undefined}
            aria-describedby={`${ids}-note`}
            onChange={(event) => {
              setEmail(event.target.value);
              setRefusal(undefined);
            }}
          />
          <p id={`${ids}-note`} className={kit["fieldError"]} role="alert">
            {message}
          </p>
        </div>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={busy || token === undefined}
          aria-busy={busy}
        >
          Continue with single sign-on
        </button>
      </form>
    </section>
  );
};
