// An ExecutionEnv that routes between a virtual shell + files held in Durable Object SQLite (just-bash) and a heavy
// environment (a container; stubbed here). Only the methods the built-in read/write/edit/bash tools call are real;
// the rest answer `not_supported` (a production env implements the whole FileSystem interface, or wraps one).
import type { ExecutionEnv, FileInfo, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { Bash, InMemoryFs } from "just-bash/browser";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: Error & { code: string } };
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const fail = (code: string, message: string, path?: string): Err => ({
  ok: false,
  error: Object.assign(new Error(message), { code, path, name: "FileError" }),
});

/** What the heavy side must offer: run argv/string commands against a workspace, return changed files. */
export interface HeavyEnv {
  readonly id: string;
  run(
    command: string,
    files: Record<string, string>,
  ): Promise<{ exitCode: number; output: string; files: Record<string, string> }>;
}

/** Commands the virtual shell cannot (or should not) run: processes, toolchains, long jobs. */
const HEAVY =
  /^\s*(npm|pnpm|yarn|node|bun|deno|python3?|pip|cargo|rustc|go|make|cmake|gcc|git|docker)\b|#\s*heavy\b/;

export class RouterEnv {
  readonly id: string;
  cwd: string;
  readonly routed: Array<{ command: string; where: "virtual" | "heavy" }> = [];
  readonly #fs = new InMemoryFs();
  readonly #sql: SqlStorage;
  readonly #heavy: HeavyEnv;

  constructor(opts: { id: string; cwd: string; sql: SqlStorage; heavy: HeavyEnv }) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.#sql = opts.sql;
    this.#heavy = opts.heavy;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS env_files (path TEXT PRIMARY KEY, content TEXT NOT NULL)",
    );
  }

  /** Rehydrate the in-memory tree from SQLite (after eviction the DO constructor runs again). */
  async load(): Promise<this> {
    await this.#fs.mkdir(this.cwd, { recursive: true });
    for (const row of this.#sql.exec("SELECT path, content FROM env_files").toArray()) {
      await this.#fs.writeFile(String(row.path), String(row.content));
    }
    return this;
  }

  async #persist(path: string, content: string) {
    this.#sql.exec(
      "INSERT INTO env_files (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content",
      path,
      content,
    );
  }
  async #snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of this.#fs.getAllPaths()) {
      try {
        out[p] = await this.#fs.readFile(p);
      } catch {
        /* directories */
      }
    }
    return out;
  }
  #abs(path: string) {
    return path.startsWith("/") ? path : `${this.cwd.replace(/\/$/, "")}/${path}`;
  }

  // ---- FileSystem subset ----
  async absolutePath(path: string) {
    return ok(this.#abs(path));
  }
  async canonicalPath(path: string) {
    return ok(this.#abs(path));
  }
  async joinPath(parts: string[]) {
    return ok(parts.join("/").replace(/\/+/g, "/"));
  }
  async exists(path: string) {
    return ok(await this.#fs.exists(this.#abs(path)));
  }
  async readTextFile(path: string) {
    try {
      return ok(await this.#fs.readFile(this.#abs(path)));
    } catch {
      return fail("not_found", "no such file", path);
    }
  }
  async fileInfo(path: string) {
    try {
      const st = await this.#fs.stat(this.#abs(path));
      const info: FileInfo = {
        name: path.split("/").pop() ?? path,
        path: this.#abs(path),
        kind: st.isDirectory ? "directory" : "file",
        size: st.size,
        mtimeMs: Number(st.mtime),
      };
      return ok(info);
    } catch {
      return fail("not_found", "no such file", path);
    }
  }
  async openBinaryReader(path: string) {
    let bytes: Uint8Array;
    try {
      bytes = await this.#fs.readFileBuffer(this.#abs(path));
    } catch {
      return fail("not_found", "no such file", path);
    }
    const text = new TextDecoder().decode(bytes);
    const info = {
      name: path,
      path: this.#abs(path),
      kind: "file" as const,
      size: bytes.length,
      mtimeMs: 0,
    };
    return ok({
      info: async () => ok(info),
      read: async (offset: number, length: number) => ok(bytes.slice(offset, offset + length)),
      scanLines: async ({ startLine, endLine }: { startLine: number; endLine?: number }) => {
        const lines = text.split("\n");
        const enc = new TextEncoder();
        const sel = lines.slice(startLine, endLine);
        const before = enc.encode(
          lines
            .slice(0, startLine)
            .map((l) => l + "\n")
            .join(""),
        ).length;
        const selected = enc.encode(sel.join("\n")).length;
        return ok({
          newlines: lines.length - 1,
          start: before,
          end: before + selected,
          firstLineEnd: before + enc.encode(sel[0] ?? "").length,
          lastLineStart:
            before +
            enc.encode(
              sel
                .slice(0, -1)
                .map((l) => l + "\n")
                .join(""),
            ).length,
          selectedBytes: selected,
          firstLineBytes: enc.encode(sel[0] ?? "").length,
        });
      },
      close: async () => {},
    });
  }
  async writeFile(path: string, content: string | Uint8Array) {
    const abs = this.#abs(path);
    const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
    await this.#fs.mkdir(dir, { recursive: true });
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    await this.#fs.writeFile(abs, text);
    await this.#persist(abs, text);
    return ok(undefined);
  }

  // ---- Shell: the router ----
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: unknown,
  ) {
    const cmd =
      typeof command === "string" ? command : command.map((a) => JSON.stringify(a)).join(" ");
    if (HEAVY.test(cmd)) {
      this.routed.push({ command: cmd, where: "heavy" });
      const files = await this.#snapshot();
      const res = await this.#heavy.run(cmd, files);
      for (const [p, c] of Object.entries(res.files)) {
        if (files[p] !== c) {
          await this.#fs.writeFile(p, c);
          await this.#persist(p, c);
        }
      }
      options?.onOutput?.(res.output, context as never, { stream: "stdout" });
      return ok({ exitCode: res.exitCode });
    }
    this.routed.push({ command: cmd, where: "virtual" });
    const bash = new Bash({ fs: this.#fs, cwd: options?.cwd ?? this.cwd });
    const r = await bash.exec(cmd);
    if (r.stdout) options?.onOutput?.(r.stdout, context as never, { stream: "stdout" });
    if (r.stderr) options?.onOutput?.(r.stderr, context as never, { stream: "stderr" });
    for (const [p, c] of Object.entries(await this.#snapshot())) await this.#persist(p, c); // write-through (spike: full scan)
    return ok({ exitCode: r.exitCode });
  }
  async cleanup() {}
}

/** Anything else on FileSystem answers not_supported instead of crashing. */
export function asExecutionEnv(env: RouterEnv): ExecutionEnv {
  return new Proxy(env, {
    get(target, prop) {
      if (prop in target) {
        const v = Reflect.get(target, prop, target); // target as receiver: methods use #private fields
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (typeof prop === "string" && prop !== "then" && prop !== "listFiles")
        return async () => fail("not_supported", `${prop} not supported`);
      return undefined;
    },
  }) as unknown as ExecutionEnv;
}
