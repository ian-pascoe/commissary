/**
 * Value-free YAML error messages: a fixed sentence per `yaml` library error code, never the library's own text
 * (which can quote the source: a tag, an escape, an alias name, a key). Workers addition; the caller reports the
 * position as line and column.
 */
import type { ErrorCode, YAMLError } from "yaml";

const MESSAGES: Readonly<Record<ErrorCode, string>> = {
  ALIAS_PROPS: "an alias cannot have an anchor or a tag",
  BAD_ALIAS: "invalid alias",
  BAD_COLLECTION_TYPE: "custom tags are not supported",
  BAD_DIRECTIVE: "invalid directive",
  BAD_DQ_ESCAPE: "invalid escape sequence in a double-quoted string",
  BAD_INDENT: "bad indentation",
  BAD_PROP_ORDER: "anchors and tags must come before the value",
  BAD_SCALAR_START: "a plain value cannot start with this character",
  BLOCK_AS_IMPLICIT_KEY: "a block collection cannot be an implicit key",
  BLOCK_IN_FLOW: "a block collection cannot be inside a flow collection",
  DUPLICATE_KEY: "map keys must be unique",
  IMPOSSIBLE: "unexpected parser state",
  KEY_OVER_1024_CHARS: "an implicit key cannot be longer than 1024 characters",
  MISSING_CHAR: "a closing character is missing",
  MULTILINE_IMPLICIT_KEY: "an implicit key must be on a single line",
  MULTIPLE_ANCHORS: "a node can have only one anchor",
  MULTIPLE_DOCS: "only one YAML document is supported",
  MULTIPLE_TAGS: "a node can have only one tag",
  NON_STRING_KEY: "map keys must be strings",
  RESOURCE_EXHAUSTION: "too many alias expansions",
  TAB_AS_INDENT: "tabs cannot be used for indentation",
  TAG_RESOLVE_FAILED: "custom tags are not supported",
  UNEXPECTED_TOKEN: "unexpected token",
};

/** The fixed message for `error`'s code (`invalid syntax` for a code this table does not know). */
export const yamlMessage = (error: YAMLError): string =>
  Object.hasOwn(MESSAGES, error.code) ? MESSAGES[error.code] : "invalid syntax";
