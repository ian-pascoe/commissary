// The raw configuration editor's model (web/src/lib/raw-config.ts): YAML problems while typing, path and line
// positions, the review's line diff, secret placeholders, and what the server's refusals say.
import { describe, expect, it } from "@effect/vitest";
import {
  changesLine,
  diffRows,
  type DiffLine,
  keptSecretPattern,
  lineDiff,
  lineOf,
  locatedProblem,
  movedWords,
  offsetOf,
  pathOfHash,
  pathParts,
  pathPlace,
  problemAt,
  rawProblem,
  refusalAt,
  secretSegments,
  secretsLine,
  yamlProblems,
} from "../web/src/lib/raw-config.ts";

const moved = (
  from: { family: string; host?: string },
  to: { family: string; host?: string },
  path = "api-keys.openai-compatibility[0].keys[0].api-key",
) => movedWords({ path, placeholder: "[redacted#4]…c1b8", from, to });

const CONFIG = [
  "routing:",
  "  strategy: fill-first",
  "requests:",
  "  payload:",
  "    override:",
  "      - models:",
  "          - name: gpt-*",
  "        params:",
  "          metadata.api_key: x",
  "api-keys:",
  "  claude:",
  '    - api-key: "[redacted#1]…abcd"',
  "    - name: second",
  '      api-key: "[redacted#2]"',
  "oauth:",
  "  request-scoped-errors:",
  "    claude: []",
  "",
].join("\n");

const lineAt = (path: string) => {
  const place = pathPlace(CONFIG, path);

  return place === undefined ? undefined : { ...place, line: lineOf(CONFIG, place.offset) };
};

describe("yamlProblems", () => {
  it("finds nothing in valid YAML", () => {
    expect(yamlProblems(CONFIG)).toEqual([]);
    expect(yamlProblems("")).toEqual([]);
  });

  it("reports a syntax error as a sentence at its position", () => {
    const text = "routing:\n  strategy: [fill-first\n";
    const [problem] = yamlProblems(text);

    expect(problem?.message).toMatch(/^[A-Z].*\.$/);
    expect(problem?.to).toBeGreaterThan(problem?.from ?? Infinity);
  });

  it("refuses duplicate keys and a second document, as the server does", () => {
    expect(yamlProblems("a: 1\na: 2\n")[0]?.message).toMatch(/unique/i);
    expect(yamlProblems("a: 1\n---\nb: 2\n")).not.toEqual([]);
  });
});

describe("positions", () => {
  it("maps offsets to lines and server line/column back to offsets", () => {
    expect(lineOf(CONFIG, 0)).toBe(1);
    expect(lineOf(CONFIG, CONFIG.indexOf("requests:"))).toBe(3);
    expect(offsetOf(CONFIG, 3, 1)).toBe(CONFIG.indexOf("requests:"));
    expect(offsetOf(CONFIG, 2, 3)).toBe(CONFIG.indexOf("strategy"));
    // A column past the line's end stays on the line; a line past the end is the end.
    expect(offsetOf(CONFIG, 1, 99)).toBe(CONFIG.indexOf("\n"));
    expect(offsetOf(CONFIG, 99, 1)).toBe(CONFIG.length);
  });

  it("makes a server problem at least one character wide", () => {
    const problem = problemAt("a: 1\nb: [\n", 2, 1, "Missing ]");

    expect(problem).toEqual({ from: 5, to: 6, message: "Missing ]" });
  });

  it("splits dotted paths with list indexes", () => {
    expect(pathParts("api-keys.claude[0].keys[1].api-key")).toEqual([
      "api-keys",
      "claude",
      0,
      "keys",
      1,
      "api-key",
    ]);
    expect(pathParts("routing")).toEqual(["routing"]);
  });

  it("finds the key a path names", () => {
    expect(lineAt("requests.payload")).toMatchObject({ line: 4, exact: true });
    expect(lineAt("oauth.request-scoped-errors")).toMatchObject({ line: 16, exact: true });
    expect(lineAt("api-keys.claude[1].api-key")).toMatchObject({ line: 14, exact: true });
    // A digit part indexes a list too (the Keys page links `api-keys.<family>.<index>`).
    expect(lineAt("api-keys.claude.1")).toMatchObject({ line: 13, exact: true });
  });

  it("matches keys with dots in their name", () => {
    expect(lineAt("requests.payload.override[0].params.metadata.api_key")).toMatchObject({
      line: 9,
      exact: true,
    });
  });

  it("falls back to the deepest ancestor of a key that is not set", () => {
    expect(lineAt("routing.session-affinity")).toMatchObject({
      line: 1,
      exact: false,
      found: "routing",
    });
    expect(lineAt("api-keys.claude[5]")).toMatchObject({ line: 11, found: "api-keys.claude" });
    expect(lineAt("models.catalog")).toBeUndefined();
    expect(pathPlace("", "routing")).toBeUndefined();
  });

  it("reads a path from the page address", () => {
    expect(pathOfHash("#requests.payload")).toBe("requests.payload");
    expect(pathOfHash("api-keys.claude%5B0%5D")).toBe("api-keys.claude[0]");
    expect(pathOfHash("#")).toBeUndefined();
    expect(pathOfHash("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

const texts = (lines: ReadonlyArray<DiffLine>) =>
  lines.map((line) => `${{ same: " ", added: "+", removed: "-" }[line.kind]}${line.text}`);

describe("lineDiff", () => {
  it("is all unchanged for equal texts", () => {
    const lines = lineDiff("a\nb\n", "a\nb\n");

    expect(texts(lines)).toEqual([" a", " b"]);
    expect(lines[1]).toMatchObject({ before: 2, after: 2 });
    expect(changesLine(lines)).toBeUndefined();
  });

  it("finds the shortest edit with line numbers on both sides", () => {
    const lines = lineDiff("a\nb\nc\nd\n", "a\nc\nx\nd\n");

    expect(texts(lines)).toEqual([" a", "-b", " c", "+x", " d"]);
    expect(lines.find((line) => line.kind === "removed")).toMatchObject({ before: 2 });
    expect(lines.find((line) => line.kind === "added")).toMatchObject({ after: 3 });
    expect(lines.at(-1)).toMatchObject({ before: 4, after: 4 });
    expect(changesLine(lines)).toBe("1 line added, 1 removed");
  });

  it("puts removals before additions in a replaced line", () => {
    expect(texts(lineDiff("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("handles empty sides", () => {
    expect(texts(lineDiff("", "a\nb\n"))).toEqual(["+a", "+b"]);
    expect(texts(lineDiff("a\n", ""))).toEqual(["-a"]);
    expect(lineDiff("", "")).toEqual([]);
    expect(changesLine(lineDiff("", "a\nb"))).toBe("2 lines added");
    expect(changesLine(lineDiff("a\nb", ""))).toBe("2 lines removed");
  });

  it("stays minimal on longer texts", () => {
    const before = Array.from({ length: 400 }, (_, index) => `line ${String(index)}`);
    const after = before.filter((_, index) => index % 50 !== 7).toSpliced(200, 0, "inserted");
    const lines = lineDiff(before.join("\n"), after.join("\n"));

    expect(lines.filter((line) => line.kind === "removed")).toHaveLength(8);
    expect(lines.filter((line) => line.kind === "added")).toHaveLength(1);
    expect(lines.filter((line) => line.kind !== "added").map((line) => line.text)).toEqual(before);
    expect(lines.filter((line) => line.kind !== "removed").map((line) => line.text)).toEqual(after);
  });
});

describe("diffRows", () => {
  const before = Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n");

  it("folds unchanged runs away from changes, keeping the context", () => {
    const rows = diffRows(lineDiff(before, before.replace("\n10\n", "\nten\n")), 3);

    expect(
      rows.map((row) => (row.kind === "gap" ? `gap ${String(row.lines.length)}` : row.line.text)),
    ).toEqual(["gap 6", "7", "8", "9", "10", "ten", "11", "12", "13", "gap 7"]);
  });

  it("shows a run of one hidden line instead of folding it", () => {
    const text = "1\n2\n3\n4\n5\n";
    const rows = diffRows(lineDiff(text, "x\n2\n3\n4\n5\n"), 3);

    expect(rows.some((row) => row.kind === "gap")).toBe(false);
    expect(diffRows(lineDiff(text, text))).toEqual([{ kind: "gap", lines: lineDiff(text, text) }]);
  });
});

describe("secrets", () => {
  it("marks kept and new placeholders with their tails", () => {
    expect(secretSegments('  api-key: "[redacted#12]…ab\\"c"')).toEqual([
      { text: '  api-key: "' },
      { text: '[redacted#12]…ab\\"c', secret: "kept" },
      { text: '"' },
    ]);
    expect(secretSegments("url: https://[redacted#3]@proxy.test")).toEqual([
      { text: "url: https://" },
      { text: "[redacted#3]", secret: "kept" },
      { text: "@proxy.test" },
    ]);
    expect(secretSegments('k: "[new secret]…wxyz"')[1]).toEqual({
      text: "[new secret]…wxyz",
      secret: "new",
    });
    expect(secretSegments("")).toEqual([{ text: "" }]);
  });

  it("finds every kept placeholder with a fresh pattern", () => {
    const text = '"[redacted#1]…abcd" and "[redacted#2]"';

    expect([...text.matchAll(keptSecretPattern())].map((match) => match[0])).toEqual([
      "[redacted#1]…abcd",
      "[redacted#2]",
    ]);
  });

  it("counts secrets in words", () => {
    expect(secretsLine(0, 0)).toBe("No secrets");
    expect(secretsLine(1, 0)).toBe("1 secret kept");
    expect(secretsLine(7, 1)).toBe("7 secrets kept, 1 new");
    expect(secretsLine(0, 2)).toBe("2 new secrets");
    expect(secretsLine(5, 1, 1)).toBe("5 secrets kept, 1 new, 1 sent somewhere new");
  });

  it("says where a moved secret was stored and where it goes", () => {
    expect(
      moved(
        { family: "openai-compatibility", host: "openrouter.ai" },
        { family: "openai-compatibility", host: "llm-gateway.example.net" },
      ),
    ).toEqual({ from: "openrouter.ai", to: "llm-gateway.example.net", via: "on this key" });
    // Same host, another path: a gateway serving many accounts.
    expect(
      moved({ family: "claude", host: "gw.test" }, { family: "claude", host: "gw.test" }).to,
    ).toBe("another address on gw.test");
    // Another family: named, with the default address when the configuration sets none.
    expect(moved({ family: "claude" }, { family: "codex", host: "evil.test" })).toMatchObject({
      from: "Claude’s default address",
      to: "Codex at evil.test",
    });
    expect(
      moved(
        { family: "requests.proxy-url", host: "proxy.test" },
        { family: "requests.proxy-url", host: "evil.test" },
        "requests.proxy-url",
      ).via,
    ).toBe("that uses it");
  });
});

describe("refusals", () => {
  it("points at the server's line and column, else the key its path names", () => {
    expect(refusalAt("a: 1\nb: [\n", { line: 2, column: 4 }, "Missing ]")).toEqual({
      from: 8,
      to: 9,
      message: "Missing ]",
    });
    const key = refusalAt(CONFIG, { path: "routing.strategy" }, "Unknown strategy");

    expect(key && CONFIG.slice(key.from, key.to)).toBe("strategy");
    expect(refusalAt(CONFIG, { path: "models.catalog" }, "x")).toBeUndefined();
    expect(refusalAt(CONFIG, {}, "x")).toBeUndefined();
  });

  it("frames the server's message", () => {
    expect(rawProblem("invalid_yaml", "map keys must be unique", "")).toBe(
      "This is not valid YAML. Map keys must be unique.",
    );
    expect(rawProblem("invalid_config", undefined, "")).toBe(
      "The configuration would not be valid.",
    );
    expect(rawProblem("invalid_secret_placeholder", "keep it", "")).toMatch(
      /^This placeholder was edited/,
    );
    expect(rawProblem("unknown_secret_reference", "[redacted#9] is not a secret", "")).toContain(
      "[redacted#9] is not a secret.",
    );
    expect(rawProblem("something_else", "the control plane is unavailable", "")).toBe(
      "The control plane is unavailable.",
    );
    expect(rawProblem("invalid_config", "routing.strategy: not a strategy", "")).toBe(
      "The configuration would not be valid. routing.strategy: not a strategy.",
    );
    expect(rawProblem(undefined, undefined, "Network error.")).toBe("Network error.");
  });

  it("gives a located YAML or validation problem as the server's sentence alone", () => {
    expect(locatedProblem("invalid_config", "routing.strategy: not a strategy", "")).toBe(
      "routing.strategy: not a strategy.",
    );
    expect(locatedProblem("invalid_yaml", "map keys must be unique", "")).toBe(
      "Map keys must be unique.",
    );
    expect(locatedProblem("invalid_secret_placeholder", "keep it", "")).toMatch(
      /^This placeholder was edited/,
    );
    expect(locatedProblem("invalid_config", undefined, "")).toBe(
      "The configuration would not be valid.",
    );
  });
});
