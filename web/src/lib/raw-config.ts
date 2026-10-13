// The raw configuration editor's model (/settings/config, research .scratch/p5-settings-research.md (c)): the YAML
// problems shown while typing, where a dotted config path or a server-reported line sits in the text, the line diff of
// the review, the secret placeholders the editor and the review mark, and what the server's refusals mean. Pure: no
// DOM, tested in test/web-raw-config.test.ts. Loaded only by the lazy raw configuration page, with `yaml`, so neither
// reaches the main bundle.
//
// Placeholders are bound to the configuration version they were read at (`[redacted#n]` is slot n of that version), so
// the page never carries a draft over to another version; see contract `settings.ts`.
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { MovedSecret, SecretPlace } from "#contract/settings.ts";
import { familyName, isFamily } from "./keys.ts";

// ---------------------------------------------------------------------------------------------------------------
// Secrets

/** A kept secret as the server masks it: `[redacted#3]`, then `…` and up to four last characters for a whole value. */
const KEPT_SOURCE = String.raw`\[redacted#\d+\](?:…(?:\\.|[^"\\\s]){0,4})?`;

/** A secret typed into the draft, as the review's canonical result shows it. */
const NEW_SOURCE = String.raw`\[new secret\](?:…(?:\\.|[^"\\\s]){0,4})?`;

/** Every kept-secret placeholder in a text (a fresh global pattern: callers may keep `lastIndex` state). */
export const keptSecretPattern = (): RegExp => new RegExp(KEPT_SOURCE, "g");

export type SecretKind = "kept" | "new";

export interface Segment {
  readonly text: string;
  /** Set on a placeholder: a stored secret kept as it is, or a new one the save would store. */
  readonly secret?: SecretKind;
}

/** A line cut into plain text and secret placeholders, for marking them in the review. */
export const secretSegments = (text: string): ReadonlyArray<Segment> => {
  const segments: Segment[] = [];
  let last = 0;

  for (const match of text.matchAll(new RegExp(`${KEPT_SOURCE}|${NEW_SOURCE}`, "g"))) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    segments.push({ text: match[0], secret: match[0].startsWith("[new") ? "new" : "kept" });
    last = match.index + match[0].length;
  }

  if (last < text.length || segments.length === 0) segments.push({ text: text.slice(last) });

  return segments;
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** "7 secrets kept, 1 new, 1 sent somewhere new", for the review's summary. */
export const secretsLine = (kept: number, fresh: number, moved = 0): string => {
  if (kept === 0 && fresh === 0) return "No secrets";

  const sent = moved === 0 ? "" : `, ${String(moved)} sent somewhere new`;

  if (kept === 0) return plural(fresh, "new secret");

  return `${plural(kept, "secret")} kept${fresh === 0 ? "" : `, ${String(fresh)} new`}${sent}`;
};

const familyLabel = (family: string): string => (isFamily(family) ? familyName(family) : family);

/** A place for people: its host, or the family's default address when the configuration names none. */
const placeName = (place: SecretPlace): string =>
  place.host ?? `${familyLabel(place.family)}’s default address`;

/** Where a moved secret was stored and where saving sends it, in words; the family is named when it changed. */
export interface MovedWords {
  readonly from: string;
  readonly to: string;
  /** "on this key" for a provider key, else "that uses it". */
  readonly via: string;
}

export const movedWords = (moved: MovedSecret): MovedWords => {
  const otherFamily = moved.from.family !== moved.to.family;

  const named = (place: SecretPlace): string =>
    otherFamily && place.host !== undefined
      ? `${familyLabel(place.family)} at ${place.host}`
      : placeName(place);

  const from = named(moved.from);

  // Same family and host: another path on that host (a gateway that serves many accounts).
  const to =
    !otherFamily && moved.from.host !== undefined && moved.from.host === moved.to.host
      ? `another address on ${moved.to.host}`
      : named(moved.to);

  return { from, to, via: moved.path.endsWith(".api-key") ? "on this key" : "that uses it" };
};

// ---------------------------------------------------------------------------------------------------------------
// YAML problems and positions

/** A span of the text and what is wrong there. */
export interface TextProblem {
  readonly from: number;
  readonly to: number;
  readonly message: string;
}

const sentence = (text: string): string => {
  const trimmed = text.trim();

  if (trimmed === "") return trimmed;
  // A message that starts with a config path (`routing.strategy: …`) keeps the path as written.
  const first = trimmed.split(/[\s:]/, 1)[0] ?? "";

  const capitalised = /[.[\]_-]/.test(first)
    ? trimmed
    : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);

  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

/**
 * A span of at least one character where the text has one (a zero-width mark is easy to miss): the character at the
 * position, else the last one before it (an error at the end of the text marks its last character).
 */
const widen = (text: string, from: number, to: number): readonly [number, number] => {
  const start = Math.min(Math.max(0, from), text.length);
  const end = Math.min(Math.max(start, to), text.length);

  if (end > start) return [start, end];

  if (start < text.length && text[start] !== "\n") return [start, start + 1];
  let before = start;

  while (before > 0 && text[before - 1] === "\n") before--;

  return before > 0 ? [before - 1, before] : [start, start];
};

/**
 * What the YAML parser refuses in `text` (the syntax only; the server checks the configuration), parsed as the server
 * parses it: YAML 1.2 core schema, unique keys, one document.
 */
export const yamlProblems = (text: string): ReadonlyArray<TextProblem> =>
  parseDocument(text, { prettyErrors: false, resolveKnownTags: false }).errors.map((error) => {
    const [from, to] = widen(text, error.pos[0], error.pos[1]);

    return { from, to, message: sentence(error.message) };
  });

/** The 1-based line of an offset. */
export const lineOf = (text: string, offset: number): number => {
  let line = 1;

  for (let index = 0; index < Math.min(offset, text.length); index++)
    if (text[index] === "\n") line++;

  return line;
};

/** The offset of a 1-based line and column (the server's YAML error position), kept inside the text. */
export const offsetOf = (text: string, line: number, column: number): number => {
  let offset = 0;

  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);

    if (next === -1) return text.length;
    offset = next + 1;
  }

  const end = text.indexOf("\n", offset);
  const lineEnd = end === -1 ? text.length : end;

  return Math.min(offset + Math.max(0, column - 1), lineEnd);
};

/** A server problem at a 1-based line and column, as a span of the text. */
export const problemAt = (
  text: string,
  line: number,
  column: number,
  message: string,
): TextProblem => {
  const offset = offsetOf(text, line, column);
  const [from, to] = widen(text, offset, offset);

  return { from, to, message };
};

/** The parts of a dotted config path: `api-keys.claude[0].keys` → `api-keys`, `claude`, 0, `keys`. */
export const pathParts = (path: string): ReadonlyArray<string | number> =>
  path
    .split(".")
    .flatMap((part) => {
      const indexes = [...part.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
      const name = part.replace(/\[\d+\]/g, "");

      return [...(name === "" ? [] : [name]), ...indexes];
    })
    .filter((part) => part !== "");

/** Where a path's key sits in the text: `exact` when the whole path was found, else its deepest ancestor. */
export interface PathPlace {
  readonly offset: number;
  readonly exact: boolean;
  /** The part of the path that was found (`requests` of `requests.payload`). */
  readonly found: string;
}

const describe = (parts: ReadonlyArray<string | number>): string =>
  parts.reduce<string>(
    (text, part) =>
      typeof part === "number"
        ? `${text}[${String(part)}]`
        : text === ""
          ? part
          : `${text}.${part}`,
    "",
  );

/**
 * Where the key a dotted path names sits in `text` (the `yaml` parse tree's source ranges). A key with dots in its name
 * (`metadata.api_key` under payload `params`) is matched by trying the longest run of parts first; a digit part also
 * indexes a list (`api-keys.claude.0`). `undefined` when not even the first key is there.
 */
export const pathPlace = (text: string, path: string): PathPlace | undefined => {
  const parts = pathParts(path);
  const document = parseDocument(text, { prettyErrors: false, resolveKnownTags: false });
  let node: unknown = document.contents;
  let place: PathPlace | undefined;
  let index = 0;

  while (index < parts.length) {
    const part = parts[index];

    let next:
      | { readonly offset: number; readonly node: unknown; readonly length: number }
      | undefined;

    if (isMap(node)) {
      for (let end = parts.length; end > index && next === undefined; end--) {
        const run = parts.slice(index, end);

        if (run.some((entry) => typeof entry === "number")) continue;
        const key = run.join(".");

        const pair = node.items.find(
          (item) => isScalar(item.key) && String(item.key.value) === key,
        );

        const range = pair !== undefined && isScalar(pair.key) ? pair.key.range : undefined;

        if (pair !== undefined && range !== undefined && range !== null)
          next = { offset: range[0], node: pair.value, length: end - index };
      }
    } else if (isSeq(node)) {
      const position =
        typeof part === "number" ? part : /^\d+$/.test(part ?? "") ? Number(part) : -1;

      const item: unknown = node.items[position];
      const range = isMap(item) || isSeq(item) || isScalar(item) ? item.range : undefined;

      if (range !== undefined && range !== null) next = { offset: range[0], node: item, length: 1 };
    }

    if (next === undefined) break;
    index += next.length;
    node = next.node;
    place = {
      offset: next.offset,
      exact: index === parts.length,
      found: describe(parts.slice(0, index)),
    };
  }

  return place;
};

/**
 * Where a refused check or save points in the submitted text: the server's line and column (YAML that does not parse),
 * else the key its `path` names (the key up to its colon), else nowhere.
 */
export const refusalAt = (
  text: string,
  where: { readonly line?: number; readonly column?: number; readonly path?: string },
  message: string,
): TextProblem | undefined => {
  if (where.line !== undefined) return problemAt(text, where.line, where.column ?? 1, message);

  if (where.path === undefined) return undefined;
  const place = pathPlace(text, where.path);

  if (place === undefined) return undefined;
  const end = text.slice(place.offset).search(/[:\n]/);
  const [from, to] = widen(text, place.offset, end === -1 ? text.length : place.offset + end);

  return { from, to, message };
};

/** The dotted path a page address names (`#requests.payload`), or `undefined` for none. */
export const pathOfHash = (hash: string): string | undefined => {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;

  if (raw === "") return undefined;

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Review diff

export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
  /** 1-based line in the stored configuration (same and removed lines). */
  readonly before?: number;
  /** 1-based line in the result (same and added lines). */
  readonly after?: number;
}

const linesOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return [];
  const lines = text.split("\n");

  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

/** The shortest line diff of two texts (Myers), in order: removals before additions at each change. */
export const lineDiff = (before: string, after: string): ReadonlyArray<DiffLine> => {
  const a = linesOf(before);
  const b = linesOf(after);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  search: for (let depth = 0; depth <= max; depth++) {
    trace.push(frontier.slice());

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down =
        diagonal === -depth ||
        (diagonal !== depth &&
          (frontier[offset + diagonal - 1] ?? 0) < (frontier[offset + diagonal + 1] ?? 0));

      let x = down
        ? (frontier[offset + diagonal + 1] ?? 0)
        : (frontier[offset + diagonal - 1] ?? 0) + 1;

      let y = x - diagonal;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      frontier[offset + diagonal] = x;

      if (x >= n && y >= m) break search;
    }
  }

  const out: DiffLine[] = [];
  let x = n;
  let y = m;

  for (let depth = trace.length - 1; depth >= 0; depth--) {
    const previous = trace[depth];

    if (previous === undefined) break;
    const diagonal = x - y;

    const down =
      diagonal === -depth ||
      (diagonal !== depth &&
        (previous[offset + diagonal - 1] ?? 0) < (previous[offset + diagonal + 1] ?? 0));

    const fromDiagonal = down ? diagonal + 1 : diagonal - 1;
    const startX = depth === 0 ? 0 : (previous[offset + fromDiagonal] ?? 0);
    const startY = depth === 0 ? 0 : startX - fromDiagonal;

    while (x > startX && y > startY) {
      x--;
      y--;
      out.push({ kind: "same", text: a[x] ?? "", before: x + 1, after: y + 1 });
    }

    if (depth === 0) break;

    if (down) {
      y--;
      out.push({ kind: "added", text: b[y] ?? "", after: y + 1 });
    } else {
      x--;
      out.push({ kind: "removed", text: a[x] ?? "", before: x + 1 });
    }
  }

  return out.toReversed();
};

export type DiffRow =
  | { readonly kind: "line"; readonly line: DiffLine }
  /** Unchanged lines folded away, shown on request. */
  | { readonly kind: "gap"; readonly lines: ReadonlyArray<DiffLine> };

/**
 * The diff as the review shows it: every change with `context` unchanged lines around it; longer unchanged runs fold
 * into a gap (a gap of one line is just shown).
 */
export const diffRows = (lines: ReadonlyArray<DiffLine>, context = 3): ReadonlyArray<DiffRow> => {
  const rows: DiffRow[] = [];
  let start = 0;

  while (start < lines.length) {
    if (lines[start]?.kind !== "same") {
      const line = lines[start];

      if (line !== undefined) rows.push({ kind: "line", line });
      start++;
      continue;
    }

    let end = start;

    while (end < lines.length && lines[end]?.kind === "same") end++;
    const run = lines.slice(start, end);
    const head = start === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;

    if (run.length - head - tail >= 2) {
      rows.push(...run.slice(0, head).map((line): DiffRow => ({ kind: "line", line })));
      rows.push({ kind: "gap", lines: run.slice(head, run.length - tail) });
      rows.push(...run.slice(run.length - tail).map((line): DiffRow => ({ kind: "line", line })));
    } else rows.push(...run.map((line): DiffRow => ({ kind: "line", line })));

    start = end;
  }

  return rows;
};

/** "3 lines added, 1 removed", or `undefined` when nothing changed. */
export const changesLine = (lines: ReadonlyArray<DiffLine>): string | undefined => {
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;

  if (added === 0 && removed === 0) return undefined;

  if (removed === 0) return `${plural(added, "line")} added`;

  if (added === 0) return `${plural(removed, "line")} removed`;

  return `${plural(added, "line")} added, ${String(removed)} removed`;
};

// ---------------------------------------------------------------------------------------------------------------
// Server answers

/**
 * A refusal the editor marks at its line: a YAML or validation problem is the server's own sentence (the line goes in
 * front of it), any other refusal as {@link rawProblem} says it.
 */
export const locatedProblem = (
  error: string | undefined,
  message: string | undefined,
  fallback: string,
): string =>
  (error === "invalid_yaml" || error === "invalid_config") &&
  message !== undefined &&
  message.trim() !== ""
    ? sentence(message)
    : rawProblem(error, message, fallback);

/**
 * What a refused check or save means, in the operator's words (the server's `message` follows where it helps);
 * `fallback` (the failure as the client saw it) when the server said nothing this knows.
 */
export const rawProblem = (
  error: string | undefined,
  message: string | undefined,
  fallback: string,
): string => {
  const detail = message === undefined || message.trim() === "" ? "" : ` ${sentence(message)}`;

  switch (error) {
    case "invalid_yaml":
      return `This is not valid YAML.${detail}`;
    case "invalid_config":
      return `The configuration would not be valid.${detail}`;
    case "masked_value_outside_secret_field":
      return "A secret placeholder sits where no secret belongs. Put it back where it was, or type the value itself.";
    case "unknown_secret_reference":
      return `This placeholder is not a secret of the version you opened.${detail} Copy placeholders only from this page, or type the secret itself.`;
    case "invalid_secret_placeholder":
      return "This placeholder was edited. Keep it exactly as [redacted#n], or replace the whole value with a new secret.";
    case "would_remove_your_admin_access":
      return "This would remove your own admin access. Keep your address in access.admin-emails, or ask a platform admin to make the change.";
    case "body_too_large":
      return "The configuration is larger than 512 KiB, which the server does not accept.";
    default:
      return detail === "" ? fallback : detail.trim();
  }
};
