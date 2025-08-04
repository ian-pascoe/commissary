import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { JSONRPCMessage, MCPTransport } from "ai";
import type { LocalMcpConfig } from "~/schemas/config/mcp";

export class TauriMcpTransport implements MCPTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  unlistenFn: UnlistenFn | null = null;

  constructor(
    readonly id: string,
    readonly config: LocalMcpConfig,
  ) {}

  async start(): Promise<void> {
    await invoke("start_mcp_server", {
      serverId: this.id,
      command: this.config.command,
      environment: this.config.environment ?? {},
    });
    this.unlistenFn = await listen<string>(`mcp-stdout-${this.id}`, (event) => {
      this.onmessage?.(JSON.parse(event.payload));
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    await invoke("send_to_mcp_server", {
      serverId: this.id,
      message: JSON.stringify(message),
    });
  }

  async close(): Promise<void> {
    await invoke("stop_mcp_server", { serverId: this.id });
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
  }
}
