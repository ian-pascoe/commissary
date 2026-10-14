/**
 * Domain proof for per-org single sign-on (issue #76): the TXT records of a name, read with DNS over HTTPS from
 * Cloudflare's resolver (a Worker has no resolver of its own). New in the Workers port.
 */
import { Effect } from "effect";

/** Cloudflare's DNS over HTTPS resolver, JSON API. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** How long the resolver may take before the check is `unavailable`. */
const DOH_TIMEOUT_MS = 10_000;

/** DNS TXT record type. */
const TXT = 16;

/** NOERROR and NXDOMAIN: the name answered, with or without records. */
const ANSWERED = new Set([0, 3]);

export type TxtLookup =
  | { readonly kind: "answered"; readonly records: ReadonlyArray<string> }
  | { readonly kind: "unavailable" };

interface DohAnswer {
  readonly Status?: unknown;
  readonly Answer?: ReadonlyArray<{ readonly type?: unknown; readonly data?: unknown }>;
}

/**
 * One TXT record's text: the resolver writes its character strings quoted and space-separated
 * (`"abc" "def"`), which together are one value (`abcdef`).
 */
const recordText = (data: string): string => {
  const strings = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] ?? "").replace(/\\(.)/g, "$1"),
  );

  return strings.length === 0 ? data : strings.join("");
};

/** The TXT records of `name`; `unavailable` when the resolver cannot be reached or fails. */
export const lookupTxt = (name: string): Effect.Effect<TxtLookup> =>
  Effect.tryPromise(async (): Promise<TxtLookup> => {
    const url = new URL(DOH_URL);

    url.searchParams.set("name", name);
    url.searchParams.set("type", "TXT");

    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });

    if (!response.ok) return { kind: "unavailable" };
    const body = await response.json<DohAnswer>();

    if (typeof body.Status !== "number" || !ANSWERED.has(body.Status))
      return { kind: "unavailable" };

    return {
      kind: "answered",
      records: (body.Answer ?? []).flatMap((answer) =>
        answer.type === TXT && typeof answer.data === "string" ? [recordText(answer.data)] : [],
      ),
    };
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("DNS over HTTPS unreachable").pipe(
        Effect.as({ kind: "unavailable" } as const),
      ),
    ),
  );
