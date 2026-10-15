import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { asExecutionEnv, type HeavyEnv, RouterEnv } from "./router-env.ts";

export interface Env {
  AGENT: DurableObjectNamespace<AgentDO>;
  PROXY_URL: string;
  PROXY_KEY: string;
}

/** Stand-in for a container: a real one is `ctx.container.exec` / the Sandbox SDK (needs Docker; not exercised). */
export const heavyCalls: string[] = [];
const fakeContainer: HeavyEnv = {
  id: "container:fake",
  async run(command, files) {
    heavyCalls.push(command);
    return {
      exitCode: 0,
      output: `[container] ran: ${command} (${Object.keys(files).length} files synced in)\n`,
      files: { ...files, "/work/built.txt": "built in container\n" },
    };
  },
};

export class AgentDO extends DurableObject<Env> {
  #harness?: Promise<{ harness: Harness; env: RouterEnv }>;

  #open() {
    return (this.#harness ??= (async () => {
      const env = await new RouterEnv({
        id: "do:" + this.ctx.id.toString(),
        cwd: "/work",
        sql: this.ctx.storage.sql,
        heavy: fakeContainer,
      }).load();
      // The agent reaches Commissary's own models over the proxy's OpenAI-compatible route with a proxy key.
      const model: Model<"openai-completions"> = {
        id: "test-model",
        name: "test",
        api: "openai-completions",
        provider: "commissary",
        baseUrl: this.env.PROXY_URL + "/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };
      const models = createModels();
      models.setProvider(
        createProvider({
          id: "commissary",
          name: "Commissary",
          baseUrl: this.env.PROXY_URL + "/v1",
          auth: {
            apiKey: {
              name: "Commissary proxy key",
              resolve: async () => ({ auth: { apiKey: this.env.PROXY_KEY } }),
            },
          },
          models: [model],
          api: openAICompletionsApi(),
        }),
      );
      const registry = createRegistry();
      registry.install(CodingTools);
      const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
      const harness = await Harness.open(
        storage,
        { models, registry, env: () => asExecutionEnv(env) },
        BACKGROUND_CONTEXT,
      );
      harness.resume(); // continue any run the evicted instance left unfinished
      return { harness, env };
    })());
  }

  async ask(content: string, requestId: string) {
    const { harness, env } = await this.#open();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "commissary", modelId: "test-model" }, cwd: "/work" },
    });
    const sub = await root.submit({ type: "input", content, requestId }, BACKGROUND_CONTEXT);
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    let text = "";
    if (settled.status === "done" && settled.type === "input") {
      const e = await root.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        BACKGROUND_CONTEXT,
      );
      const m = e?.model?.[0];
      if (m?.role === "assistant")
        text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    }
    return { status: settled.status, text, routed: env.routed };
  }

  /** Entries of the root conversation, to prove history survives a restart. */
  async history() {
    const { harness } = await this.#open();
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    return page.items
      .map((e) => {
        const m = e.model?.[0];
        const t =
          m && m.role === "toolResult"
            ? ":" +
              m.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("")
                .trim()
            : "";
        return e.kind + t;
      })
      .reverse();
  }
  async file(path: string) {
    const { env } = await this.#open();
    const r = await env.readTextFile(path);
    return r.ok ? r.value : null;
  }
}

export default { fetch: () => new Response("spike") } satisfies ExportedHandler<Env>;
