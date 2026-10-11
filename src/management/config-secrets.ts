/**
 * Secret masking for the raw configuration editor (`settings-raw-routes.ts`: `GET|PUT /settings/config`,
 * `POST /settings/config/check`). Pure.
 *
 * Workers addition. Generalises Go's TURN secret rule (internal/api/handlers/management/config_v8.go: redacted on
 * read, kept when a write omits it) and the keys page's header placeholders (`api-keys-write.ts`) to every position of
 * the v8 document that holds a secret:
 *
 * - `api-keys.<family>[g].keys[k].api-key`, and `access.api-keys[i]` (legacy client keys): the whole value;
 * - `headers.<name>` of a group or a key, and `requests.payload.<kind>[r].models[m].headers.<name>` (match patterns):
 *   the whole value of every header except the allow-list of protocol/client headers (`User-Agent`, `Accept`,
 *   `Anthropic-Version`, ...; names compared trimmed and lower-cased, as stored) and pure client copies (`$Header`,
 *   `$CPA-SESSION-ID`: they name what is sent, not a secret; a template such as `$CPA-SESSION-ID:sk-…` is masked),
 *   by the rules the Keys and Account pages share (`contract/headers.ts`);
 * - `requests.payload.<kind>[r].params.<path>` (not `filter`): every string under a parameter whose last path part,
 *   or a key inside its value, looks secret (`SECRET_PART`: key, token, secret, sig, auth, pass, pwd, cred, session);
 *   a raw (`*-raw`) parameter's JSON text is one whole secret when a key anywhere inside it looks secret by the same
 *   rule (`{"api_key": "sk-…"}`), so it is masked, restored and checked like any whole value;
 * - URLs (`requests.proxy-url`, `models.*catalog`, a group's or key's `base-url` / `proxy-url`): the user info
 *   (`user:pass` before `@`) and the value of each query or fragment `name=value` pair whose name looks secret.
 *
 * `maskDocument` numbers the secrets of the stored document in document order (1-based; deterministic for one config
 * version) and writes slot _n_ as `[redacted#n]`, followed by `…abcd` (the last four characters) when a whole value
 * is longer than 8 characters; URL parts never carry a tail. Empty values are not secrets.
 *
 * `restoreSecrets` reads an edited document (prepared, so paths are v8) against the stored one. A string that carries
 * a marker (`[redacted…`, `[new secret]`) must be a whole placeholder at a secret position:
 *
 * - `[redacted#n]` with an intact prefix (the tail may be shortened or removed) at a whole-value position, or exactly
 *   the user info / a secret query value of a URL, takes stored slot _n_'s value, which must be the same kind of
 *   secret (`masked_value_outside_secret_field` otherwise); _n_ out of range is `unknown_secret_reference`;
 * - a placeholder anywhere else, including a header renamed to an allow-listed name, is
 *   `masked_value_outside_secret_field`, so a secret can never be copied into a field that is shown unmasked; so is a
 *   stored secret that reads as a pure client copy placed in a header (it would be shown unmasked);
 * - any other marker form (`[redacted]…abcd`, `xx[redacted#1]`, `[new secret]…`) is `invalid_secret_placeholder`.
 *
 * Plain strings at secret positions are new secrets (a pasted Go config keeps working). The index, not the position,
 * names a secret, so reordering or moving groups and duplicating a placeholder all work; the routes pin the version so
 * slot _n_ is the one the user saw. After a URL is restored its secret parts are located again and must be exactly
 * the restored spans, in the text as written and trimmed as the normaliser may store it (unless it is the field's
 * stored text), so a restored secret is always masked again on the next read.
 *
 * `reviewResult` masks the outcome of an edit for the review. The edit is decoded a second time with unguessable
 * per-request stand-ins (`secretTags`) written instead of the restored secrets, so kept and new secrets are told apart by
 * origin, never by value: a typed guess of a stored secret reviews the same whether it is right or not. Tags keep
 * their `[redacted#n]`, the others are `[new secret]` (same tail rule): a submitted secret is never echoed. It also
 * lists the kept secrets now sent elsewhere than where they were stored (`moved`: another family, or another
 * upstream base URL for `api-keys` keys and headers, another URL for URL credentials; compared without secrets, path
 * included), each with its placeholder and the family and upstream host it went to and goes to (`SecretPlace`: the
 * host only, never user info, path or query).
 *
 * `exposedTagPath` is the fail-safe on that same decode: a stand-in the masking would still show (a normaliser rename
 * or move took a restored secret out of a secret position) refuses the edit, without ever comparing real values.
 *
 * `maskedValueAt` guards the unversioned `/config*` writes (`config-routes.ts`), which restore nothing: the first
 * string carrying a marker that the stored document does not already hold at the same path.
 */
import { configPath } from "../config/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import { setOwn } from "../json/value.ts";
import { isHeaderCopy, SAFE_HEADER_NAMES } from "./contract/headers.ts";

export type SecretKind = "value" | "userinfo" | "query";

/** One secret of a document. */
export interface SecretSlot {
  /** `configPath` of the string that holds it. */
  readonly path: string;
  readonly kind: SecretKind;
  /** The secret itself (for a URL, the user info or the query value only). */
  readonly value: string;
}

/** A refused edit: the placeholder at `path` cannot be restored. */
export interface SecretProblem {
  readonly error:
    | "masked_value_outside_secret_field"
    | "unknown_secret_reference"
    | "invalid_secret_placeholder";
  readonly message: string;
  readonly path: string;
}

/** A stored secret an edit referenced by its placeholder. */
export interface RestoredSecret {
  readonly index: number;
  readonly kind: SecretKind;
  readonly value: string;
}

type Segment = string | number;

type Path = ReadonlyArray<Segment>;

/**
 * How a string position holds secrets: `raw` is the JSON text of a `*-raw` payload parameter, a whole secret when it
 * names a secret-looking key.
 */
type Position = "value" | "header" | "url" | "raw";

const NEW_SECRET = "[new secret]";

/** Any marker of a masked value: a string carrying one is restored or refused, never stored as typed. */
const MARKER = /\[(?:redacted|new secret)/i;

/** A whole-value placeholder: intact prefix, optional tail of at most four characters. */
const VALUE_PLACEHOLDER = /^\[redacted#(\d+)\](?:…[\s\S]{0,4})?$/;

const PLACEHOLDER = /\[redacted#(\d+)\]/g;

/** Placeholders inside a URL are swapped for these while the URL is taken apart (`#` would end the URL early). */
const SENTINEL = /\uE000(\d+)\uE001/g;

const sentinel = (index: string): string => `\uE000${index}\uE001`;

const isIndex = (segment: Segment | undefined): segment is number => typeof segment === "number";

const isKey = (segment: Segment | undefined): segment is string => typeof segment === "string";

const CATALOGS = new Set(["catalog", "codex-catalog", "devin-catalog"]);

const URL_FIELDS = new Set(["base-url", "proxy-url"]);

const headerPosition = (name: Segment | undefined): Position | undefined =>
  isKey(name) && !SAFE_HEADER_NAMES.has(name.trim().toLowerCase()) ? "header" : undefined;

/** A key or path part that looks like it names a secret (URL parameters, payload parameter paths). */
const SECRET_PART = /key|token|secret|sig|auth|pass|pwd|cred|session/i;

/** The last part of a payload parameter path (`metadata.api_key`, `a\.b`: escapes kept). */
const lastPathPart = (path: string): string => path.split(/(?<!\\)\./).at(-1) ?? path;

/**
 * A string inside `requests.payload.<kind>[r].params.<path>` (not `filter`, whose params are paths): secret when the
 * last part of the parameter path, or a key inside its value, looks secret.
 */
const paramPosition = (path: Path): Position | undefined => {
  const [, , kind, rule, field, param] = path;

  if (kind === "filter" || !isIndex(rule) || field !== "params" || !isKey(param)) return undefined;
  const parts = [lastPathPart(param), ...path.slice(6).filter(isKey)];

  if (parts.some((part) => SECRET_PART.test(part))) return "value";

  return isKey(kind) && kind.endsWith("-raw") && path.length === 6 ? "raw" : undefined;
};

/** Whether any object key inside `value` (at any depth) looks secret. */
const namesSecret = (value: Json): boolean => {
  if (Array.isArray(value)) return value.some(namesSecret);

  if (isJsonObject(value))
    return Object.entries(value).some(
      ([key, child]) => SECRET_PART.test(key) || namesSecret(child),
    );

  return false;
};

/** Whether the JSON text of a raw payload parameter names a secret-looking key (not JSON: no). */
const rawHoldsSecret = (text: string): boolean => {
  try {
    // SAFETY: JSON.parse always returns a JSON value.
    return namesSecret(JSON.parse(text.trim()) as Json);
  } catch {
    return false;
  }
};

/** A field of an `api-keys` group or key: its URLs and its headers. */
const memberPosition = (rest: Path): Position | undefined => {
  if (rest.length === 1 && isKey(rest[0]) && URL_FIELDS.has(rest[0])) return "url";

  if (rest.length === 2 && rest[0] === "headers") return headerPosition(rest[1]);

  return undefined;
};

const groupPosition = (rest: Path): Position | undefined => {
  if (rest[0] === "keys" && isIndex(rest[1])) {
    const inner = rest.slice(2);

    return inner.length === 1 && inner[0] === "api-key" ? "value" : memberPosition(inner);
  }

  return memberPosition(rest);
};

/** The secret position at `path` of a v8 document, if any. */
const positionOf = (path: Path): Position | undefined => {
  const [root, second] = path;

  if (root === "access" && second === "api-keys" && path.length === 3 && isIndex(path[2]))
    return "value";

  if (root === "requests" && second === "proxy-url" && path.length === 2) return "url";

  if (root === "models" && isKey(second) && CATALOGS.has(second) && path.length === 2) return "url";

  if (root === "api-keys" && isKey(second) && isIndex(path[2])) return groupPosition(path.slice(3));

  if (
    root === "requests" &&
    second === "payload" &&
    path.length === 8 &&
    isKey(path[2]) &&
    isIndex(path[3]) &&
    path[4] === "models" &&
    isIndex(path[5]) &&
    path[6] === "headers"
  )
    return headerPosition(path[7]);

  if (root === "requests" && second === "payload" && path.length >= 6) return paramPosition(path);

  return undefined;
};

// --- URLs ----------------------------------------------------------------------------------------------------------

/** Where a secret sits in a string. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretKind;
}

const paramName = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
};

const isSecretParam = (raw: string): boolean => {
  const name = paramName(raw);

  return SECRET_PART.test(name) || /^code$/i.test(name);
};

const parsesAsUrl = (text: string): boolean => {
  try {
    new URL(text);

    return true;
  } catch {
    return false;
  }
};

const firstIndex = (text: string, chars: string, from: number): number => {
  for (let index = from; index < text.length; index++)
    if (chars.includes(text[index] ?? "")) return index;

  return text.length;
};

/**
 * The user info of a URL (`scheme://user:pass@host`, also without a scheme): up to the last `@` of the authority.
 * When the authority has none but the text has no scheme or is no valid URL (`https://u:pa/ss@host`, `u:p?ss@host`:
 * an unescaped `/` or `?` in a password), everything up to its last `@` counts: masking too much is the safe side.
 */
const userinfoSpan = (text: string): Span | undefined => {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text);
  const start = scheme === null ? 0 : scheme[0].length;
  const authorityEnd = firstIndex(text, "/\\?#", start);
  const at = text.slice(start, authorityEnd).lastIndexOf("@");

  if (at >= 0) return at > 0 ? { start, end: start + at, kind: "userinfo" } : undefined;
  const loose = text.lastIndexOf("@");

  return loose > start && (scheme === null || !parsesAsUrl(text))
    ? { start, end: loose, kind: "userinfo" }
    : undefined;
};

/** The values of the `name=value` pairs between `start` and `end` (`&`-separated) whose names look secret. */
const pairSpans = (text: string, start: number, end: number): Span[] => {
  const spans: Span[] = [];
  let from = start;

  while (from <= end) {
    const next = Math.min(firstIndex(text, "&", from), end);
    const equals = text.indexOf("=", from);

    if (
      equals >= 0 &&
      equals < next &&
      next > equals + 1 &&
      isSecretParam(text.slice(from, equals))
    )
      spans.push({ start: equals + 1, end: next, kind: "query" });
    from = next + 1;
  }

  return spans;
};

/**
 * The values of the query parameters, and of the fragment's `name=value` pairs (`#access_token=...`), whose names look
 * secret.
 */
const querySpans = (text: string): Span[] => {
  const hash = text.indexOf("#");
  const question = text.indexOf("?");
  const fragment = hash < 0 ? [] : pairSpans(text, hash + 1, text.length);

  if (question < 0 || (hash >= 0 && hash < question)) return fragment;

  return [...pairSpans(text, question + 1, hash < 0 ? text.length : hash), ...fragment];
};

const urlSpans = (text: string): Span[] => {
  const userinfo = userinfoSpan(text);
  const query = querySpans(text);

  return userinfo === undefined
    ? query
    : [userinfo, ...query.filter((span) => span.start >= userinfo.end)];
};

// --- walking -------------------------------------------------------------------------------------------------------

/** A copy of `value` with every string replaced by `rewrite(path, text)` (document order, key order kept). */
const mapStrings = (
  value: Json,
  path: Segment[],
  rewrite: (path: Path, text: string) => string,
): Json => {
  if (typeof value === "string") return rewrite(path, value);

  if (Array.isArray(value))
    return value.map((item, index) => mapStrings(item, [...path, index], rewrite));

  if (isJsonObject(value)) {
    const out: JsonObject = {};

    for (const [key, child] of Object.entries(value))
      setOwn(out, key, mapStrings(child, [...path, key], rewrite));

    return out;
  }

  return value;
};

/** The secrets of the string at a position: whole values, or the secret parts of a URL. */
const secretsAt = (position: Position, text: string): ReadonlyArray<Span> => {
  if (text === "") return [];

  if (position === "url") return urlSpans(text);

  // A pure client copy is shown as is; a template (`$CPA-SESSION-ID:sk-…`) is a secret like any value.
  if (position === "header" && isHeaderCopy(text)) return [];

  if (position === "raw" && !rawHoldsSecret(text)) return [];

  return [{ start: 0, end: text.length, kind: "value" }];
};

/** A secret with the path of the string that holds it. */
interface Located extends SecretSlot {
  readonly segments: Path;
}

type Label = (slot: Located) => string;

interface Rewritten {
  readonly document: JsonObject;
  /** The secrets of the input, in document order. */
  readonly slots: ReadonlyArray<Located>;
}

/** `document` with every secret replaced by `label(slot)`, and the slots in document order. */
const rewriteSecrets = (document: JsonObject, label: Label): Rewritten => {
  const slots: Located[] = [];

  const rewritten = mapStrings(document, [], (path, text) => {
    const position = positionOf(path);

    if (position === undefined) return text;
    const spans = secretsAt(position, text);
    let out = "";
    let cursor = 0;

    for (const span of spans) {
      const slot: Located = {
        path: configPath(path),
        segments: path,
        kind: span.kind,
        value: text.slice(span.start, span.end),
      };

      slots.push(slot);
      out += text.slice(cursor, span.start) + label(slot);
      cursor = span.end;
    }

    return out + text.slice(cursor);
  });

  // SAFETY: mapStrings keeps the shape of its input, an object here.
  return { document: rewritten as JsonObject, slots };
};

const withTail = (label: string, slot: SecretSlot): string =>
  slot.kind === "value" && slot.value.length > 8 ? `${label}…${slot.value.slice(-4)}` : label;

/** Every secret of `document` in document order; slot _n_ is `[redacted#n]` (1-based). */
export const secretSlots = (document: JsonObject): ReadonlyArray<SecretSlot> =>
  rewriteSecrets(document, () => "").slots.map(({ path, kind, value }) => ({ path, kind, value }));

/** A document with its secrets masked. */
export interface MaskedDocument {
  readonly document: JsonObject;
  /** How many secrets were masked (`[redacted#1]` .. `[redacted#secrets]`). */
  readonly secrets: number;
}

/** `document` with every secret masked as `[redacted#n]…abcd`, and how many there are. */
export const maskDocument = (document: JsonObject): MaskedDocument => {
  let next = 0;
  const masked = rewriteSecrets(document, (slot) => withTail(`[redacted#${++next}]`, slot));

  return { document: masked.document, secrets: masked.slots.length };
};

// --- the review ----------------------------------------------------------------------------------------------------

/**
 * Stand-ins for restored secrets while an edit is decoded for the review (`restoreSecrets`' `substitute`): the review
 * tells kept from new secrets by where a value came from, never by comparing values (typing a guess of a stored
 * secret must look the same whether the guess is right or not).
 */
export interface SecretTags {
  /** The stand-in for slot `index`; it keeps what the normaliser looks at in the secret (see {@link secretTags}). */
  readonly standIn: (index: number, slot: SecretSlot) => string;
  /** The slot a stand-in stands for. */
  readonly indexOf: (text: string) => number | undefined;
  /** Whether `text` shows a stand-in, whole or in part. */
  readonly shownIn: (text: string) => boolean;
}

const isJsonText = (text: string): boolean => {
  try {
    JSON.parse(text.trim());

    return true;
  } catch {
    return false;
  }
};

/**
 * Stand-ins built on `nonce` (lower-case letters and digits, unguessable, per request). The normaliser decides on
 * secret values in two places, and a stand-in keeps both properties of the secret it replaces so the review decode
 * keeps and drops exactly what the stored decode does: a `dca:` prefix (Meta keys with it are dropped) and being JSON
 * text (`*-raw` payload rules whose params are not JSON are dropped): a JSON secret is stood in for by the tag as a
 * JSON string, or as `{"secret": tag}` when it names a secret-looking key (the masking of a raw parameter keys on
 * that, so the stand-in stays masked exactly where the secret would). URL parts are always the bare tag.
 */
export const secretTags = (nonce: string): SecretTags => {
  const pattern = new RegExp(`^(?:dca:|\\{"secret":)?"?${nonce}k(\\d+)k"?\\}?$`);

  return {
    standIn: (index, slot) => {
      const tag = `${nonce}k${index}k`;

      if (slot.kind !== "value") return tag;

      if (slot.value.startsWith("dca:")) return `dca:${tag}`;

      if (rawHoldsSecret(slot.value)) return JSON.stringify({ secret: tag });

      return isJsonText(slot.value) ? JSON.stringify(tag) : tag;
    },
    indexOf: (text) => {
      const match = pattern.exec(text);

      return match === null ? undefined : Number(match[1]);
    },
    shownIn: (text) => text.includes(nonce),
  };
};

const at = (value: Json | undefined, path: Path): Json | undefined =>
  path.reduce<Json | undefined>((current, segment) => {
    if (typeof segment === "number") return Array.isArray(current) ? current[segment] : undefined;

    return isJsonObject(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
  }, value);

const stringOrUndefined = (value: Json | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const stringAt = (value: Json | undefined, path: Path): string => {
  const found = at(value, path);

  return typeof found === "string" ? found.trim() : "";
};

const withoutTrailingSlash = (text: string): string => text.replace(/\/+$/, "");

/**
 * A URL without its secret parts, to compare destinations: scheme and host lower-cased, path, the rest of the query
 * and fragment kept, trailing `/` of the path dropped (the cut text when it does not parse).
 */
const cutSecrets = (text: string): string => {
  let cut = "";
  let cursor = 0;

  for (const span of urlSpans(text)) {
    cut += text.slice(cursor, span.start);
    cursor = span.end;
  }

  return cut + text.slice(cursor);
};

const urlWithoutSecrets = (text: string): string => {
  const cut = cutSecrets(text);

  try {
    const url = new URL(cut.trim());

    return `${url.protocol}//${url.host}${withoutTrailingSlash(url.pathname)}${url.search}${url.hash}`;
  } catch {
    return withoutTrailingSlash(cut.trim().toLowerCase());
  }
};

/**
 * Where a secret at `path` of `document` is sent: an `api-keys` key or header goes to its family's upstream at the
 * key's or group's `base-url`; a URL secret to that URL (per field); elsewhere, the section. URLs are compared whole
 * (path included: a shared gateway host serves many accounts) without their secret parts.
 */
const destination = (document: JsonObject, path: Path, kind: SecretKind): string => {
  const [root, family, group] = path;
  const section = `${String(root)}.${String(family)}`;

  if (root === "api-keys" && isIndex(group)) {
    if (kind !== "value")
      return `${section}|${String(path.at(-1))}|${urlWithoutSecrets(stringAt(document, path))}`;
    const keyBase = path[3] === "keys" ? stringAt(document, [...path.slice(0, 5), "base-url"]) : "";
    const base = keyBase === "" ? stringAt(document, [...path.slice(0, 3), "base-url"]) : keyBase;

    return `${section}|${base === "" ? "" : urlWithoutSecrets(base)}`;
  }

  return kind === "value" ? section : `${section}|${urlWithoutSecrets(stringAt(document, path))}`;
};

/**
 * Where a secret goes, for people: the provider family (`api-keys.<family>`) or the config section, and the upstream
 * host (lower-cased, port kept) when there is one. Only the host: it names who receives the secret, while the
 * user info, path and query of a URL can carry secrets or account ids of their own.
 */
export interface SecretPlace {
  readonly family: string;
  readonly host?: string;
}

const hostOf = (text: string): string | undefined => {
  if (text === "") return undefined;

  try {
    const host = new URL(cutSecrets(text).trim()).host.toLowerCase();

    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
};

/** {@link destination} for people: family or section and upstream host only. */
const place = (document: JsonObject, path: Path, kind: SecretKind): SecretPlace => {
  const [root, family, group] = path;
  const name = root === "api-keys" ? String(family) : `${String(root)}.${String(family)}`;
  let url = "";

  if (kind !== "value") url = stringAt(document, path);
  else if (root === "api-keys" && isIndex(group)) {
    const keyBase = path[3] === "keys" ? stringAt(document, [...path.slice(0, 5), "base-url"]) : "";

    url = keyBase === "" ? stringAt(document, [...path.slice(0, 3), "base-url"]) : keyBase;
  }

  const host = hostOf(url);

  return host === undefined ? { family: name } : { family: name, host };
};

/** A kept secret now sent somewhere else than where it was stored. */
export interface MovedSecret {
  /** `configPath` of the secret in the result. */
  readonly path: string;
  /** Its placeholder as the review shows it (`[redacted#n]…abcd`). */
  readonly placeholder: string;
  readonly from: SecretPlace;
  readonly to: SecretPlace;
}

/** The result of an edit masked for the review. */
export interface ReviewedResult {
  readonly document: JsonObject;
  /** Secrets restored from a placeholder. */
  readonly kept: number;
  /** Secrets typed in the edit. */
  readonly fresh: number;
  /** Kept secrets now sent to another provider family or upstream than where they were stored. */
  readonly moved: ReadonlyArray<MovedSecret>;
}

/**
 * `tagged` (the canonical result of an edit decoded with {@link SecretTags} standing for its restored secrets) masked
 * for the review: a tag shows as its `[redacted#n]` with the stored secret's tail, every other secret as
 * `[new secret]` (tail as in {@link maskDocument}). Counts are over the secrets of `tagged`.
 */
export const reviewResult = (
  tagged: JsonObject,
  stored: JsonObject,
  tags: SecretTags,
): ReviewedResult => {
  const slots = rewriteSecrets(stored, () => "").slots;
  const moved = new Map<string, MovedSecret>();
  let kept = 0;
  let fresh = 0;

  const masked = rewriteSecrets(tagged, (slot) => {
    const index = tags.indexOf(slot.value);
    const origin = index === undefined ? undefined : slots[index - 1];

    if (index === undefined || origin === undefined) {
      fresh++;

      return withTail(NEW_SECRET, slot);
    }

    kept++;
    const placeholder = withTail(`[redacted#${index}]`, origin);

    if (
      destination(tagged, slot.segments, slot.kind) !==
      destination(stored, origin.segments, origin.kind)
    )
      moved.set(slot.path, {
        path: slot.path,
        placeholder,
        from: place(stored, origin.segments, origin.kind),
        to: place(tagged, slot.segments, slot.kind),
      });

    return placeholder;
  });

  return { document: masked.document, kept, fresh, moved: [...moved.values()] };
};

/** Every string of `value` (keys included) with its path. */
const eachString = (
  value: Json,
  path: Segment[],
  visit: (path: Path, text: string) => void,
): void => {
  if (typeof value === "string") visit(path, value);
  else if (Array.isArray(value))
    value.forEach((item, index) => eachString(item, [...path, index], visit));
  else if (isJsonObject(value))
    for (const [key, child] of Object.entries(value)) {
      visit([...path, key], key);
      eachString(child, [...path, key], visit);
    }
};

/**
 * Fail-safe after the review decode: the path of the first string of `tagged` (the canonical result decoded with
 * stand-ins) that {@link maskDocument} would still show a stand-in in, keys included; `undefined` when masking hides
 * them all. A normaliser rename or move that takes a restored secret out of a secret position is caught there, and the
 * answer never depends on the secret's value (comparing real values would be a guessing oracle).
 */
export const exposedTagPath = (tagged: JsonObject, tags: SecretTags): string | undefined => {
  let found: string | undefined;

  eachString(maskDocument(tagged).document, [], (path, text) => {
    if (found === undefined && tags.shownIn(text)) found = configPath(path);
  });

  return found;
};

/** A marker (`[redacted…`, `[new secret]`, any case) found by {@link maskedValueAt}. */
export interface MaskedValue {
  /** `configPath` of the string. */
  readonly path: string;
  /** Whether the string is at a secret position (else the marker is plain text in an ordinary field). */
  readonly secret: boolean;
}

/**
 * The first string value of `document` (document order) carrying a marker of a masked value, unless `stored` holds
 * the very same string at the same path (written before writes were guarded: refusing it would block every write).
 * `undefined` when there is none.
 */
export const maskedValueAt = (
  document: JsonObject,
  stored: JsonObject,
): MaskedValue | undefined => {
  let found: MaskedValue | undefined;

  mapStrings(document, [], (path, text) => {
    if (found === undefined && MARKER.test(text) && at(stored, path) !== text)
      found = { path: configPath(path), secret: positionOf(path) !== undefined };

    return text;
  });

  return found;
};

// --- restoring -----------------------------------------------------------------------------------------------------

type Restored =
  | { readonly ok: true; readonly text: string; readonly restored: ReadonlyArray<RestoredSecret> }
  | { readonly ok: false; readonly problem: SecretProblem };

const refuse = (error: SecretProblem["error"], path: Path, message: string): Restored => ({
  ok: false,
  problem: { error, path: configPath(path), message },
});

const KIND_NAMES: Readonly<Record<SecretKind, string>> = {
  value: "a whole value",
  userinfo: "the user info of a URL",
  query: "a URL query value",
};

/** Stored slot `index` (1-based) for a `kind` position, or the refusal. */
const lookup = (
  slots: ReadonlyArray<SecretSlot>,
  index: number,
  kind: SecretKind,
  path: Path,
):
  | { readonly ok: true; readonly slot: SecretSlot }
  | { readonly ok: false; readonly problem: Restored } => {
  const slot = slots[index - 1];

  if (slot === undefined)
    return {
      ok: false,
      problem: refuse(
        "unknown_secret_reference",
        path,
        `[redacted#${index}] is not a secret of this configuration version (it has ${slots.length})`,
      ),
    };

  if (slot.kind !== kind)
    return {
      ok: false,
      problem: refuse(
        "masked_value_outside_secret_field",
        path,
        `[redacted#${index}] is ${KIND_NAMES[slot.kind]}; it cannot stand for ${KIND_NAMES[kind]}`,
      ),
    };

  return { ok: true, slot };
};

const outside = (path: Path): Restored =>
  refuse(
    "masked_value_outside_secret_field",
    path,
    "a masked secret can only stay where secrets are kept (API keys, secret headers, URL credentials)",
  );

const malformed = (path: Path): Restored =>
  refuse(
    "invalid_secret_placeholder",
    path,
    "keep a masked secret exactly as [redacted#n] or replace the whole value with a new secret",
  );

/** What a restored secret is written as: the secret itself, or a stand-in for the review ({@link SecretTags}). */
type Substitute = (index: number, slot: SecretSlot) => string;

const itself: Substitute = (_, slot) => slot.value;

const restoreValue = (
  slots: ReadonlyArray<SecretSlot>,
  position: Position,
  path: Path,
  text: string,
  substitute: Substitute,
): Restored => {
  const match = VALUE_PLACEHOLDER.exec(text);

  if (match === null) return malformed(path);
  const index = Number(match[1]);
  const found = lookup(slots, index, "value", path);

  if (!found.ok) return found.problem;

  // A pure client copy in a header is shown as is, so a secret that reads as one cannot be restored there.
  if (position === "header" && isHeaderCopy(found.slot.value))
    return refuse(
      "masked_value_outside_secret_field",
      path,
      `[redacted#${index}] reads as a copy of a client header, which a header shows unmasked`,
    );

  return {
    ok: true,
    text: substitute(index, found.slot),
    restored: [{ index, kind: "value", value: found.slot.value }],
  };
};

const restoreUrl = (
  slots: ReadonlyArray<SecretSlot>,
  path: Path,
  text: string,
  substitute: Substitute,
  stored: string | undefined,
): Restored => {
  const tokenised = text.replace(PLACEHOLDER, (_, index: string) => sentinel(index));

  if (MARKER.test(tokenised)) return malformed(path);
  const spans = urlSpans(tokenised);
  const restored: RestoredSecret[] = [];
  const written: Span[] = [];
  let out = "";
  let cursor = 0;

  for (const match of tokenised.matchAll(SENTINEL)) {
    const start = match.index;
    const end = start + match[0].length;
    const span = spans.find((candidate) => candidate.start === start && candidate.end === end);

    if (span === undefined)
      return spans.some((candidate) => candidate.start <= start && end <= candidate.end)
        ? malformed(path)
        : outside(path);
    const index = Number(match[1]);
    const found = lookup(slots, index, span.kind, path);

    if (!found.ok) return found.problem;
    const inserted = substitute(index, found.slot);

    out += tokenised.slice(cursor, start);
    written.push({ start: out.length, end: out.length + inserted.length, kind: span.kind });
    out += inserted;
    cursor = end;
    restored.push({ index, kind: span.kind, value: found.slot.value });
  }

  out += tokenised.slice(cursor);

  // The restored secrets must be exactly where the next read looks for them, or they would show unmasked: in the
  // text as written and as the normaliser may store it (trimmed, e.g. a group `base-url`), unless it is the stored text
  // of this very field (stored as is already, and masked).
  const stableIn = (candidate: string, shift: number): boolean => {
    const again = urlSpans(candidate);

    return written.every((span) =>
      again.some(
        (found) =>
          found.start === span.start - shift &&
          found.end === span.end - shift &&
          found.kind === span.kind,
      ),
    );
  };

  const lead = out.length - out.trimStart().length;
  const stable = stableIn(out, 0) && (out === stored || stableIn(out.trim(), lead));

  return stable ? { ok: true, text: out, restored } : malformed(path);
};

const restoreString = (
  slots: ReadonlyArray<SecretSlot>,
  path: Path,
  text: string,
  substitute: Substitute,
  stored: JsonObject,
): Restored => {
  if (!MARKER.test(text)) return { ok: true, text, restored: [] };
  const position = positionOf(path);

  if (position === undefined) return outside(path);

  return position === "url"
    ? restoreUrl(slots, path, text, substitute, stringOrUndefined(at(stored, path)))
    : restoreValue(slots, position, path, text, substitute);
};

/**
 * `edited` (a prepared v8 document) with every `[redacted#n]` replaced by the secret of `stored`'s slot _n_ (or by
 * `substitute(n, slot)`), and the secrets it referenced; or the first refused placeholder.
 */
export const restoreSecrets = (
  edited: JsonObject,
  stored: JsonObject,
  substitute: Substitute = itself,
):
  | {
      readonly ok: true;
      readonly document: JsonObject;
      readonly restored: ReadonlyArray<RestoredSecret>;
    }
  | { readonly ok: false; readonly problem: SecretProblem } => {
  const slots = secretSlots(stored);
  const restored: RestoredSecret[] = [];
  let problem: SecretProblem | undefined;

  const document = mapStrings(edited, [], (path, text) => {
    if (problem !== undefined) return text;
    const result = restoreString(slots, path, text, substitute, stored);

    if (!result.ok) {
      problem = result.problem;

      return text;
    }

    restored.push(...result.restored);

    return result.text;
  });

  if (problem !== undefined) return { ok: false, problem };

  // SAFETY: mapStrings keeps the shape of its input, an object here.
  return { ok: true, document: document as JsonObject, restored };
};
