// `api-keys.opencode-zen` / `api-keys.opencode-go`: parser, encoded document round trip, credential synthesis and the
// management `/config` paths.
import { Effect, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decodeConfig, encodeConfig, parseConfigYaml } from "../src/config/codec.ts";
import { Config } from "../src/config/schema.ts";
import type { ProviderKeysList } from "../src/management/contract/provider-keys.ts";
import { jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const YAML = `api-keys:
  opencode-zen:
    - prefix: zen
      priority: 2
      headers:
        X-Team: core
      excluded-models: ["*-mini"]
      models:
        - name: gpt-5
          alias: zen-gpt
          protocol: chat
      keys:
        - api-key: zen-key
        - api-key: zen-key-2
          models:
            - name: claude-haiku-4-5
              protocol: messages
    - base-url: https://zen.example/v1
      keys:
        - api-key: zen-key-3
  opencode-go:
    - keys:
        - api-key: go-key
`;

const parse = (text: string) => Effect.runPromise(parseConfigYaml(text));

describe("config sections", () => {
  it("parses both sections with per-model protocols", async () => {
    const config = await parse(YAML);
    const zen = config["api-keys"]["opencode-zen"][0];
    expect(zen).toMatchObject({ prefix: "zen", priority: 2, headers: { "X-Team": "core" } });
    expect(zen?.models).toEqual([{ name: "gpt-5", alias: "zen-gpt", protocol: "chat" }]);
    expect(zen?.keys[1]).toMatchObject({
      "api-key": "zen-key-2",
      models: [{ name: "claude-haiku-4-5", protocol: "messages" }],
    });
    expect(config["api-keys"]["opencode-zen"][1]?.["base-url"]).toBe("https://zen.example/v1");
    expect(config["api-keys"]["opencode-go"][0]?.keys[0]?.["api-key"]).toBe("go-key");
  });

  it("round-trips through the encoded document", async () => {
    const config = await parse(YAML);
    const encoded = encodeConfig(config);
    expect(Schema.decodeUnknownSync(Config)(encoded)).toEqual(config);
    expect(await Effect.runPromise(decodeConfig(JSON.parse(JSON.stringify(encoded))))).toEqual(
      config,
    );
  });

  it("rejects an unknown protocol in the OpenCode sections, naming the path, and drops keys without a secret", async () => {
    await expect(
      parse(`api-keys:
  opencode-go:
    - keys: [{ api-key: k }]
      models: [{ name: m, protocol: websocket }]
`),
    ).rejects.toMatchObject({
      message:
        'Expected one of "chat", "responses", "messages", "gemini" at api-keys.opencode-go[0].models[0].protocol',
      path: "api-keys.opencode-go[0].models[0].protocol",
    });

    await expect(
      parse(`api-keys:
  opencode-zen:
    - keys:
        - api-key: k
          models: [{ name: m, protocol: Chat }]
`),
    ).rejects.toMatchObject({ path: "api-keys.opencode-zen[0].keys[0].models[0].protocol" });

    const config = await parse(`api-keys:
  opencode-go:
    - keys: [{ api-key: "" }]
`);

    expect(config["api-keys"]["opencode-go"]).toEqual([]);
  });
});

describe("protocol on other providers", () => {
  it("is ignored: any value parses and the normalised config drops it", async () => {
    const config = await parse(`api-keys:
  claude:
    - keys:
        - api-key: c
          models: [{ name: claude-x, protocol: carrier-pigeon }]
      models: [{ name: claude-y, protocol: "" }]
  openai-compatibility:
    - name: compat
      base-url: https://compat.test/v1
      keys: [{ api-key: k }]
      models: [{ name: gpt-z, protocol: messages }]
`);

    const claude = config["api-keys"].claude[0];
    expect(claude?.models).toEqual([{ name: "claude-y" }]);
    expect(claude?.keys[0]?.models).toEqual([{ name: "claude-x" }]);
    expect(config["api-keys"]["openai-compatibility"][0]?.models).toEqual([{ name: "gpt-z" }]);
  });
});

describe("management import and key groups", () => {
  const harness = makeHarness();

  afterAll(harness.dispose);

  beforeEach(resetControlPlane);

  const groups = async (family: "opencode-zen" | "opencode-go") =>
    ((await harness.json("/v9/management/provider-keys")).body as ProviderKeysList).families[
      family
    ];

  it("imports the sections from YAML and edits them as key groups", async () => {
    const stored = await harness.json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: YAML,
    });

    expect(stored.status).toBe(200);

    const [zen] = await groups("opencode-zen");

    expect(zen?.group.models).toEqual([{ name: "gpt-5", alias: "zen-gpt", protocol: "chat" }]);
    // Secrets are never served.
    expect(JSON.stringify(zen)).not.toContain("zen-key");

    const write = (protocol: string) =>
      harness.json(
        "/v9/management/provider-keys/groups",
        jsonInit("PUT", {
          family: "opencode-go",
          revision: 0,
          group: {
            keys: [{ "api-key": "go-key-new" }],
            models: [{ name: "minimax-m3", protocol }],
          },
        }),
      );

    expect((await write("messages")).status).toBe(200);
    const go = await groups("opencode-go");
    expect(go.at(-1)?.group).toMatchObject({
      models: [{ name: "minimax-m3", protocol: "messages" }],
    });

    expect((await write("carrier-pigeon")).status).toBe(422);
  });
});
