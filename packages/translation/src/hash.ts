// Translation's private copy of the Worker's hashing helper (Go `sha256.Sum256` + `hex.EncodeToString` over a string);
// not exported: translation shares no foundation code.
import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`. */
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
