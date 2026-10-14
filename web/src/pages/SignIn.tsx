// The sign-in page of a hosted proxy (/sign-in, ADR 0026). It is the one page that opens before anyone is signed in, so
// it never calls the management API: it asks `/api/sign-in-options` which providers are enabled and for the Turnstile
// site key, shows the bot check, and sends the chosen provider to Better Auth, which answers the address to go to.
import { Option, Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { AUTH_ROUTES, SIGN_IN_OPTIONS_PATH, SignInOptions } from "#contract/sign-in.ts";
import { kit, Problem } from "../components/Kit.tsx";
import {
  needsWorkEmail,
  providerLabel,
  safeNextPath,
  signInProblem,
  signInRequestProblem,
} from "../lib/sign-in.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./SignIn.module.css";
import { WorkEmail } from "./SignInWork.tsx";

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  readonly render: (
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly callback: (token: string) => void;
      readonly "expired-callback": () => void;
      readonly "error-callback": () => void;
    },
  ) => string;
  readonly reset: (widgetId: string) => void;
  readonly remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<TurnstileApi> | undefined;

/** Loads Cloudflare's Turnstile script once and answers its API. */
const loadTurnstile = (): Promise<TurnstileApi> => {
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");

    script.src = TURNSTILE_SCRIPT;
    script.async = true;

    script.addEventListener("load", () => {
      if (window.turnstile === undefined) reject(new Error("Turnstile did not start"));
      else resolve(window.turnstile);
    });

    script.addEventListener("error", () => {
      scriptLoad = undefined;
      reject(new Error("Turnstile did not load"));
    });

    document.head.append(script);
  });

  return scriptLoad;
};

/** The bot check: renders the widget and reports its token (`undefined` while it has none). */
const useTurnstile = (siteKey: string | undefined) => {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ readonly api: TurnstileApi; readonly id: string } | undefined>(undefined);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = container.current;

    if (siteKey === undefined || element === null) return;
    let gone = false;

    loadTurnstile().then(
      (api) => {
        if (gone) return;

        widget.current = {
          api,
          id: api.render(element, {
            sitekey: siteKey,
            callback: (value) => {
              setFailed(false);
              setToken(value);
            },
            "expired-callback": () => setToken(undefined),
            "error-callback": () => {
              setToken(undefined);
              setFailed(true);
            },
          }),
        };
      },
      () => setFailed(true),
    );

    return () => {
      gone = true;

      if (widget.current !== undefined) widget.current.api.remove(widget.current.id);
      widget.current = undefined;
    };
  }, [siteKey]);

  /** A token works once: after an attempt, ask for a fresh one. */
  const reset = useCallback(() => {
    setToken(undefined);

    if (widget.current !== undefined) widget.current.api.reset(widget.current.id);
  }, []);

  return { container, token, failed, reset } as const;
};

type Options =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly options: SignInOptions };

const decodeOptions = Schema.decodeUnknownOption(SignInOptions);

const decodeStart = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

const useOptions = (): Options => {
  const [state, setState] = useState<Options>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetch(SIGN_IN_OPTIONS_PATH, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return { kind: "failed" as const };
        const options = decodeOptions(await response.json());

        return Option.isSome(options)
          ? { kind: "ready" as const, options: options.value }
          : { kind: "failed" as const };
      })
      .then(setState)
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      });

    return () => controller.abort();
  }, []);

  return state;
};

export const SignInPage = () => {
  usePageTitle("Sign in");
  const search = new URLSearchParams(window.location.search);
  const next = safeNextPath(search.get("next"));
  const failure = signInProblem(search.get("error"));
  const steer = needsWorkEmail(search.get("error"));
  const loaded = useOptions();
  const options = loaded.kind === "ready" ? loaded.options : undefined;
  const check = useTurnstile(options?.turnstile_site_key);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const signIn = async (provider: SignInOptions["providers"][number]) => {
    if (check.token === undefined) return;
    setBusy(true);
    setProblem(undefined);

    try {
      const response = await fetch(AUTH_ROUTES.signInSocial, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-captcha-response": check.token },
        body: JSON.stringify({ provider, callbackURL: next }),
      });

      const started = response.ok ? decodeStart(await response.json()) : undefined;

      if (started !== undefined && Option.isSome(started)) {
        window.location.assign(started.value.url);

        return;
      }

      setProblem(signInRequestProblem(response.status));
    } catch {
      setProblem("Could not reach the server. Check your connection and try again.");
    }

    setBusy(false);
    check.reset();
  };

  return (
    <main id="main" className={styles["page"]}>
      <h1 className={styles["title"]}>Sign in</h1>
      <p className={kit["muted"]}>
        Sign in to {window.location.host} with an account you already have. You do not need a
        password here.
      </p>
      {failure === undefined ? null : <Problem>{failure}</Problem>}
      {loaded.kind === "failed" ? (
        <Problem>Could not load the sign-in options. Reload the page to try again.</Problem>
      ) : null}
      {loaded.kind === "loading" ? (
        <p className={kit["muted"]} aria-busy="true">
          Loading…
        </p>
      ) : null}
      {options === undefined ? null : (
        <>
          {options.providers.length === 0 ? null : (
            <div className={styles["providers"]}>
              {options.providers.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={kit["primary"]}
                  disabled={busy || check.token === undefined}
                  aria-busy={busy}
                  onClick={() => signIn(provider)}
                >
                  Continue with {providerLabel(provider)}
                </button>
              ))}
            </div>
          )}
          <WorkEmail
            token={check.token}
            busy={busy}
            steer={steer}
            onBusy={setBusy}
            onSettled={check.reset}
          />
          <div ref={check.container} className={styles["check"]} />
          <p className={check.failed ? kit["fieldError"] : kit["muted"]} role="status">
            {check.failed
              ? "The bot check could not run. Reload the page, and allow challenges.cloudflare.com."
              : check.token === undefined
                ? "Checking that you are not a bot… signing in works once this finishes."
                : null}
          </p>
          {problem === undefined ? null : <p className={kit["fieldError"]}>{problem}</p>}
        </>
      )}
    </main>
  );
};
