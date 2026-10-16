/**
 * Email domains of per-org single sign-on (issue #76): how a domain is written, and the DNS TXT record that proves an
 * org controls it. Shared with the browser: no imports. New in the Workers port.
 *
 * An org owner adds a domain; Commissary gives it a random token, and the domain is unverified until a TXT record
 * `_commissary-challenge.<domain>` holding `commissary-domain-verification=<token>` is found (`dns.ts`). Only that
 * exact domain is verified: a subdomain is a domain of its own.
 */

/** The label in front of the domain that the TXT record is published under. */
export const CHALLENGE_LABEL = "_commissary-challenge";

/** What the TXT record holds before the token. */
export const CHALLENGE_PREFIX = "commissary-domain-verification=";

/** The longest domain name DNS allows. */
const MAX_DOMAIN_LENGTH = 253;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ALL_DIGITS = /^[0-9]+$/;

/**
 * `input` as a domain: trimmed, lowercased, without a trailing dot; `undefined` for anything but a DNS name of two or
 * more labels (an IP address, a single label, `*`, a URL or an email are refused). Internationalised names are written
 * in their ASCII (`xn--`) form.
 */
export const normalizeDomain = (input: string): string | undefined => {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");

  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return undefined;
  const labels = domain.split(".");

  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;

  // A top-level label is never all digits: that is an IPv4 address.
  return ALL_DIGITS.test(labels.at(-1) ?? "") ? undefined : domain;
};

/** The domain of an email address (lowercased), `undefined` without one. */
export const emailDomain = (email: string): string | undefined => {
  const at = email.lastIndexOf("@");

  return at <= 0 ? undefined : normalizeDomain(email.slice(at + 1));
};

/** A DNS TXT record: its name and the value it holds. */
export interface TxtRecord {
  readonly name: string;
  readonly value: string;
}

/** The DNS TXT record that verifies `domain` with `token`. */
export const challengeRecord = (domain: string, token: string): TxtRecord => ({
  name: `${CHALLENGE_LABEL}.${domain}`,
  value: `${CHALLENGE_PREFIX}${token}`,
});
