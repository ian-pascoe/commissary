// The Account page's Routing form: one account's own auth-file fields as a draft of the inputs the operator touched,
// which of them apply to the account's provider, the checks the server makes
// (`packages/models/src/credentials/field-patch.ts`), the change count, and the `PATCH /credentials/fields` body (changed
// fields only; `null` deletes a field, so the routing setting applies again). Header values arrive masked
// (`[redacted]…abcd`) except safe headers (`@commissary/contract/headers`): a header keeps its mask until the operator
// replaces the value, and the mask goes back unchanged, which the server reads as "keep". An error names its field and,
// for aliases and headers, the row (a `422` path such as `headers.X-Team` or `model_aliases.1` is mapped back to its
// row).
import { REDACTED_PREFIX } from "@commissary/contract/provider-keys";
import type {
  CredentialEntry,
  CredentialFieldsPatch,
  CredentialModelAlias,
} from "@commissary/contract/credentials";
import { isSecretHeaderName, PLACEHOLDER } from "@commissary/contract/headers";

/** The editable fields, by the name the server uses (and names in a `422`). */
export type FieldKey =
  | "priority"
  | "note"
  | "prefix"
  | "weight"
  | "request_retry"
  | "disable_cooling"
  | "websockets"
  | "headers"
  | "excluded_models"
  | "model_aliases";

/** The account's own cooling switch: follow the routing setting, or override it either way. */
export type Cooling = "routing" | "cool" | "never";

export interface HeaderRow {
  /** Stable React key. */
  readonly id: string;
  readonly name: string;
  readonly value: string;
  /** The stored header's name and masked value while the value has not been replaced. */
  readonly hidden: { readonly name: string; readonly mask: string } | undefined;
  /** Added in this form (not stored yet). */
  readonly added?: boolean;
  /** A hidden value the operator chose to replace. */
  readonly replaced?: boolean;
}

export interface AliasRow {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly fork: boolean;
  /** Settings the form does not show (`force-mapping`, `display-name`), kept as they were. */
  readonly kept: Omit<CredentialModelAlias, "name" | "alias" | "fork">;
}

export interface Draft {
  readonly priority: string;
  readonly note: string;
  readonly prefix: string;
  readonly weight: string;
  readonly request_retry: string;
  readonly disable_cooling: Cooling;
  readonly websockets: boolean;
  readonly headers: ReadonlyArray<HeaderRow>;
  /** One model name or `*` pattern per line. */
  readonly excluded_models: string;
  readonly model_aliases: ReadonlyArray<AliasRow>;
}

/** The fields the operator touched; the rest show the account's values. */
export type Edits = Partial<Draft>;

/** A problem with a field; `row` is the alias or header row it is about. */
export interface FieldError {
  readonly message: string;
  readonly row?: string;
}

export type FieldErrors = Partial<Record<FieldKey, FieldError>>;

/** The request body without `name`. */
export type FieldsPatch = Omit<CredentialFieldsPatch, "name">;

/** The largest weight the server takes (`MAX_WEIGHT`, `packages/models/src/credentials/weight.ts`). */
export const MAX_WEIGHT = 1_000_000;

/** The form's fields in page order (a failed save focuses the first error in this order). */
export const FIELD_ORDER: ReadonlyArray<FieldKey> = [
  "priority",
  "weight",
  "request_retry",
  "disable_cooling",
  "websockets",
  "prefix",
  "excluded_models",
  "model_aliases",
  "headers",
  "note",
];

/** RFC 9110 `token`: what the server and `Headers` accept as a header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

let rows = 0;

/** A fresh row key. */
export const rowId = (): string => {
  rows += 1;

  return `row-${rows}`;
};

/** A masked value or the new-secret marker anywhere in it (the server refuses either as a new value). */
export const isMasked = (value: string): boolean => PLACEHOLDER.test(value);

/**
 * Is a header row's value typed into a password field? A replaced hidden value is, and a new header's value is when
 * the server would mask it once saved (every name but the safe ones).
 */
export const isSecretRow = (row: HeaderRow): boolean =>
  row.replaced === true ||
  (row.added === true && row.name.trim() !== "" && isSecretHeaderName(row.name));

/** The prefix as the server stores it: outer slashes dropped like Go's synthesizer. */
export const prefixOf = (text: string): string => text.trim().replace(/^\/+|\/+$/g, "");

/** `[redacted]…abcd` → `…abcd`; a fully hidden value has no tail. */
export const maskTail = (mask: string): string | undefined => {
  const tail = mask.slice(REDACTED_PREFIX.length);

  return tail === "" ? undefined : tail;
};

/**
 * Fields that apply to the provider. WebSocket preference is read only for Codex in this port
 * (`selection/pick.ts`); the account's own aliases are not applied for `gemini` (`derive.ts`).
 */
export const appliesTo = (provider: string, key: FieldKey): boolean => {
  if (key === "websockets") return provider === "codex";

  if (key === "model_aliases") return provider !== "gemini";

  return true;
};

const coolingOf = (entry: CredentialEntry): Cooling => {
  if (entry.disable_cooling === undefined) return "routing";

  return entry.disable_cooling ? "never" : "cool";
};

const aliasRow = (
  { name, alias, fork, ...kept }: CredentialModelAlias,
  index: number,
): AliasRow => ({ id: `alias:${index}`, name, alias, fork: fork === true, kept });

/** The form as the account stands. */
export const draftOf = (entry: CredentialEntry): Draft => ({
  priority: entry.priority?.toString() ?? "",
  note: entry.note ?? "",
  prefix: entry.prefix ?? "",
  weight: entry.weight?.toString() ?? "",
  request_retry: entry.request_retry?.toString() ?? "",
  disable_cooling: coolingOf(entry),
  websockets: entry.websockets === true,
  headers: Object.entries(entry.headers ?? {}).map(([name, value]) => ({
    id: `header:${name}`,
    name,
    value,
    hidden: isMasked(value) ? { name, mask: value } : undefined,
  })),
  excluded_models: (entry.excluded_models ?? []).join("\n"),
  model_aliases: (entry.model_aliases ?? []).map(aliasRow),
});

export const shownDraft = (entry: CredentialEntry, edits: Edits): Draft => ({
  ...draftOf(entry),
  ...edits,
});

// ---------------------------------------------------------------------------------------------------------------
// Values as the server stores them

const isBlankHeader = (row: HeaderRow): boolean =>
  row.name.trim() === "" && row.value.trim() === "";

const isBlankAlias = (row: AliasRow): boolean => row.name.trim() === "" && row.alias.trim() === "";

/** The exclusion lines as the server stores them: trimmed, lower-cased, de-duplicated, in order. */
export const exclusionList = (text: string): ReadonlyArray<string> => [
  ...new Set(
    text.split(/[\n,]/).flatMap((line) => {
      const pattern = line.trim().toLowerCase();

      return pattern === "" ? [] : [pattern];
    }),
  ),
];

const headerMap = (headerRows: ReadonlyArray<HeaderRow>): Readonly<Record<string, string>> =>
  Object.fromEntries(
    headerRows.flatMap((row) => (isBlankHeader(row) ? [] : [[row.name.trim(), row.value.trim()]])),
  );

const aliasList = (aliasRows: ReadonlyArray<AliasRow>): ReadonlyArray<CredentialModelAlias> =>
  aliasRows.flatMap((row) => {
    if (isBlankAlias(row)) return [];

    const entry = { ...row.kept, name: row.name.trim(), alias: row.alias.trim() };

    return [row.fork ? { ...entry, fork: true } : entry];
  });

/** A whole-number field as stored; `null` when empty (only called once the text is a whole number). */
const wholeOrNull = (text: string): number | null =>
  text.trim() === "" ? null : Number(text.trim());

const textOrNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** What a field would store, as text, for comparing the draft with the account. */
const fingerprint = (draft: Draft, key: FieldKey): string => {
  switch (key) {
    case "priority":
    case "weight":
    case "request_retry": {
      const text = draft[key].trim();

      // `07` and `7` are the same number; anything else compares as typed.
      return /^-?\d+$/.test(text) ? String(Number(text)) : text;
    }

    case "note":
      return draft.note.trim();
    case "prefix":
      return prefixOf(draft.prefix);
    case "disable_cooling":
      return draft.disable_cooling;
    case "websockets":
      return String(draft.websockets);
    case "headers":
      return JSON.stringify(
        Object.entries(headerMap(draft.headers)).toSorted(([a], [b]) => a.localeCompare(b)),
      );
    case "excluded_models":
      return JSON.stringify(exclusionList(draft.excluded_models));
    case "model_aliases":
      return JSON.stringify(aliasList(draft.model_aliases));
  }
};

/** The touched fields whose value differs from the account's, in form order. */
export const changedFields = (entry: CredentialEntry, edits: Edits): ReadonlyArray<FieldKey> => {
  const base = draftOf(entry);
  const draft = { ...base, ...edits };

  return FIELD_ORDER.filter(
    (key) => edits[key] !== undefined && fingerprint(draft, key) !== fingerprint(base, key),
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Checks (the server's, in the operator's words)

const headerError = (
  headerRows: ReadonlyArray<HeaderRow>,
  hidden: ReadonlyArray<string>,
): FieldError | undefined => {
  const seen = new Set<string>();

  for (const row of headerRows) {
    if (isBlankHeader(row)) continue;
    const name = row.name.trim();
    const value = row.value.trim();
    const at = (message: string): FieldError => ({ message, row: row.id });

    if (name === "") return at(`Enter a name for this header, or remove it.`);

    if (!HEADER_NAME.test(name))
      return at(`“${name}” is not a header name. Use letters, digits and dashes, without spaces.`);

    if (seen.has(name.toLowerCase())) return at(`${name} is listed twice.`);
    seen.add(name.toLowerCase());

    if (value === "") return at(`Enter a value for ${name}, or remove the header.`);

    if (isMasked(value) && (row.hidden === undefined || row.hidden.mask !== value))
      return at(`${name} has a hidden value that is not its own. Type the value again.`);
  }

  // A stored secret survives only under its own name; renaming its row would send the mask elsewhere.
  for (const name of hidden) {
    const renamed = headerRows.find((row) => row.hidden?.name === name && row.name.trim() !== name);

    if (renamed !== undefined) {
      return {
        message: `${name} keeps its hidden value only under its own name. Replace the value to rename it.`,
        row: renamed.id,
      };
    }
  }

  return undefined;
};

const exclusionError = (text: string): FieldError | undefined => {
  const spaced = text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .find((line) => /\s/.test(line));

  return spaced === undefined
    ? undefined
    : { message: `“${spaced}” has a space. Put one model name or pattern on each line.` };
};

const aliasError = (aliasRows: ReadonlyArray<AliasRow>): FieldError | undefined => {
  const seen = new Map<string, string>();

  for (const row of aliasRows) {
    if (isBlankAlias(row)) continue;
    const name = row.name.trim();
    const alias = row.alias.trim();
    const at = (message: string): FieldError => ({ message, row: row.id });

    if (name === "") return at(`Enter the provider's model name for the alias ${alias}.`);

    if (alias === "") return at(`Enter the name clients call for ${name}.`);

    if (name.toLowerCase() === alias.toLowerCase())
      return at(`${alias} is the provider's own name. Choose a different alias.`);
    const taken = seen.get(alias.toLowerCase());

    if (taken !== undefined) return at(`${alias} is already the alias of ${taken}.`);
    seen.set(alias.toLowerCase(), name);
  }

  return undefined;
};

const priorityError = (text: string): string | undefined =>
  text.trim() === "" || /^-?\d+$/.test(text.trim())
    ? undefined
    : "Enter a whole number, such as 10 or -1.";

const weightError = (text: string): string | undefined => {
  const weight = text.trim();

  return weight === "" || (/^\d+$/.test(weight) && Number(weight) <= MAX_WEIGHT)
    ? undefined
    : `Enter a whole number from 0 to ${MAX_WEIGHT.toLocaleString("en")}.`;
};

const retryError = (text: string): string | undefined =>
  text.trim() === "" || /^\d+$/.test(text.trim()) ? undefined : "Enter a whole number, 0 or more.";

const prefixError = (text: string): string | undefined => {
  const prefix = prefixOf(text);

  if (prefix.includes("/")) return "A prefix cannot contain /; clients add the / themselves.";

  return /\s/.test(prefix) ? "A prefix has no spaces." : undefined;
};

/** Problems with the touched fields, in the operator's words. */
export const draftErrors = (entry: CredentialEntry, edits: Edits): FieldErrors => {
  const draft = shownDraft(entry, edits);

  const hidden = Object.entries(entry.headers ?? {}).flatMap(([name, value]) =>
    isMasked(value) ? [name] : [],
  );

  const text = (message: string | undefined): FieldError | undefined =>
    message === undefined ? undefined : { message };

  const problems: ReadonlyArray<readonly [FieldKey, FieldError | undefined]> = [
    ["priority", text(priorityError(draft.priority))],
    ["weight", text(weightError(draft.weight))],
    ["request_retry", text(retryError(draft.request_retry))],
    ["prefix", text(prefixError(draft.prefix))],
    ["headers", headerError(draft.headers, hidden)],
    ["excluded_models", exclusionError(draft.excluded_models)],
    ["model_aliases", aliasError(draft.model_aliases)],
  ];

  return Object.fromEntries(
    problems.flatMap(([key, problem]) =>
      edits[key] === undefined || problem === undefined ? [] : [[key, problem]],
    ),
  );
};

/**
 * A `422` from the server as a form error: `path` names the field, or an entry of it (`headers.<name>`,
 * `model_aliases.<index>` counting the aliases sent, so blank rows are skipped), which maps to its row.
 */
export const serverError = (
  draft: Draft,
  path: string | undefined,
  message: string,
): { readonly key: FieldKey; readonly error: FieldError } | undefined => {
  if (path === undefined) return undefined;
  const dot = path.indexOf(".");
  const field = dot === -1 ? path : path.slice(0, dot);
  const entry = dot === -1 ? undefined : path.slice(dot + 1);
  const key = FIELD_ORDER.find((known) => known === field);

  if (key === undefined) return undefined;

  if (entry === undefined) return { key, error: { message } };
  let row: string | undefined;

  if (key === "headers") {
    row = draft.headers.find(
      (known) => !isBlankHeader(known) && known.name.trim().toLowerCase() === entry.toLowerCase(),
    )?.id;
  } else if (key === "model_aliases") {
    row = draft.model_aliases.filter((known) => !isBlankAlias(known))[Number(entry)]?.id;
  }

  return { key, error: row === undefined ? { message } : { message, row } };
};

// ---------------------------------------------------------------------------------------------------------------
// The request

/** Header changes as a merge: changed or new values, `""` for a header that went away; `null` when none is left. */
const headersPatch = (
  before: Readonly<Record<string, string>>,
  headerRows: ReadonlyArray<HeaderRow>,
): Record<string, string> | null => {
  const after = headerMap(headerRows);

  if (Object.keys(after).length === 0) return null;
  const patch: Record<string, string> = {};

  for (const [name, value] of Object.entries(after))
    if (before[name] !== value) patch[name] = value;

  // The server matches names case-insensitively: a header renamed only in case is replaced, not removed.
  const kept = new Set(Object.keys(after).map((name) => name.toLowerCase()));

  for (const name of Object.keys(before)) if (!kept.has(name.toLowerCase())) patch[name] = "";

  return patch;
};

const listOrNull = <A>(list: ReadonlyArray<A>): ReadonlyArray<A> | null =>
  list.length === 0 ? null : list;

/** The body of `PATCH /credentials/fields` without `name`: the changed fields only. Call it on a draft without errors. */
export const patchOf = (entry: CredentialEntry, edits: Edits): FieldsPatch => {
  const draft = shownDraft(entry, edits);
  const patch: { -readonly [Key in keyof FieldsPatch]: FieldsPatch[Key] } = {};

  for (const key of changedFields(entry, edits)) {
    switch (key) {
      case "priority":
      case "weight":
      case "request_retry":
        patch[key] = wholeOrNull(draft[key]);
        break;
      case "note":
        patch.note = textOrNull(draft.note);
        break;
      case "prefix":
        patch.prefix = textOrNull(prefixOf(draft.prefix));
        break;
      case "disable_cooling":
        patch.disable_cooling =
          draft.disable_cooling === "routing" ? null : draft.disable_cooling === "never";
        break;
      case "websockets":
        // Off is the default: unticking removes the field.
        patch.websockets = draft.websockets ? true : null;
        break;
      case "headers":
        patch.headers = headersPatch(entry.headers ?? {}, draft.headers);
        break;
      case "excluded_models":
        patch.excluded_models = listOrNull(exclusionList(draft.excluded_models));
        break;
      case "model_aliases":
        patch.model_aliases = listOrNull(aliasList(draft.model_aliases));
        break;
    }
  }

  return patch;
};

/**
 * After the account refreshes: keep only the edits that still differ from it (a save that landed, or the same change
 * made elsewhere, leaves nothing to save).
 */
export const rebaseEdits = (entry: CredentialEntry, edits: Edits): Edits => {
  const kept: { -readonly [Key in keyof Draft]?: Draft[Key] } = {};

  for (const key of changedFields(entry, edits)) Object.assign(kept, { [key]: edits[key] });

  return kept;
};

export const changesText = (count: number): string =>
  `${count} ${count === 1 ? "change" : "changes"}`;
