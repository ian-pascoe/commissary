import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
const chunk = (delta: object, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// The Durable Object is killed while the SECOND model call is in flight (after the first tool ran); a new instance
// must continue the run from the stored checkpoint, not start over.
it("resumes an interrupted run after the Durable Object is evicted mid-turn", async () => {
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  let hangSecond = true;
  let release!: () => void;
  const hung = new Promise<void>((r) => (release = r));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith("https://proxy.test/")) return realFetch(input as RequestInfo, init);
    const body = (await req.json()) as { messages: Array<{ role: string }> };
    modelCalls++;
    const tools = body.messages.filter((m) => m.role === "tool").length;
    if (tools === 0)
      return sse([
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "t0",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "echo one > one.txt" }),
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ]);
    if (hangSecond) {
      hangSecond = false;
      await hung;
      return new Response("evicted", { status: 500 });
    }
    return sse([chunk({ role: "assistant", content: "done after resume" }), chunk({}, "stop")]);
  });

  const stub = env.AGENT.getByName("agent-2");
  const first = stub.ask("go", "req-mid").catch((e: unknown) => ({ rejected: String(e) }));
  await vi.waitFor(() => expect(modelCalls).toBe(2), { timeout: 20_000 });
  await abortAllDurableObjects();
  release();
  console.log("first call result:", JSON.stringify(await first));

  const again = env.AGENT.getByName("agent-2");
  const r = await again.ask("go", "req-mid"); // same requestId: reattaches to the stored submission
  console.log("resumed:", JSON.stringify(r), "model calls total:", modelCalls);
  console.log("history:", JSON.stringify(await again.history()));
  expect(r.status).toBe("done");
  expect(r.text).toBe("done after resume");
  expect(await again.file("/work/one.txt")).toBe("one\n");
}, 60_000);
