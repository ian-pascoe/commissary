// A stored secret must not be confirmable by typing a guess, and a typed key must never delete a stored one: a write
// answers the same whether the typed key equals a stored one or not (api-keys writes and the raw configuration
// editor), and stored keys win over typed ones. The state after the write is asserted, not only the reply, through
// the router and the real ControlPlane.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json/index.ts";
import { controlPlane, jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { json } = harness;

const KEY_A = "AIzaSy-ORACLE-KEY-ONE-4242";

const KEY_B = "AIzaSy-ORACLE-KEY-TWO-7373";

/** A guess of `secret` with the same length and alphabet that is wrong. */
const wrongGuess = (secret: string): string => `X${secret.slice(1)}`;

const seed = async (document: Record<string, unknown>): Promise<number> => {
  const result = await controlPlane().putConfig(JSON.stringify(document));

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

/** The version of a reply with the number replaced, so replies of different runs compare as text. */
const withoutVersion = (text: string, version: number): string =>
  text.replace(`"version":${version}`, '"version":"<next>"');

/**
 * What is really stored of a family's groups (not what a reply says): per group its first `excluded-models` entry, a
 * marker that tells groups apart whatever their keys, then its keys' secrets. `-` is no marker.
 */
const storedSecrets = async (family = "gemini"): Promise<string[][]> => {
  const { document } = await controlPlane().getConfig();

  // SAFETY: the stored document is a serialized JSON object of the config shape (this test seeds it).
  const parsed = JSON.parse(document ?? "{}") as {
    "api-keys"?: Record<
      string,
      | ReadonlyArray<{
          "excluded-models"?: ReadonlyArray<string>;
          keys?: ReadonlyArray<{ "api-key"?: string }>;
        }>
      | undefined
    >;
  };

  return (parsed["api-keys"]?.[family] ?? []).map((group) => [
    group["excluded-models"]?.[0] ?? "-",
    ...(group.keys ?? []).map((key) => key["api-key"] ?? ""),
  ]);
};

interface Listed {
  readonly version: number;
  readonly families: Record<
    string,
    ReadonlyArray<{
      readonly group: { readonly keys: ReadonlyArray<{ readonly auth_index?: string }> };
    }>
  >;
}

describe("api-keys writes: a typed key equal to a stored one", () => {
  const stored = {
    "api-keys": {
      gemini: [
        { "excluded-models": ["m0"], keys: [{ "api-key": KEY_A }] },
        { "excluded-models": ["m1"], keys: [{ "api-key": KEY_B }] },
      ],
    },
  };

  type Indexes = ReadonlyArray<ReadonlyArray<string>>;

  const put = async (
    document: Record<string, unknown>,
    build: (indexes: Indexes) => JsonObject,
    family = "gemini",
  ) => {
    const version = await seed(document);
    const listed = (await json("/v8/management/api-keys")).body as Listed;

    const indexes = (listed.families[family] ?? []).map((entry) =>
      entry.group.keys.map((key) => key.auth_index ?? ""),
    );

    expect(listed.version).toBe(version);

    const reply = await json(
      "/v8/management/api-keys/groups",
      jsonInit("PUT", { version, ...build(indexes) }),
    );

    return { version, reply, after: await storedSecrets(family) };
  };

  const scenarios: ReadonlyArray<{
    readonly name: string;
    /** The stored secret the guess is a copy of when it is right. */
    readonly secret: string;
    readonly body: (guess: string, indexes: Indexes) => JsonObject;
    readonly right: ReadonlyArray<ReadonlyArray<string>>;
    readonly wrong: (guess: string) => ReadonlyArray<ReadonlyArray<string>>;
  }> = [
    {
      name: "a new group made of the copy: never created, nothing else touched",
      secret: KEY_A,
      body: (guess) => ({
        family: "gemini",
        group: { "excluded-models": ["new"], keys: [{ "api-key": guess }] },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A],
        ["m1", KEY_B],
        ["new", guess],
      ],
    },
    {
      name: "a copy of a LATER group's key beside a kept key: the stored key of the later group stays",
      secret: KEY_B,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 0,
        group: {
          "excluded-models": ["m0"],
          keys: [{ auth_index: indexes[0]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A, guess],
        ["m1", KEY_B],
      ],
    },
    {
      name: "the only key written is a copy of a later group's key: the group is left empty and removed, the later one stays",
      secret: KEY_B,
      body: (guess) => ({
        family: "gemini",
        index: 0,
        group: { "excluded-models": ["m0"], keys: [{ "api-key": guess }] },
      }),
      right: [["m1", KEY_B]],
      wrong: (guess) => [
        ["m0", guess],
        ["m1", KEY_B],
      ],
    },
    {
      name: "a copy of an EARLIER group's key beside a kept key",
      secret: KEY_A,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 1,
        group: {
          "excluded-models": ["m1"],
          keys: [{ auth_index: indexes[1]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A],
        ["m1", KEY_B, guess],
      ],
    },
    {
      name: "a copy of the key the group keeps itself",
      secret: KEY_A,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 0,
        group: {
          "excluded-models": ["m0"],
          keys: [{ auth_index: indexes[0]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A, guess],
        ["m1", KEY_B],
      ],
    },
  ];

  for (const scenario of scenarios)
    it(`answers a right and a wrong guess alike and keeps every stored key: ${scenario.name}`, async () => {
      const right = await put(stored, (indexes) => scenario.body(scenario.secret, indexes));
      await resetControlPlane();
      const guess = wrongGuess(scenario.secret);
      const wrong = await put(stored, (indexes) => scenario.body(guess, indexes));

      // `{status, version}` with the version one ahead, whatever the typed key was.
      expect(right.reply.status).toBe(200);
      expect(wrong.reply.status).toBe(200);
      expect(right.reply.headers.get("content-type")).toBe(wrong.reply.headers.get("content-type"));

      expect(JSON.stringify(right.reply.body)).toBe(
        JSON.stringify({ status: "ok", version: right.version + 1 }),
      );

      expect(withoutVersion(JSON.stringify(right.reply.body), right.version + 1)).toBe(
        withoutVersion(JSON.stringify(wrong.reply.body), wrong.version + 1),
      );

      // The state is what tells them apart (the next read), and no stored key is ever lost.
      expect(right.after).toEqual(scenario.right);
      expect(wrong.after).toEqual(scenario.wrong(guess));
    });

  it("keeps one of two typed copies of each other, and a copy of a key kept in the same request", async () => {
    const twice = await put(stored, () => ({
      family: "gemini",
      group: { keys: [{ "api-key": "typed-twice" }, { "api-key": "typed-twice" }] },
    }));

    expect(twice.reply.status).toBe(200);
    expect(twice.after).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
      ["-", "typed-twice"],
    ]);
  });

  it("answers alike for header values tried on a key kept by auth_index, or on its group (never a 422)", async () => {
    const HEADER = "hdr-secret-value-9191";

    const withHeaders = {
      "api-keys": {
        gemini: [
          {
            prefix: "a",
            "excluded-models": ["m0"],
            keys: [{ "api-key": KEY_A, headers: { "X-Token": HEADER } }],
          },
          { prefix: "b", "excluded-models": ["m1"], keys: [{ "api-key": KEY_A }] },
        ],
      },
    };

    // The edit moves group 1 to prefix "a": its kept key equals group 0's exactly when the header tried is right.
    const tried = (headers: Record<string, string>) => (indexes: Indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        "excluded-models": ["m1"],
        keys: [{ auth_index: indexes[1]?.[0] ?? "", headers }],
      },
    });

    const right = await put(withHeaders, tried({ "X-Token": HEADER }));
    await resetControlPlane();
    const wrong = await put(withHeaders, tried({ "X-Token": wrongGuess(HEADER) }));

    expect(right.reply.status).toBe(200);
    expect(wrong.reply.status).toBe(200);

    expect(withoutVersion(JSON.stringify(right.reply.body), right.version + 1)).toBe(
      withoutVersion(JSON.stringify(wrong.reply.body), wrong.version + 1),
    );

    // The copy goes (group 1 is left empty and removed); group 0 keeps its key.
    expect(right.after).toEqual([["m0", KEY_A]]);

    expect(wrong.after).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_A],
    ]);

    // The same through the group's own headers.
    await resetControlPlane();

    const viaGroup = await put(withHeaders, (indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        "excluded-models": ["m1"],
        headers: { "X-Token": HEADER },
        keys: [{ auth_index: indexes[1]?.[0] ?? "" }],
      },
    }));

    expect(viaGroup.reply.status).toBe(200);
    expect(viaGroup.after).toEqual([["m0", KEY_A]]);
  });

  it("refuses a key kept by auth_index that the edit makes equal to a key of another group", async () => {
    const same = {
      "api-keys": {
        gemini: [
          { prefix: "a", keys: [{ "api-key": KEY_A }] },
          { prefix: "b", keys: [{ "api-key": KEY_A }, { "api-key": KEY_B }] },
        ],
      },
    };

    const refused = await put(same, (indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        keys: [{ auth_index: indexes[1]?.[0] ?? "" }, { auth_index: indexes[1]?.[1] ?? "" }],
      },
    }));

    expect(refused.reply.status).toBe(422);
    expect(JSON.stringify(refused.reply.body)).toContain("another group");
    expect(JSON.stringify(refused.reply.body)).not.toContain(KEY_A);
    expect(refused.after).toEqual([
      ["-", KEY_A],
      ["-", KEY_A, KEY_B],
    ]);
    expect((await controlPlane().getConfig()).version).toBe(refused.version);
  });

  it("applies the same rule to vertex keys (unique by key and base-url)", async () => {
    const vertex = {
      "api-keys": {
        vertex: [
          {
            "base-url": "https://v.example.test",
            "excluded-models": ["m0"],
            keys: [{ "api-key": KEY_A }],
          },
          {
            "base-url": "https://v.example.test",
            "excluded-models": ["m1"],
            keys: [{ "api-key": KEY_B }],
          },
        ],
      },
    };

    const right = await put(
      vertex,
      () => ({
        family: "vertex",
        index: 0,
        group: {
          "base-url": "https://v.example.test",
          "excluded-models": ["m0"],
          keys: [{ "api-key": KEY_B }],
        },
      }),
      "vertex",
    );

    expect(right.reply.status).toBe(200);
    expect(right.after).toEqual([["m1", KEY_B]]);
  });

  it("keeps duplicates of a family Go does not deduplicate (codex)", async () => {
    const codex = {
      "api-keys": {
        codex: [{ "base-url": "https://c.example.test", keys: [{ "api-key": KEY_A }] }],
      },
    };

    const written = await put(
      codex,
      () => ({
        family: "codex",
        group: { "base-url": "https://c.example.test", keys: [{ "api-key": KEY_A }] },
      }),
      "codex",
    );

    expect(written.reply.status).toBe(200);
    expect(written.after).toEqual([
      ["-", KEY_A],
      ["-", KEY_A],
    ]);
  });

  it("still refuses a group the normaliser drops for its own shape", async () => {
    const version = await seed(stored);

    const reply = await json(
      "/v8/management/api-keys/groups",
      jsonInit("PUT", { version, family: "codex", group: { keys: [{ "api-key": KEY_A }] } }),
    );

    expect(reply.status).toBe(422);
    expect(JSON.stringify(reply.body)).toContain("base-url");
    expect(JSON.stringify(reply.body)).not.toContain("duplicate");
    expect(JSON.stringify(reply.body)).not.toContain(KEY_A);
  });
});

describe("raw configuration editor: a typed secret equal to a stored one", () => {
  const RAW = "/v8/management/settings/config";

  const stored = {
    "api-keys": {
      gemini: [
        { "excluded-models": ["m0"], keys: [{ "api-key": KEY_A }] },
        { "excluded-models": ["m1"], keys: [{ "api-key": KEY_B }] },
      ],
    },
  };

  const KEY_LINES = /^(\s*)- api-key: .*$/gm;

  /** `yaml` with the key line number `index` (in document order) rewritten by `rewrite(line, indent)`. */
  const atKey =
    (index: number, rewrite: (line: string, indent: string) => string) =>
    (yaml: string): string => {
      let seen = -1;

      return yaml.replace(KEY_LINES, (line, indent: string) => {
        seen += 1;

        return seen === index ? rewrite(line, indent) : line;
      });
    };

  const typed = (secret: string): string => JSON.stringify(secret);

  /** The editor text with key `index` replaced by a typed key. */
  const replaced = (index: number, secret: string) =>
    atKey(index, (_line, indent) => `${indent}- api-key: ${typed(secret)}`);

  /** The editor text with a typed key added after key `index`. */
  const added = (index: number, secret: string) =>
    atKey(index, (line, indent) => `${line}\n${indent}- api-key: ${typed(secret)}`);

  const edit = async (
    document: Record<string, unknown>,
    yamlOf: (yaml: string) => string,
    method: "PUT" | "POST" = "PUT",
  ) => {
    const version = await seed(document);
    const view = (await json(RAW)).body as { yaml: string; version: number };

    expect(view.version).toBe(version);
    expect(KEY_LINES.test(view.yaml)).toBe(true);
    KEY_LINES.lastIndex = 0;
    const yaml = yamlOf(view.yaml);

    expect(yaml).not.toBe(view.yaml);

    const reply = await harness.call(
      method === "PUT" ? RAW : `${RAW}/check`,
      jsonInit(method, { version, yaml }),
    );

    const text = await reply.text();
    const after = await controlPlane().getConfig();

    return {
      version,
      status: reply.status,
      text,
      stored: after.version,
      keys: await storedSecrets(),
    };
  };

  const compare = (
    right: Awaited<ReturnType<typeof edit>>,
    wrong: Awaited<ReturnType<typeof edit>>,
  ) => {
    expect(right.status).toBe(200);
    expect(wrong.status).toBe(200);
    expect(right.stored).toBe(right.version + 1);
    expect(wrong.stored).toBe(wrong.version + 1);

    expect(withoutVersion(right.text, right.version + 1)).toBe(
      withoutVersion(wrong.text, wrong.version + 1),
    );
  };

  it("drops a typed copy of a LATER group's key, never the stored one: same reply, version advances", async () => {
    const right = await edit(stored, replaced(0, KEY_B));
    await resetControlPlane();
    const guess = wrongGuess(KEY_B);
    const wrong = await edit(stored, replaced(0, guess));

    compare(right, wrong);
    // Group 0 held only the copy: it is gone, and group 1 still holds its stored key.
    expect(right.keys).toEqual([["m1", KEY_B]]);

    expect(wrong.keys).toEqual([
      ["m0", guess],
      ["m1", KEY_B],
    ]);
    expect(right.text).not.toContain(KEY_B);
  });

  it("drops a typed copy of a stored key added beside a kept one", async () => {
    const right = await edit(stored, added(0, KEY_B));
    await resetControlPlane();
    const guess = wrongGuess(KEY_B);
    const wrong = await edit(stored, added(0, guess));

    compare(right, wrong);
    expect(right.keys).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
    ]);

    expect(wrong.keys).toEqual([
      ["m0", KEY_A, guess],
      ["m1", KEY_B],
    ]);
  });

  it("drops a typed copy of an EARLIER group's key", async () => {
    const right = await edit(stored, added(1, KEY_A));
    await resetControlPlane();
    const guess = wrongGuess(KEY_A);
    const wrong = await edit(stored, added(1, guess));

    compare(right, wrong);
    expect(right.keys).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
    ]);

    expect(wrong.keys).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B, guess],
    ]);
  });

  it("saves a stored key typed in place of its placeholder like a changed one", async () => {
    const one = { "api-keys": { gemini: [{ keys: [{ "api-key": KEY_A }] }] } };
    const right = await edit(one, replaced(0, KEY_A));
    await resetControlPlane();
    const wrong = await edit(one, replaced(0, wrongGuess(KEY_A)));

    compare(right, wrong);
    expect(right.keys).toEqual([["-", KEY_A]]);
  });

  it("checks without storing: the same check reply for a right and a wrong guess", async () => {
    const right = await edit(stored, added(0, KEY_B), "POST");
    await resetControlPlane();
    const wrong = await edit(stored, added(0, wrongGuess(KEY_B)), "POST");

    expect(right.status).toBe(200);
    expect(right.stored).toBe(right.version);
    expect(right.text).toBe(wrong.text);
    expect(right.keys).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
    ]);
  });

  it("still writes nothing when the editor text is saved as it was read", async () => {
    const version = await seed(stored);
    const view = (await json(RAW)).body as { yaml: string };
    const reply = await harness.call(RAW, jsonInit("PUT", { version, yaml: view.yaml }));
    const text = await reply.text();

    expect(reply.status).toBe(200);
    expect((await controlPlane().getConfig()).version).toBe(version);
    expect(text).toContain(`"version":${version}`);
    expect(await storedSecrets()).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
    ]);
  });
});
