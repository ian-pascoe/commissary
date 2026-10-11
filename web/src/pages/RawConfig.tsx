// Raw configuration (/settings/config, research .scratch/p5-settings-research.md (c)): the whole configuration as
// YAML, the escape hatch for what has no typed home yet (payload rules, account error rules, context-length
// overrides). Defaults are omitted, comments are not kept, and every secret shows as a `[redacted#n]…abcd`
// placeholder that keeps the stored secret unless replaced.
//
// Edit → Review changes (`checkRaw`: the line diff of the stored text against the canonical result, what would not be
// kept, what has no effect on Workers, secrets kept and new, secrets now sent somewhere else, which must be
// confirmed) → Save (`saveRaw`) or Back to editing. Placeholders are bound to the version the draft was read at, so a
// 409 offers Reload or Copy my draft and never merges. A 422 marks the line or key the server names in the editor
// and puts the cursor there. `#<dotted.path>` in the address puts the cursor on that key. The page is its own lazy
// chunk (router.tsx): CodeMirror and `yaml` load only here.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useBlocker, useLocation } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { RawConfig, RawConfigCheck } from "#contract/settings.ts";
import {
  checkRawConfigAtom,
  rawConfigAtom,
  RAW_CONFIG_WRITES,
  saveRawConfigAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  lineOf,
  locatedProblem,
  pathOfHash,
  pathPlace,
  refusalAt,
  type TextProblem,
} from "../lib/raw-config.ts";
import { type Outcome, useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { type EditorHandle, RawConfigEditor } from "./RawConfigEditor.tsx";
import { RawConfigReview } from "./RawConfigReview.tsx";
import styles from "./RawConfig.module.css";

/** How long "Saved" and "nothing to save" stay in the actions bar. */
const NEWS_FOR_MS = 8000;

/** What has a typed home elsewhere in the panel. */
const HOMES: ReadonlyArray<readonly [string, string]> = [
  ["/settings", "Settings"],
  ["/keys", "API keys"],
  ["/models/rules", "Model rules"],
  ["/accounts", "Accounts"],
];

/** What only this page edits, by the key it lives under. */
const ONLY_HERE: ReadonlyArray<readonly [string, string]> = [
  ["requests.payload", "Payload rules"],
  ["oauth.request-scoped-errors", "Account error rules"],
  ["oauth.settings", "Context-length overrides"],
];

type Mode =
  | { readonly kind: "edit" }
  | { readonly kind: "review"; readonly check: RawConfigCheck; readonly text: string };

type Notice =
  /** The configuration moved on since the draft was read (a 409, or a newer read while editing). */
  | { readonly kind: "conflict" }
  | { readonly kind: "problem"; readonly text: string; readonly at: number | undefined }
  | { readonly kind: "saved"; readonly version: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "copied"; readonly ok: boolean };

/** Where a deep link put the cursor, when it is not exactly the key the address names. */
type Where =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "ancestor"; readonly path: string; readonly found: string };

/** "Line 11" as the button that puts the cursor there, in front of what is wrong. */
const LineLink = ({
  text,
  at,
  onJump,
}: {
  readonly text: string;
  readonly at: number;
  readonly onJump: (offset: number) => void;
}) => (
  <button type="button" className={styles["lineLink"]} onClick={() => onJump(at)}>
    Line {formatCount(lineOf(text, at))}
  </button>
);

/** Asks before leaving the page (in the panel or the browser) while there is an unsaved draft. */
const LeaveGuard = ({ dirty }: { readonly dirty: boolean }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const blocker = useBlocker({
    // A jump to another key (`#path`) is not leaving the page.
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    enableBeforeUnload: dirty,
    disabled: !dirty,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status === "blocked") dialog.current?.showModal();
    else dialog.current?.close();
  }, [blocker.status]);

  return (
    <dialog
      ref={dialog}
      className={kit["dialog"]}
      aria-labelledby={titleId}
      onCancel={() => blocker.reset?.()}
    >
      <div className={kit["dialogBody"]}>
        <h2 id={titleId} className={kit["dialogTitle"]}>
          Leave without saving?
        </h2>
        <p>Your changes to the configuration are not saved and will be lost.</p>
        <div className={kit["dialogActions"]}>
          <button type="button" className={kit["primary"]} onClick={() => blocker.reset?.()}>
            Stay
          </button>
          <button type="button" className={kit["secondary"]} onClick={() => blocker.proceed?.()}>
            Leave
          </button>
        </div>
      </div>
    </dialog>
  );
};

/** Reload with a draft: the draft is lost, so ask. */
const ReloadDialog = ({
  open,
  onReload,
  onCancel,
}: {
  readonly open: boolean;
  readonly onReload: () => void;
  readonly onCancel: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={kit["dialog"]} aria-labelledby={titleId} onCancel={onCancel}>
      <div className={kit["dialogBody"]}>
        <h2 id={titleId} className={kit["dialogTitle"]}>
          Reload and lose your changes?
        </h2>
        <p>Reloading shows the configuration as stored now. Your changes are not saved.</p>
        <div className={kit["dialogActions"]}>
          <button type="button" className={kit["primary"]} onClick={onCancel}>
            Keep editing
          </button>
          <button type="button" className={kit["secondary"]} onClick={onReload}>
            Reload
          </button>
        </div>
      </div>
    </dialog>
  );
};

const Head = ({ raw }: { readonly raw: RawConfig | undefined }) => (
  <header className={styles["head"]}>
    <Link to="/settings" className={styles["back"]}>
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
      Settings
    </Link>
    <h1 className={styles["title"]}>Raw configuration</h1>
    {raw === undefined ? null : (
      <p className={styles["facts"]}>
        <span>Configuration version {formatCount(raw.version)}</span>
        <span>
          {raw.secrets === 0
            ? "No secrets"
            : `${formatCount(raw.secrets)} ${raw.secrets === 1 ? "secret" : "secrets"} masked`}
        </span>
      </p>
    )}
    <p className={styles["lead"]}>
      The whole configuration as YAML, shown without defaults. Comments are not kept. Secrets show
      as <code className={styles["placeholder"]}>[redacted#n]…abcd</code> and stay as stored unless
      you replace them.
    </p>
  </header>
);

const HomeLinks = ({ onJump }: { readonly onJump: (path: string) => void }) => (
  <>
    <span className={styles["homesTitle"]}>Own pages:</span>
    <ul className={styles["homeList"]}>
      {HOMES.map(([to, name]) => (
        <li key={to}>
          <Link to={to}>{name}</Link>
        </li>
      ))}
    </ul>
    <span className={styles["homesTitle"]}>Only here:</span>
    <ul className={styles["homeList"]}>
      {ONLY_HERE.map(([path, name]) => (
        <li key={path}>
          <Link to="/settings/config" hash={path} onClick={() => onJump(path)}>
            {name}
          </Link>
        </li>
      ))}
    </ul>
  </>
);

/**
 * Where each concept lives: the typed pages first, this page for what has no other home. One line where there is
 * room; on a phone it folds away so the editor comes first.
 */
const Homes = ({ onJump }: { readonly onJump: (path: string) => void }) => (
  <>
    <nav className={styles["homes"]} aria-label="Where things live">
      <HomeLinks onJump={onJump} />
    </nav>
    <details className={styles["homesFolded"]}>
      <summary>Where things live</summary>
      <nav className={styles["homesOpen"]} aria-label="Where things live">
        <HomeLinks onJump={onJump} />
      </nav>
    </details>
  </>
);

const WhereNote = ({ where }: { readonly where: Where | undefined }) => {
  if (where === undefined) return null;

  return (
    <p className={styles["where"]} role="status">
      {where.kind === "missing" ? (
        <>
          <code>{where.path}</code> is not in the configuration: it is at its default, which is not
          shown. Add it to set it.
        </>
      ) : (
        <>
          <code>{where.path}</code> is not set (defaults are not shown); the cursor is at{" "}
          <code>{where.found}</code>.
        </>
      )}
    </p>
  );
};

const Body = ({
  latest,
  onReload,
}: {
  readonly latest: RawConfig;
  readonly onReload: () => void;
}) => {
  const editor = useRef<EditorHandle>(null);
  const check = useAction(checkRawConfigAtom);
  const save = useAction(saveRawConfigAtom);
  /** The read the draft is bound to: its version goes with every check and save. */
  const [base, setBase] = useState(latest);
  const [text, setText] = useState(latest.yaml);
  const [syntax, setSyntax] = useState<ReadonlyArray<TextProblem>>([]);
  const [mode, setMode] = useState<Mode>({ kind: "edit" });
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [where, setWhere] = useState<Where | undefined>(undefined);
  const [askReload, setAskReload] = useState(false);
  /** The version a save wrote, until the read shows it. */
  const [pending, setPending] = useState<number | undefined>(undefined);
  const hash = useLocation({ select: (location) => location.hash });
  const editorId = useId();
  const reloadButton = useRef<HTMLButtonElement>(null);

  const dirty = text !== base.yaml;
  const busy = check.busy || save.busy || pending !== undefined;

  /** Start over on a read: the editor's text and history go, with every note about the old draft. */
  const adopt = useCallback((raw: RawConfig) => {
    setBase(raw);
    setText(raw.yaml);
    setMode({ kind: "edit" });
    editor.current?.reset(raw.yaml);
  }, []);

  // A new read: take it when there is no draft (or it is the one a save is waiting for); with a draft, say that the
  // configuration moved on, since the draft's placeholders belong to the old version.
  const seen = useRef(latest);

  useEffect(() => {
    if (seen.current === latest) return;
    seen.current = latest;

    if (pending !== undefined) {
      if (latest.version < pending) return;
      setPending(undefined);
      adopt(latest);
      setNotice({ kind: "saved", version: latest.version });
      // The review (and its Save button) is gone: keep the keyboard on the page.
      requestAnimationFrame(() => document.getElementById(editorId)?.focus());
    } else if (!dirty) {
      if (latest.version !== base.version || latest.yaml !== base.yaml) adopt(latest);
    } else if (latest.version !== base.version) setNotice({ kind: "conflict" });
  }, [latest, pending, dirty, base, adopt, editorId]);

  useEffect(() => {
    if (notice?.kind !== "saved" && notice?.kind !== "unchanged" && notice?.kind !== "copied")
      return;
    const timer = setTimeout(() => setNotice(undefined), NEWS_FOR_MS);

    return () => clearTimeout(timer);
  }, [notice]);

  // On a conflict Review changes goes away: the keyboard moves to Reload.
  const conflicted = notice?.kind === "conflict";

  useEffect(() => {
    if (conflicted && document.activeElement === document.body) reloadButton.current?.focus();
  }, [conflicted]);

  const jump = useCallback(
    (path: string) => {
      const place = pathPlace(text, path);

      if (place === undefined) {
        setWhere({ kind: "missing", path });

        return;
      }

      setWhere(place.exact ? undefined : { kind: "ancestor", path, found: place.found });
      setMode({ kind: "edit" });
      requestAnimationFrame(() => editor.current?.focusAt(place.offset, { land: true }));
    },
    [text],
  );

  // The address names a key: put the cursor there, once per address.
  const jumped = useRef<string | undefined>(undefined);

  useEffect(() => {
    const path = pathOfHash(hash);

    if (path === undefined || jumped.current === hash) return;
    jumped.current = hash;
    jump(path);
  }, [hash, jump]);

  const onChange = useCallback((next: string) => {
    setText(next);
    setNotice((known) =>
      known?.kind === "problem" || known?.kind === "copied" ? undefined : known,
    );
    setWhere(undefined);
  }, []);

  /** A refused check or save: mark the line or key the server names and put the cursor there. */
  const refused = (outcome: Extract<Outcome<unknown>, { ok: false }>, submitted: string) => {
    setMode({ kind: "edit" });

    if (outcome.error === "conflict") {
      setNotice({ kind: "conflict" });

      return;
    }

    const message = locatedProblem(outcome.error, outcome.detail, outcome.message);
    const problem = refusalAt(submitted, outcome, message);

    editor.current?.showProblem(problem);
    setNotice({ kind: "problem", text: message, at: problem?.from });

    if (problem !== undefined) requestAnimationFrame(() => editor.current?.focusAt(problem.from));
  };

  const review = async () => {
    setNotice(undefined);
    setWhere(undefined);
    const [first] = syntax;

    if (first !== undefined) return editor.current?.focusAt(first.from);
    const submitted = text;
    const outcome = await check.run({ payload: { version: base.version, yaml: submitted } });

    if (outcome.ok) setMode({ kind: "review", check: outcome.value, text: submitted });
    else refused(outcome, submitted);
  };

  const store = async (submitted: string) => {
    setNotice(undefined);

    const outcome = await save.run({
      payload: { version: base.version, yaml: submitted },
      reactivityKeys: RAW_CONFIG_WRITES,
    });

    if (!outcome.ok) return refused(outcome, submitted);

    if (outcome.value.version === base.version) {
      // The canonical result is what is stored: the draft only differed in form.
      adopt(base);
      setNotice({ kind: "unchanged" });

      return;
    }

    setPending(outcome.value.version);
  };

  const discard = () => {
    editor.current?.replace(base.yaml);
    setMode({ kind: "edit" });
    setNotice(undefined);
    setWhere(undefined);
  };

  /** Show the configuration as stored now, dropping the draft. */
  const reload = () => {
    setAskReload(false);
    setNotice(undefined);
    setWhere(undefined);
    adopt(latest);
    onReload();
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "copied", ok: true });
    } catch {
      editor.current?.selectAll();
      setNotice({ kind: "copied", ok: false });
    }
  };

  const conflict = notice?.kind === "conflict";
  const reviewing = mode.kind === "review";
  const status = pending !== undefined ? "Saving…" : dirty ? "Unsaved changes" : "No changes";

  let news: ReactNode = null;

  const jumpTo = (offset: number) => editor.current?.focusAt(offset);

  if (notice?.kind === "conflict")
    news = (
      <Problem>
        Changed since you opened it. Your draft&rsquo;s secret placeholders belong to version{" "}
        {formatCount(base.version)}, so it can&rsquo;t be saved. Reload, or copy your draft first.
      </Problem>
    );
  else if (notice?.kind === "problem")
    news = (
      <Problem>
        {notice.at === undefined ? (
          reviewing ? (
            "Could not save. "
          ) : (
            "Could not check the changes. "
          )
        ) : (
          <>
            <LineLink text={text} at={notice.at} onJump={jumpTo} />:{" "}
          </>
        )}
        {notice.text}
      </Problem>
    );
  else if (notice?.kind === "saved")
    news = (
      <p className={styles["news"]} role="status">
        Saved as version {formatCount(notice.version)}. Takes effect within a few seconds.
      </p>
    );
  else if (notice?.kind === "unchanged")
    news = (
      <p className={styles["news"]} role="status">
        The configuration already said so; nothing was saved.
      </p>
    );
  else if (notice?.kind === "copied")
    news = (
      <p className={styles["news"]} role="status">
        {notice.ok
          ? "Draft copied. Its placeholders belong to the old version: after Reload, paste back the parts you changed, not the secrets."
          : "Could not copy. The draft is selected: copy it with Ctrl+C (⌘C on a Mac)."}
      </p>
    );

  return (
    <>
      <LeaveGuard dirty={dirty} />
      <ReloadDialog open={askReload} onReload={reload} onCancel={() => setAskReload(false)} />
      <Homes onJump={jump} />

      <div className={styles["work"]}>
        <div className={styles["editing"]} hidden={reviewing}>
          <div className={styles["editorHead"]}>
            <h2 id={editorId} className={styles["sectionTitle"]} tabIndex={-1}>
              Configuration
            </h2>
            <p className={styles["hint"]} aria-hidden="true">
              Search with Ctrl+F (⌘F on a Mac). Tab moves on to the next control.
            </p>
          </div>
          <WhereNote where={where} />
          <RawConfigEditor
            ref={editor}
            initial={base.yaml}
            label="Configuration (YAML). Tab moves on; Ctrl+F searches."
            onChange={onChange}
            onProblems={setSyntax}
          />
        </div>

        {mode.kind === "review" ? (
          <RawConfigReview
            before={base.yaml}
            check={mode.check}
            busy={busy}
            onSave={() => store(mode.text)}
            onBack={() => {
              setMode({ kind: "edit" });
              setNotice(undefined);
              requestAnimationFrame(() => editor.current?.focusAt(0));
            }}
          />
        ) : null}

        {reviewing ? null : (
          <div className={styles["actions"]}>
            {syntax[0] === undefined ? null : (
              <Problem>
                <LineLink text={text} at={syntax[0].from} onJump={jumpTo} />: {syntax[0].message}
                {syntax.length === 1 ? "" : ` (and ${formatCount(syntax.length - 1)} more)`}
              </Problem>
            )}
            {news}
            <div className={styles["buttons"]}>
              <span className={styles["state"]} role="status">
                {status}
              </span>
              {dirty && !conflict ? (
                <button
                  type="button"
                  className={kit["primary"]}
                  disabled={busy}
                  onClick={() => void review()}
                >
                  {check.busy ? "Checking…" : "Review changes"}
                </button>
              ) : null}
              {conflict ? (
                <button
                  ref={reloadButton}
                  type="button"
                  className={kit["primary"]}
                  disabled={busy}
                  onClick={reload}
                >
                  Reload
                </button>
              ) : null}
              {conflict && dirty ? (
                <button type="button" className={kit["secondary"]} onClick={() => void copyDraft()}>
                  Copy my draft
                </button>
              ) : null}
              {dirty ? (
                <button
                  type="button"
                  className={kit["secondary"]}
                  disabled={busy}
                  onClick={discard}
                >
                  Discard
                </button>
              ) : null}
              {conflict ? null : (
                <button
                  type="button"
                  className={kit["secondary"]}
                  disabled={busy}
                  onClick={() => (dirty ? setAskReload(true) : reload())}
                >
                  Reload
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export const RawConfigPage = () => {
  usePageTitle("Raw configuration");
  const result = useAtomValue(rawConfigAtom);
  const reload = useAtomRefresh(rawConfigAtom);
  // A refetch that fails keeps the last read, so the draft survives it.
  const raw = Option.getOrUndefined(AsyncResult.value(result));

  return (
    <div className={styles["page"]}>
      <Head raw={raw} />
      {AsyncResult.isFailure(result) ? (
        <Problem onRetry={reload}>
          Could not load the configuration. {failureMessage(result)}
        </Problem>
      ) : null}
      {raw === undefined ? (
        AsyncResult.isInitial(result) ? (
          <p className={kit["muted"]} aria-busy="true">
            Loading the configuration…
          </p>
        ) : null
      ) : (
        <Body latest={raw} onReload={reload} />
      )}
    </div>
  );
};
