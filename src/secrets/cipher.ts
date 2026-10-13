/**
 * Sealed values: an org's stored secrets encrypted with its data key (`data-key.ts`). New in the Workers port.
 *
 * A sealed value is the text `enc:v1:` + base64url(nonce ‖ ciphertext ‖ tag): AES-256-GCM under the org's data key with
 * a fresh random 96-bit nonce per value and a 128-bit tag. The additional data is `enc:v1` and the value's context
 * (`<table>/<row id>`), so a value only opens where it was written, and the version prefix lets the format change later.
 * Random nonces keep each data key far below the 2^32 values after which they could repeat: every org has its own key,
 * and a value is only sealed when it is written.
 *
 * The data key is a node:crypto `KeyObject` rather than a WebCrypto `CryptoKey`: the ControlPlane's stores read and
 * write SQLite synchronously (a read-modify-write stays atomic under the Durable Object's input gate), and
 * `crypto.subtle` is async only. workerd's `createCipheriv` needs the raw key bytes, so it cannot use a non-extractable
 * `CryptoKey` either; the `KeyObject` stays private to its cipher and is never exported or logged. The secrets key that
 * wraps it is a non-extractable `CryptoKey` (`data-key.ts`). workerd implements both APIs over the same BoringSSL AES-GCM.
 */
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createSecretKey, type KeyObject } from "node:crypto";

/** Bytes of a data key (AES-256). */
export const DATA_KEY_BYTES = 32;

const VERSION = "enc:v1";

const PREFIX = `${VERSION}:`;

const NONCE_BYTES = 12;

const TAG_BYTES = 16;

/** Seals and opens an org's stored secrets (`SecretCipher`, or the ControlPlane's `OrgSecrets` in front of one). */
export interface Sealer {
  /** `plaintext` sealed for `context` (where it is stored, `<table>/<row id>`). */
  readonly seal: (plaintext: string, context: string) => string;
  /** The plaintext of a value sealed for `context`; throws `SealedValueError` for anything else. */
  readonly open: (sealed: string, context: string) => string;
}

/**
 * A stored value that is not a sealed value, or does not open with the org's data key for its context: never answered
 * as data. The message names the context, never the value.
 */
export class SealedValueError extends Error {
  override readonly name = "SealedValueError";
}

/** Whether `text` has the shape of a sealed value (JSON text never starts with `enc:`). */
export const isSealed = (text: string): boolean => text.startsWith(PREFIX);

const additionalData = (context: string): Buffer =>
  Buffer.from(`${VERSION}\u0000${context}`, "utf8");

/** AES-256-GCM sealing under one org's data key. */
export class SecretCipher implements Sealer {
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /**
   * A cipher under the data key `raw` (32 bytes). The bytes are copied into the key; the caller wipes its own copy.
   */
  static fromRawKey(raw: Uint8Array): SecretCipher {
    if (raw.byteLength !== DATA_KEY_BYTES)
      throw new Error(`a data key is ${DATA_KEY_BYTES} bytes, not ${raw.byteLength}`);

    return new SecretCipher(createSecretKey(Buffer.from(raw)));
  }

  readonly seal = (plaintext: string, context: string): string => {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });

    cipher.setAAD(additionalData(context));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
  };

  readonly open = (sealed: string, context: string): string => {
    if (!isSealed(sealed))
      throw new SealedValueError(
        `${context}: the stored value is not sealed with the org's data key`,
      );
    const bytes = Buffer.from(sealed.slice(PREFIX.length), "base64url");

    if (bytes.length < NONCE_BYTES + TAG_BYTES)
      throw new SealedValueError(`${context}: the sealed value is truncated`);

    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, NONCE_BYTES), {
      authTagLength: TAG_BYTES,
    });

    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));

    try {
      return Buffer.concat([
        decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SealedValueError(
        `${context}: the sealed value does not open with the org's data key (another key, or the value was changed)`,
      );
    }
  };
}
