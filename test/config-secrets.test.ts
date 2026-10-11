// The raw configuration's secret masking (src/management/config-secrets.ts): slots, mask, restore, review masking.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json/index.ts";
import {
  exposedTagPath,
  maskDocument,
  restoreSecrets,
  reviewResult,
  secretSlots,
  secretTags,
} from "../src/management/config-secrets.ts";

const S = {
  gemini: "AIzaSy-GEMINI-SECRET-0001",
  interactions: "AIzaSy-INTERACTIONS-SECRET-0002",
  vertex: "vertex-SECRET-0003",
  codex: "sk-codex-SECRET-0004",
  claude: "sk-ant-CLAUDE-SECRET-0005",
  claude2: "sk-ant-CLAUDE-SECRET-0006",
  xai: "xai-SECRET-0007",
  meta: "meta-SECRET-0008",
  compat: "sk-compat-SECRET-0009",
  groupAuth: "Bearer group-header-SECRET-0010",
  keyCookie: "session=key-cookie-SECRET-0011",
  compatHeader: "compat-header-SECRET-0012",
  client: "client-key-SECRET-0013",
  short: "abc123",
  proxyUser: "proxy-user:proxy-pass-SECRET-0014",
  groupProxyUser: "gp-user:gp-pass-SECRET-0015",
  keyProxyUser: "kp-user:kp-pass-SECRET-0016",
  baseUser: "base-user:base-pass-SECRET-0017",
  catalogToken: "catalog-token-SECRET-0018",
  payloadPattern: "Bearer sk-payload-SECRET-0019*",
} as const;

/** A canonical-shaped document with a secret in every kind of position. */
const stored = (): JsonObject => ({
  "config-version": 8,
  models: { catalog: `https://cdn.test/models.json?v=2&token=${S.catalogToken}` },
  access: { "api-keys": [S.client, S.short], "admin-emails": ["admin@example.com"] },
  requests: {
    "proxy-url": `http://${S.proxyUser}@proxy.test:8080`,
    payload: {
      default: [
        {
          models: [
            {
              name: "gpt-*",
              headers: { Authorization: S.payloadPattern, "Anthropic-Beta": "red" },
            },
          ],
          params: { temperature: 0 },
        },
      ],
    },
  },
  "api-keys": {
    gemini: [{ keys: [{ "api-key": S.gemini }] }],
    interactions: [{ keys: [{ "api-key": S.interactions }] }],
    vertex: [{ "base-url": "https://vertex.test", keys: [{ "api-key": S.vertex }] }],
    codex: [{ "base-url": "https://codex.test", keys: [{ "api-key": S.codex }] }],
    claude: [
      {
        name: "main",
        "base-url": `https://${S.baseUser}@api.anthropic.test`,
        "proxy-url": `socks5://${S.groupProxyUser}@proxy.test:1080`,
        headers: {
          Authorization: S.groupAuth,
          "X-Copy": "$Authorization",
          "User-Agent": "visible",
        },
        keys: [
          { "api-key": S.claude, headers: { Cookie: S.keyCookie, "x-api-key": "$x-api-key" } },
          { "api-key": S.claude2, "proxy-url": `http://${S.keyProxyUser}@proxy.test` },
        ],
      },
    ],
    xai: [{ "base-url": "https://xai.test", keys: [{ "api-key": S.xai }] }],
    meta: [{ keys: [{ "api-key": S.meta }] }],
    "openai-compatibility": [
      {
        name: "compat",
        "base-url": "https://compat.test/v1",
        headers: { "X-Api-Key": S.compatHeader },
        keys: [{ "api-key": S.compat }],
      },
    ],
  },
});

const masked = () => maskDocument(stored());

/** The masked document as the editor would send it back after `edit`. */
const edited = (edit: (document: JsonObject) => void = () => {}): JsonObject => {
  const document = structuredClone(masked().document);
  edit(document);

  return document;
};

/** Navigates a JSON document by keys/indices (test helper, throws on a wrong shape). */
const at = (document: JsonObject, ...path: ReadonlyArray<string | number>): JsonObject => {
  let node: unknown = document;

  for (const segment of path) node = (node as Record<string | number, unknown>)[segment];

  // SAFETY: tests address objects they built.
  return node as JsonObject;
};

const restoredOk = (document: JsonObject) => {
  const result = restoreSecrets(document, stored());

  if (!result.ok) throw new Error(`${result.problem.error} at ${result.problem.path}`);

  return result;
};

const refused = (document: JsonObject) => {
  const result = restoreSecrets(document, stored());

  if (result.ok) throw new Error("expected a refusal");

  return result.problem;
};

/** The edit restored with tags and reviewed, as `readRawEdit` does (without the decode). */
const reviewed = (document: JsonObject) => {
  const tags = secretTags("t0123abcd");
  const tagged = restoreSecrets(document, stored(), tags.standIn);

  if (!tagged.ok) throw new Error(`${tagged.problem.error} at ${tagged.problem.path}`);

  return reviewResult(tagged.document, stored(), tags);
};

describe("config secrets", () => {
  it("finds every secret position, in document order", () => {
    const slots = secretSlots(stored());

    expect(slots.map((slot) => [slot.path, slot.kind])).toEqual([
      ["models.catalog", "query"],
      ["access.api-keys[0]", "value"],
      ["access.api-keys[1]", "value"],
      ["requests.proxy-url", "userinfo"],
      ["requests.payload.default[0].models[0].headers.Authorization", "value"],
      ["api-keys.gemini[0].keys[0].api-key", "value"],
      ["api-keys.interactions[0].keys[0].api-key", "value"],
      ["api-keys.vertex[0].keys[0].api-key", "value"],
      ["api-keys.codex[0].keys[0].api-key", "value"],
      ["api-keys.claude[0].base-url", "userinfo"],
      ["api-keys.claude[0].proxy-url", "userinfo"],
      ["api-keys.claude[0].headers.Authorization", "value"],
      ["api-keys.claude[0].keys[0].api-key", "value"],
      ["api-keys.claude[0].keys[0].headers.Cookie", "value"],
      ["api-keys.claude[0].keys[1].api-key", "value"],
      ["api-keys.claude[0].keys[1].proxy-url", "userinfo"],
      ["api-keys.xai[0].keys[0].api-key", "value"],
      ["api-keys.meta[0].keys[0].api-key", "value"],
      ["api-keys.openai-compatibility[0].headers.X-Api-Key", "value"],
      ["api-keys.openai-compatibility[0].keys[0].api-key", "value"],
    ]);
    expect(slots.map((slot) => slot.value)).toContain(S.proxyUser);
    expect(slots.map((slot) => slot.value)).toContain(S.catalogToken);
  });

  it("masks every secret and nothing else", () => {
    const { document, secrets } = masked();
    const text = JSON.stringify(document);

    for (const secret of Object.values(S)) expect(text).not.toContain(secret);

    for (const fragment of ["proxy-pass", "gp-pass", "kp-pass", "base-pass", "catalog-token"])
      expect(text).not.toContain(fragment);
    expect(secrets).toBe(20);
    expect(text.match(/\[redacted#\d+\]/g)).toHaveLength(20);

    // Tails for long whole values only; URL parts never carry one.
    expect(at(document, "api-keys", "gemini", 0, "keys", 0)["api-key"]).toBe("[redacted#6]…0001");
    expect(at(document, "access")["api-keys"]).toEqual(["[redacted#2]…0013", "[redacted#3]"]);
    expect(at(document, "requests")["proxy-url"]).toBe("http://[redacted#4]@proxy.test:8080");
    expect(at(document, "models").catalog).toBe(
      "https://cdn.test/models.json?v=2&token=[redacted#1]",
    );
    expect(at(document, "api-keys", "claude", 0)["base-url"]).toBe(
      "https://[redacted#10]@api.anthropic.test",
    );

    // `$Header` copies and the known plain headers stay as they are.
    expect(at(document, "api-keys", "claude", 0).headers).toEqual({
      Authorization: "[redacted#12]…0010",
      "X-Copy": "$Authorization",
      "User-Agent": "visible",
    });
    expect(at(document, "api-keys", "claude", 0, "keys", 0).headers).toEqual({
      Cookie: "[redacted#14]…0011",
      "x-api-key": "$x-api-key",
    });
    expect(at(document, "requests", "payload", "default", 0, "models", 0).headers).toEqual({
      Authorization: "[redacted#5]…019*",
      "Anthropic-Beta": "red",
    });
  });

  it("restores an unchanged masked document to the stored one", () => {
    const result = restoredOk(edited());

    expect(result.document).toEqual(stored());
    expect(result.restored.map((secret) => secret.index)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it("resolves secrets by index when groups are reordered or moved to another family", () => {
    const result = restoredOk(
      edited((document) => {
        const apiKeys = at(document, "api-keys");
        const claude = at(document, "api-keys", "claude", 0);
        // Move the claude group to codex (before the codex group) and swap its keys.
        const keys = (claude.keys as JsonObject[]).toReversed();

        apiKeys.codex = [{ ...claude, keys }, ...(apiKeys.codex as JsonObject[])];
        apiKeys.claude = [];
      }),
    );

    const codex = at(result.document, "api-keys", "codex", 0);

    expect((codex.keys as JsonObject[]).map((key) => key["api-key"])).toEqual([
      S.claude2,
      S.claude,
    ]);
    expect(codex.headers).toEqual(at(stored(), "api-keys", "claude", 0).headers);
    expect(codex["proxy-url"]).toBe(`socks5://${S.groupProxyUser}@proxy.test:1080`);
    expect(at(result.document, "api-keys", "codex", 1, "keys", 0)["api-key"]).toBe(S.codex);
  });

  it("restores the same placeholder twice as the same secret", () => {
    const result = restoredOk(
      edited((document) => {
        at(document, "api-keys").gemini = [
          { keys: [{ "api-key": "[redacted#6]…0001" }, { "api-key": "[redacted#6]" }] },
        ];
      }),
    );

    expect(at(result.document, "api-keys", "gemini", 0).keys).toEqual([
      { "api-key": S.gemini },
      { "api-key": S.gemini },
    ]);
  });

  it("keeps a placeholder whose tail was shortened or removed, refuses a corrupted prefix", () => {
    for (const value of ["[redacted#9]", "[redacted#9]…00", "[redacted#9]…"]) {
      const result = restoredOk(
        edited((document) => {
          at(document, "api-keys", "codex", 0, "keys", 0)["api-key"] = value;
        }),
      );

      expect(at(result.document, "api-keys", "codex", 0, "keys", 0)["api-key"]).toBe(S.codex);
    }

    for (const value of [
      "[redacted#9",
      "x[redacted#9]",
      "[redacted]…0004",
      "[redacted#9]extra",
      "[redacted#9]…0004-and-more",
      "[new secret]…0004",
      "[REDACTED#9]",
    ]) {
      const problem = refused(
        edited((document) => {
          at(document, "api-keys", "codex", 0, "keys", 0)["api-key"] = value;
        }),
      );

      expect(problem, value).toMatchObject({
        error: "invalid_secret_placeholder",
        path: "api-keys.codex[0].keys[0].api-key",
      });
    }
  });

  it("refuses a placeholder outside a secret position", () => {
    const cases: ReadonlyArray<readonly [(document: JsonObject) => void, string]> = [
      [
        (document) => {
          at(document, "api-keys", "claude", 0).name = "[redacted#13]…0005";
        },
        "api-keys.claude[0].name",
      ],
      [
        (document) => {
          const group = at(document, "api-keys", "claude", 0);
          // Renamed from Authorization to a plain header, so it would be shown unmasked.
          group.headers = { "User-Agent": "[redacted#12]…0010" };
        },
        "api-keys.claude[0].headers.User-Agent",
      ],
      [
        (document) => {
          // The normaliser trims header names: classified as stored, this is the plain User-Agent.
          at(document, "api-keys", "claude", 0).headers = { " user-agent ": "[redacted#12]" };
        },
        "api-keys.claude[0].headers. user-agent ",
      ],
      [
        (document) => {
          at(document, "requests").payload = {
            default: [{ params: { "metadata.user": "[redacted#13]" } }],
          };
        },
        "requests.payload.default[0].params.metadata.user",
      ],
      [
        (document) => {
          at(document, "api-keys", "claude", 0)["base-url"] = "https://host.test/[redacted#4]";
        },
        "api-keys.claude[0].base-url",
      ],
      [
        (document) => {
          // A query parameter whose name does not look secret.
          at(document, "models").catalog = "https://cdn.test/models.json?v=[redacted#1]";
        },
        "models.catalog",
      ],
      [
        (document) => {
          // A whole-value secret as URL user info.
          at(document, "requests")["proxy-url"] = "http://[redacted#13]@proxy.test";
        },
        "requests.proxy-url",
      ],
      [
        (document) => {
          // URL user info as an API key.
          at(document, "api-keys", "xai", 0, "keys", 0)["api-key"] = "[redacted#4]";
        },
        "api-keys.xai[0].keys[0].api-key",
      ],
    ];

    for (const [edit, path] of cases) {
      expect(refused(edited(edit)), path).toEqual({
        error: "masked_value_outside_secret_field",
        path,
        message: expect.any(String),
      });
    }
  });

  it("refuses a reference to a secret that does not exist", () => {
    for (const value of ["[redacted#0]", "[redacted#21]", "[redacted#999]…abcd"]) {
      expect(
        refused(
          edited((document) => {
            at(document, "access")["api-keys"] = [value];
          }),
        ),
      ).toMatchObject({ error: "unknown_secret_reference", path: "access.api-keys[0]" });
    }
  });

  it("takes plain text at a secret position as a new secret", () => {
    const result = restoredOk(
      edited((document) => {
        at(document, "api-keys", "xai", 0, "keys", 0)["api-key"] = "xai-NEW-SECRET-9999";
        at(document, "api-keys", "claude", 0, "keys", 0).headers = { Cookie: "new-cookie" };
      }),
    );

    expect(at(result.document, "api-keys", "xai", 0, "keys", 0)["api-key"]).toBe(
      "xai-NEW-SECRET-9999",
    );
    expect(result.restored.map((secret) => secret.index)).not.toContain(17);
  });

  it("masks the review: kept secrets keep their index, new ones are never echoed", () => {
    const review = reviewed(
      edited((document) => {
        at(document, "api-keys", "xai", 0, "keys", 0)["api-key"] = "xai-NEW-SECRET-9999";
        at(document, "access")["api-keys"] = ["tiny", "[redacted#2]…0013"];
        at(document, "requests")["proxy-url"] = "http://new-user:new-pass@proxy.test";
      }),
    );

    const text = JSON.stringify(review.document);

    for (const secret of [...Object.values(S), "xai-NEW-SECRET", "new-pass", "tiny", "t0123abcd"])
      expect(text).not.toContain(secret);
    expect(at(review.document, "api-keys", "xai", 0, "keys", 0)["api-key"]).toBe(
      "[new secret]…9999",
    );
    expect(at(review.document, "access")["api-keys"]).toEqual([
      "[new secret]",
      "[redacted#2]…0013",
    ]);
    expect(at(review.document, "requests")["proxy-url"]).toBe("http://[new secret]@proxy.test");
    expect(at(review.document, "api-keys", "codex", 0, "keys", 0)["api-key"]).toBe(
      "[redacted#9]…0004",
    );
    expect(review.fresh).toBe(3);
    expect(review.kept).toBe(17);
    expect(review.moved).toEqual([]);
  });

  it("tells kept from new by origin: a typed copy of a stored secret is new (no guessing oracle)", () => {
    const guess = (value: string) =>
      reviewed(
        edited((document) => {
          const keys = at(document, "api-keys", "codex", 0).keys as JsonObject[];

          keys.push({ "api-key": value });
        }),
      );

    const right = guess(S.codex);
    const wrong = guess(`X${S.codex.slice(1)}`);

    expect(right).toEqual(wrong);
    expect(at(right.document, "api-keys", "codex", 0).keys).toEqual([
      { "api-key": "[redacted#9]…0004" },
      { "api-key": "[new secret]…0004" },
    ]);
    expect([right.kept, right.fresh]).toEqual([20, 1]);
  });

  it("lists kept secrets now sent to another family or upstream host", () => {
    const review = reviewed(
      edited((document) => {
        const apiKeys = at(document, "api-keys");
        const codexKey = "[redacted#9]";

        apiKeys.codex = [
          // Same base URL (trailing slash and host case aside): not moved.
          { "base-url": "https://CODEX.test/", keys: [{ "api-key": codexKey }] },
          // Same host, another path (a shared gateway serves many accounts).
          { "base-url": "https://codex.test/v1/other-account", keys: [{ "api-key": codexKey }] },
          // Another host.
          { "base-url": "https://evil.test", keys: [{ "api-key": codexKey }] },
          // A key-level base-url wins over the group's.
          {
            "base-url": "https://codex.test",
            keys: [{ "api-key": codexKey, "base-url": "https://evil.test" }],
          },
        ];
        // Another family, same (default) upstream setting.
        at(document, "api-keys", "xai", 0).keys = [{ "api-key": "[redacted#18]" }];
        // URL user info to another proxy host; a header to a group with another host.
        at(document, "requests")["proxy-url"] = "http://[redacted#4]@evil.test:8080";
        at(document, "api-keys", "openai-compatibility", 0)["base-url"] = "https://evil.test/v1";
      }),
    );

    expect(review.moved.map(({ path }) => path)).toEqual([
      "requests.proxy-url",
      "api-keys.codex[1].keys[0].api-key",
      "api-keys.codex[2].keys[0].api-key",
      "api-keys.codex[3].keys[0].api-key",
      "api-keys.xai[0].keys[0].api-key",
      "api-keys.openai-compatibility[0].headers.X-Api-Key",
      "api-keys.openai-compatibility[0].keys[0].api-key",
    ]);
    // Each says which secret (its placeholder) and where it goes: family and host, nothing else of the URL.
    expect(review.moved[0]).toEqual({
      path: "requests.proxy-url",
      placeholder: "[redacted#4]",
      from: { family: "requests.proxy-url", host: "proxy.test:8080" },
      to: { family: "requests.proxy-url", host: "evil.test:8080" },
    });
    expect(review.moved[1]).toEqual({
      path: "api-keys.codex[1].keys[0].api-key",
      placeholder: "[redacted#9]…0004",
      from: { family: "codex", host: "codex.test" },
      to: { family: "codex", host: "codex.test" },
    });
    expect(review.moved[2]?.to).toEqual({ family: "codex", host: "evil.test" });
    expect(review.moved[4]?.to).toEqual({ family: "xai", host: "xai.test" });
    expect(review.moved[4]?.from.family).not.toBe("xai");
    expect(review.moved[6]).toMatchObject({
      from: { family: "openai-compatibility", host: "compat.test" },
      to: { family: "openai-compatibility", host: "evil.test" },
    });
    const listed = JSON.stringify(review.moved);

    for (const secret of Object.values(S)) expect(listed).not.toContain(secret);
  });

  it("classifies header names as stored: trimmed, no auth-file exemptions", () => {
    const document: JsonObject = {
      "api-keys": {
        claude: [
          {
            headers: {
              token_type: "tt-SECRET-0001",
              "X-Custom": "custom-SECRET-0002",
              Accept: "*/*",
            },
            keys: [{ "api-key": "sk-ant-SECRET-0003" }],
          },
        ],
      },
    };

    const { document: out, secrets } = maskDocument(document);

    expect(secrets).toBe(3);
    expect(at(out, "api-keys", "claude", 0).headers).toEqual({
      token_type: "[redacted#1]…0001",
      "X-Custom": "[redacted#2]…0002",
      Accept: "*/*",
    });

    // The exploit: a placeholder under a padded exempt name restores and stays masked once trimmed.
    at(out, "api-keys", "claude", 0).headers = { " token_type": "[redacted#3]" };
    const back = restoreSecrets(out, document);

    expect(back.ok).toBe(true);

    if (!back.ok) return;

    const trimmed: JsonObject = {
      "api-keys": { claude: [{ headers: { token_type: "sk-ant-SECRET-0003" }, keys: [] }] },
    };

    expect(JSON.stringify(maskDocument(trimmed).document)).not.toContain("SECRET");
  });

  it("refuses a stored secret starting with $ in a header (it would read as a copy)", () => {
    const document: JsonObject = {
      access: { "api-keys": ["$ecret-client-key-0001"] },
      "api-keys": { claude: [{ headers: { Authorization: "Bearer x-SECRET" }, keys: [] }] },
    };

    const { document: out } = maskDocument(document);

    at(out, "api-keys", "claude", 0).headers = { Authorization: "[redacted#1]…0001" };

    expect(restoreSecrets(out, document)).toMatchObject({
      ok: false,
      problem: {
        error: "masked_value_outside_secret_field",
        path: "api-keys.claude[0].headers.Authorization",
      },
    });
  });

  it("masks secret-looking URL parameters, in the query and the fragment", () => {
    const urls = [
      ["https://h.test/?password=pw-1&x=1", "https://h.test/?password=[redacted#1]&x=1"],
      ["https://h.test/?session=s-2", "https://h.test/?session=[redacted#2]"],
      [
        "https://h.test/#access_token=at-3&state=x",
        "https://h.test/#access_token=[redacted#3]&state=x",
      ],
      ["https://h.test/?pwd=p-4#cred=c-5", "https://h.test/?pwd=[redacted#4]#cred=[redacted#5]"],
    ] as const;

    const document: JsonObject = {
      "api-keys": {
        "openai-compatibility": urls.map(([url]) => ({ "base-url": url, keys: [] })),
      },
    };

    const { document: out, secrets } = maskDocument(document);

    expect(secrets).toBe(5);
    expect(
      (at(out, "api-keys")["openai-compatibility"] as JsonObject[]).map(
        (group) => group["base-url"],
      ),
    ).toEqual(urls.map(([, expected]) => expected));
    expect(restoreSecrets(out, document)).toMatchObject({ ok: true, document });
  });

  it("masks payload parameters whose path looks secret, and restores them", () => {
    const document: JsonObject = {
      requests: {
        payload: {
          override: [
            {
              params: {
                "metadata.api_key": "pk-SECRET-0001",
                auth: { token: "nested-SECRET-0002", region: "eu" },
                temperature: 0,
                "metadata.user": "visible",
              },
            },
          ],
          filter: [{ params: ["metadata.api_key"] }],
        },
      },
    };

    const { document: out, secrets } = maskDocument(document);

    // Everything under a secret-looking parameter is masked (`auth.region` too).
    expect(secrets).toBe(3);
    expect(at(out, "requests", "payload", "override", 0).params).toEqual({
      "metadata.api_key": "[redacted#1]…0001",
      auth: { token: "[redacted#2]…0002", region: "[redacted#3]" },
      temperature: 0,
      "metadata.user": "visible",
    });
    expect(at(out, "requests", "payload", "filter", 0).params).toEqual(["metadata.api_key"]);
    expect(restoreSecrets(out, document)).toMatchObject({ ok: true, document });
  });

  it("finds a stand-in that masking would show (fail-safe), whatever the secret's value", () => {
    const tags = secretTags("t0123abcd");
    const tagged = restoreSecrets(edited(), stored(), tags.standIn);

    if (!tagged.ok) throw new Error(tagged.problem.error);
    expect(exposedTagPath(tagged.document, tags)).toBeUndefined();

    const leaked = structuredClone(tagged.document);

    at(leaked, "api-keys", "claude", 0).name = tags.standIn(9, {
      path: "",
      kind: "value",
      value: S.codex,
    });
    expect(exposedTagPath(leaked, tags)).toBe("api-keys.claude[0].name");
  });

  it("keeps a stand-in JSON when the secret is JSON, and keeps a dca: prefix", () => {
    const tags = secretTags("t0123abcd");
    const slot = (value: string) => ({ path: "", kind: "value", value }) as const;

    expect(tags.standIn(1, slot('{"key":"raw-SECRET"}'))).toBe('"t0123abcdk1k"');
    expect(tags.standIn(2, slot("12345"))).toBe('"t0123abcdk2k"');
    expect(tags.standIn(3, slot("dca:meta-SECRET"))).toBe("dca:t0123abcdk3k");
    expect(tags.standIn(4, slot("sk-plain-SECRET"))).toBe("t0123abcdk4k");
    expect(tags.standIn(5, { path: "", kind: "userinfo", value: "1234" })).toBe("t0123abcdk5k");
    expect(['"t0123abcdk1k"', "dca:t0123abcdk3k", "t0123abcdk4k"].map(tags.indexOf)).toEqual([
      1, 3, 4,
    ]);
    expect(tags.indexOf("t0123abcdk4kx")).toBeUndefined();
  });

  it("masks URL credentials that do not parse as URLs, and restores them stably", () => {
    const document: JsonObject = {
      requests: { "proxy-url": "https://user:pa/ss@proxy.test" },
      "api-keys": {
        claude: [
          {
            "base-url": "user:p?ss@host.test:8080",
            keys: [{ "api-key": "k", "proxy-url": "http://proxy.test/path?sig=abc&x=1#frag" }],
          },
        ],
      },
    };

    const { document: out, secrets } = maskDocument(document);
    const text = JSON.stringify(out);

    expect(text).not.toContain("pa/ss");
    expect(text).not.toContain("p?ss");
    expect(text).not.toContain("abc");
    expect(secrets).toBe(4);
    expect(at(out, "requests")["proxy-url"]).toBe("https://[redacted#1]@proxy.test");

    const back = restoreSecrets(out, document);

    expect(back.ok && back.document).toEqual(document);
  });

  it("refuses a URL edit that would leave a restored secret outside the masked part", () => {
    const document: JsonObject = { requests: { "proxy-url": "http://user:pa/ss@proxy.test" } };
    const { document: out } = maskDocument(document);

    // A slash after the placeholder: the restored user info would end the authority early and show.
    at(out, "requests")["proxy-url"] = "http://[redacted#1]/x@proxy.test";

    const result = restoreSecrets(out, document);

    expect(result.ok).toBe(false);
  });

  it("checks URL stability on the value as stored (trimmed), not only as written", () => {
    const document: JsonObject = {
      requests: { "proxy-url": "  https://u:12/ss@host.test" },
      "api-keys": { claude: [{ "base-url": "https://api.test", keys: [{ "api-key": "k" }] }] },
    };

    const { document: out } = maskDocument(document);

    expect(at(out, "requests")["proxy-url"]).toBe("[redacted#1]@host.test");
    // Unchanged in its own field: stored as is, so accepted.
    expect(restoreSecrets(out, document)).toMatchObject({ ok: true, document });

    // In a group base-url it would be trimmed to `https://u:12/ss@host.test`, a URL without user info.
    at(out, "api-keys", "claude", 0)["base-url"] = "[redacted#1]@host.test";
    expect(restoreSecrets(out, document)).toMatchObject({
      ok: false,
      problem: { error: "invalid_secret_placeholder", path: "api-keys.claude[0].base-url" },
    });
  });

  it("treats empty values as no secret", () => {
    expect(
      secretSlots({
        access: { "api-keys": [""] },
        requests: { "proxy-url": "" },
        "api-keys": { gemini: [{ "base-url": "https://g.test", keys: [{ "api-key": "" }] }] },
      }),
    ).toEqual([]);
  });
});
