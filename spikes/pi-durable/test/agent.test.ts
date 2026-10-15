import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentDO } from "../src/worker.ts";

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
const chunk = (delta: object, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const toolCall = (id: string, command: string) =>
  sse([
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command }) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);
const text = (t: string) => sse([chunk({ role: "assistant", content: t }), chunk({}, "stop")]);

const seen: Array<{ url: string; auth: string | null; model: string; tools: number }> = [];
const script = ["echo hello > a.txt && cat a.txt", "npm run build # heavy"];
afterEach(() => vi.restoreAllMocks());

it("answers through the proxy, runs one command per environment, resumes after eviction", async () => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith("https://proxy.test/")) return realFetch(input as RequestInfo, init);
    const body = (await req.json()) as {
      model: string;
      messages: Array<{ role: string }>;
      tools?: unknown[];
    };
    seen.push({
      url: req.url,
      auth: req.headers.get("authorization"),
      model: body.model,
      tools: body.tools?.length ?? 0,
    });
    const done = body.messages.filter((m) => m.role === "tool").length;
    return done < script.length ? toolCall(`call_${done}`, script[done]!) : text("Built it.");
  });

  const stub = env.AGENT.getByName("agent-1");
  const started = Date.now();
  const r = await stub.ask("create a file then build", "req-1");
  console.log("run took ms:", Date.now() - started, JSON.stringify(r));
  expect(r.status).toBe("done");
  expect(r.text).toBe("Built it.");
  expect(r.routed.map((x) => x.where)).toEqual(["virtual", "heavy"]);
  expect(seen[0]!.auth).toBe("Bearer cfp_demo_key_secret");
  expect(seen[0]!.url).toBe("https://proxy.test/v1/chat/completions");
  console.log("history:", JSON.stringify(await stub.history()));
  expect(await stub.file("/work/a.txt")).toBe("hello\n");
  expect(await stub.file("/work/built.txt")).toBe("built in container\n");

  // Evict: abort every Durable Object instance (constructor runs again on the next call).
  const before = await stub.history();
  await abortAllDurableObjects();
  const again = env.AGENT.getByName("agent-1");
  expect(await again.history()).toEqual(before);
  expect(await again.file("/work/a.txt")).toBe("hello\n"); // files rehydrated from DO SQLite
  // Same requestId after the restart finds the submission instead of re-running the model.
  const calls = seen.length;
  const r2 = await again.ask("create a file then build", "req-1");
  console.log("after eviction:", JSON.stringify(r2), "extra model calls:", seen.length - calls);
}, 60_000);
