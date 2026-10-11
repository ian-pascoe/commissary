// The raw configuration's review: what saving the draft would store (`checkRaw`, nothing stored yet). The line diff
// runs from the stored text to the canonical result, so the server's normalisation shows too; then what would not be
// kept, what has no effect on Workers, and the secrets. A kept secret that now sits under another provider or upstream
// address would be sent there: the review names it (placeholder) and both hosts, marks its line in the diff, and Save
// asks for an explicit confirmation first.
import { useEffect, useId, useRef, useState } from "react";
import type { MovedSecret, RawConfigCheck } from "#contract/settings.ts";
import { kit } from "../components/Kit.tsx";
import { formatCount } from "../lib/format.ts";
import {
  changesLine,
  type DiffLine,
  diffRows,
  lineDiff,
  lineOf,
  movedWords,
  pathPlace,
  secretSegments,
  secretsLine,
} from "../lib/raw-config.ts";
import styles from "./RawConfig.module.css";

const CHIP = {
  new: ["secretNew", "New secret, stored on save"],
  kept: ["secret", "Secret, kept as stored"],
  moved: ["secretMoved", "Secret, sent somewhere new"],
} as const;

/** A line's text with its secret placeholders marked; `moved` on a line where a kept secret goes somewhere new. */
const LineText = ({ text, moved = false }: { readonly text: string; readonly moved?: boolean }) => (
  <>
    {secretSegments(text).map((segment, index) => {
      if (segment.secret === undefined) return segment.text;

      const [className, title] =
        CHIP[segment.secret === "kept" && moved ? "moved" : segment.secret];

      return (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- segments of one fixed line, never reordered
          key={index}
          className={styles[className]}
          title={title}
        >
          {segment.text}
        </span>
      );
    })}
  </>
);

const SIGN = { same: "", added: "+", removed: "−" } as const;

const SAID = { same: "", added: "Added: ", removed: "Removed: " } as const;

const Line = ({
  line,
  moved,
}: {
  readonly line: DiffLine;
  readonly moved: ReadonlySet<number>;
}) => (
  <tr className={styles[line.kind]}>
    <td className={styles["number"]}>{line.before}</td>
    <td className={styles["number"]}>{line.after}</td>
    <td className={styles["sign"]} aria-hidden="true">
      {SIGN[line.kind]}
    </td>
    <td className={styles["code"]}>
      {line.kind === "same" ? null : (
        <span className={kit["visuallyHidden"]}>{SAID[line.kind]}</span>
      )}
      <LineText
        text={line.text}
        moved={line.kind !== "removed" && line.after !== undefined && moved.has(line.after)}
      />
    </td>
  </tr>
);

const Diff = ({
  lines,
  moved,
}: {
  readonly lines: ReadonlyArray<DiffLine>;
  /** Result lines that hold a moved secret. */
  readonly moved: ReadonlySet<number>;
}) => {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  return (
    <div className={styles["diffFrame"]}>
      <table className={styles["diff"]}>
        <caption className={kit["visuallyHidden"]}>
          Changes, with the stored line numbers and the saved line numbers
        </caption>
        <thead className={kit["visuallyHidden"]}>
          <tr>
            <th scope="col">Stored line</th>
            <th scope="col">Saved line</th>
            <th scope="col">Change</th>
            <th scope="col">Text</th>
          </tr>
        </thead>
        <tbody>
          {diffRows(lines).flatMap((row, index) => {
            if (row.kind === "line")
              return [
                <Line
                  key={`${String(row.line.before)}:${String(row.line.after)}`}
                  line={row.line}
                  moved={moved}
                />,
              ];

            if (open.has(index))
              return row.lines.map((line) => (
                <Line
                  key={`${String(line.before)}:${String(line.after)}`}
                  line={line}
                  moved={moved}
                />
              ));
            const first = row.lines[0]?.after ?? 0;
            const last = row.lines.at(-1)?.after ?? 0;

            return [
              <tr key={`gap-${String(first)}`} className={styles["gap"]}>
                <td colSpan={4}>
                  <button
                    type="button"
                    className={styles["gapButton"]}
                    onClick={() => setOpen(new Set([...open, index]))}
                  >
                    Show {formatCount(row.lines.length)} unchanged lines ({formatCount(first)}–
                    {formatCount(last)})
                  </button>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
};

/** One list of config paths under a heading and what it means. */
const Paths = ({
  title,
  lead,
  paths,
}: {
  readonly title: string;
  readonly lead: string;
  readonly paths: ReadonlyArray<string>;
}) => (
  <div className={styles["block"]}>
    <h3 className={styles["blockTitle"]}>{title}</h3>
    <p className={styles["blockLead"]}>{lead}</p>
    <ul className={styles["paths"]}>
      {paths.map((path) => (
        <li key={path}>
          <code>{path}</code>
        </li>
      ))}
    </ul>
  </div>
);

/** "Saving sends [redacted#4]…c1b8, stored for openrouter.ai, to llm-gateway.example.net with every request on this key." */
const MovedLine = ({ moved }: { readonly moved: MovedSecret }) => {
  const words = movedWords(moved);

  return (
    <>
      Saving sends <span className={styles["secretMoved"]}>{moved.placeholder}</span>, stored for{" "}
      {words.from}, to <strong>{words.to}</strong> with every request {words.via}.
    </>
  );
};

/** The result lines that hold a moved secret, to mark them in the diff. */
const movedLines = (yaml: string, moved: ReadonlyArray<MovedSecret>): ReadonlySet<number> =>
  new Set(
    moved.flatMap(({ path }) => {
      const place = pathPlace(yaml, path);

      return place?.exact === true ? [lineOf(yaml, place.offset)] : [];
    }),
  );

export const RawConfigReview = ({
  before,
  check,
  busy,
  onSave,
  onBack,
}: {
  /** The stored text the draft was read from. */
  readonly before: string;
  readonly check: RawConfigCheck;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onBack: () => void;
}) => {
  const title = useRef<HTMLHeadingElement>(null);
  const confirmBox = useRef<HTMLInputElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const ids = useId();
  const lines = lineDiff(before, check.yaml);
  const changed = changesLine(lines);
  const moved = check.moved_secrets;
  const single = moved.length === 1 ? moved[0] : undefined;

  useEffect(() => {
    title.current?.focus();
  }, []);

  const save = () => {
    if (moved.length > 0 && !confirmed) {
      setUnconfirmed(true);
      confirmBox.current?.focus();

      return;
    }

    onSave();
  };

  return (
    <section className={styles["review"]} aria-labelledby={`${ids}-title`}>
      <header className={styles["reviewHead"]}>
        <h2 id={`${ids}-title`} ref={title} className={styles["sectionTitle"]} tabIndex={-1}>
          Review changes
        </h2>
        <p className={styles["facts"]}>
          {changed === undefined ? null : <span>{changed}</span>}
          <span>{secretsLine(check.kept_secrets, check.new_secrets, moved.length)}</span>
        </p>
      </header>

      {moved.length === 0 ? null : (
        <div className={styles["moved"]}>
          <h3 className={styles["blockTitle"]}>
            {moved.length === 1 ? "A secret sent somewhere new" : "Secrets sent somewhere new"}
          </h3>
          {single === undefined ? (
            <>
              <ul className={styles["movedList"]}>
                {moved.map((entry) => (
                  <li key={entry.path}>
                    <MovedLine moved={entry} />
                  </li>
                ))}
              </ul>
              <p className={styles["blockLead"]}>Whoever runs those addresses can read them.</p>
            </>
          ) : (
            <p className={styles["blockLead"]}>
              <MovedLine moved={single} /> Whoever runs that address can read it.
            </p>
          )}
          <label className={styles["confirm"]}>
            <input
              ref={confirmBox}
              type="checkbox"
              checked={confirmed}
              aria-invalid={unconfirmed && !confirmed}
              aria-describedby={unconfirmed && !confirmed ? `${ids}-confirm-error` : undefined}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                setUnconfirmed(false);
              }}
            />
            {single === undefined
              ? "Send them to the new addresses"
              : `Send it to ${movedWords(single).to}`}
          </label>
          {unconfirmed && !confirmed ? (
            <span id={`${ids}-confirm-error`} className={kit["fieldError"]}>
              Confirm this before saving, or go back to editing and put{" "}
              {moved.length === 1 ? "it" : "them"} back.
            </span>
          ) : null}
        </div>
      )}

      {check.dropped.length === 0 && check.not_applied.length === 0 ? null : (
        <div className={styles["lists"]}>
          {check.dropped.length === 0 ? null : (
            <Paths
              title="Not kept"
              lead="Saving drops these: unknown keys, keys only the Go server reads, entries the configuration rewrites."
              paths={check.dropped}
            />
          )}

          {check.not_applied.length === 0 ? null : (
            <Paths
              title="No effect on Workers"
              lead="Stored, but nothing on Workers reads them."
              paths={check.not_applied}
            />
          )}
        </div>
      )}

      {changed === undefined ? (
        <p className={styles["blockLead"]}>Nothing to save: this is the configuration as stored.</p>
      ) : (
        <Diff lines={lines} moved={movedLines(check.yaml, moved)} />
      )}

      <div className={styles["actions"]}>
        <div className={styles["buttons"]}>
          {changed === undefined ? null : (
            <button type="button" className={kit["primary"]} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
          )}
          <button
            type="button"
            className={changed === undefined ? kit["primary"] : kit["secondary"]}
            disabled={busy}
            onClick={onBack}
          >
            Back to editing
          </button>
        </div>
      </div>
    </section>
  );
};
