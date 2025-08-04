import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { JSONRPCMessage, MCPTransport } from "ai";
import type { LocalMcpConfig } from "~/schemas/config/mcp";

export class TauriMcpTransport implements MCPTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  unlistenStdoutFn: UnlistenFn | null = null;
  unlistenStderrFn: UnlistenFn | null = null;

  constructor(
    readonly id: string,
    readonly config: LocalMcpConfig,
  ) {}

  async start(): Promise<void> {
    await invoke("start_mcp_server", {
      serverId: this.id,
      command: this.config.command,
      environment: this.config.environment,
      cwd: this.config.cwd,
    });
    this.unlistenStdoutFn = await listen<string>(
      `mcp-stdout-${this.id}`,
      (event) => {
        this.onmessage?.(JSON.parse(event.payload));
      },
    );
    this.unlistenStderrFn = await listen<string>(
      `mcp-stderr-${this.id}`,
      (event) => {
        this.onerror?.(new Error(event.payload));
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await invoke("send_to_mcp_server", {
      serverId: this.id,
      message: JSON.stringify(message),
    });
  }

  async close(): Promise<void> {
    this.onclose?.();
    await invoke("stop_mcp_server", { serverId: this.id });
    if (this.unlistenStdoutFn) {
      this.unlistenStdoutFn();
      this.unlistenStdoutFn = null;
    }
    if (this.unlistenStderrFn) {
      this.unlistenStderrFn();
      this.unlistenStderrFn = null;
    }
  }
}
