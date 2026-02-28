/**
 * GraphitiBackend — MemoryBackend implementation backed by the Graphiti MCP server.
 *
 * Graphiti communicates via MCP Streamable HTTP (JSON-RPC 2.0 over SSE).
 * Episodes are processed asynchronously by Graphiti's LLM pipeline;
 * the real server-side UUID is discovered by polling getEpisodes().
 *
 * store() returns immediately; fragmentId resolves once Graphiti finishes
 * processing and the UUID becomes visible in get_episodes.
 */

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type {
  MemoryBackend,
  SearchResult,
  StoreResult,
  ConversationTurn,
  BackendDataset,
} from "../backend.js";

// ============================================================================
// Types (Graphiti-specific)
// ============================================================================

type GraphitiEpisode = {
  uuid: string;
  name: string;
  content: string;
  source_description: string;
  group_id: string;
  created_at: string;
};

type GraphitiNode = {
  uuid: string;
  name: string;
  summary: string | null;
  group_id: string;
  labels: string[];
  created_at: string | null;
  attributes: Record<string, unknown>;
};

type GraphitiFact = {
  uuid: string;
  fact: string;
  name?: string;
  source_node_name?: string;
  target_node_name?: string;
  group_id: string;
  created_at: string;
  [key: string]: unknown;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ============================================================================
// GraphitiBackend
// ============================================================================

export type GraphitiConfig = {
  endpoint: string;
  defaultGroupId: string;
  uuidPollIntervalMs: number;
  uuidPollMaxAttempts: number;
};

export class GraphitiBackend implements MemoryBackend {
  readonly name = "graphiti";

  private nextId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  readonly uuidPollIntervalMs: number;
  readonly uuidPollMaxAttempts: number;

  constructor(private readonly config: GraphitiConfig) {
    this.uuidPollIntervalMs = config.uuidPollIntervalMs;
    this.uuidPollMaxAttempts = config.uuidPollMaxAttempts;
  }

  private get mcpUrl(): string {
    return `${this.config.endpoint}/mcp`;
  }

  // --------------------------------------------------------------------------
  // MCP Session Lifecycle
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.sessionId) return;
    if (!this.initPromise) this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "openclaw-memory-rebac", version: "1.0.0" },
      },
    };

    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      this.initPromise = null;
      throw new Error(`Graphiti MCP init failed: ${response.status}`);
    }
    this.sessionId = response.headers.get("mcp-session-id");
    await this.parseSseResponse(response);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    await fetch(this.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  // --------------------------------------------------------------------------
  // Transport
  // --------------------------------------------------------------------------

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureInitialized();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.mcpUrl, { method: "POST", headers, body: JSON.stringify(request) });
    if (!response.ok) throw new Error(`Graphiti MCP error: ${response.status}`);
    const json = await this.parseResponse(response);
    if (json.error) throw new Error(`Graphiti tool ${name} failed: ${json.error.message}`);
    return json.result;
  }

  private async parseResponse(response: Response): Promise<JsonRpcResponse> {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) return this.parseSseResponse(response);
    return (await response.json()) as JsonRpcResponse;
  }

  private async parseSseResponse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) return JSON.parse(data) as JsonRpcResponse;
      }
    }
    throw new Error("No JSON-RPC message in SSE response");
  }

  private parseToolResult<T>(result: unknown, key: string): T {
    const parsed = this.parseJsonResult<Record<string, unknown>>(result);
    if (parsed && typeof parsed === "object" && key in parsed) return parsed[key] as T;
    return [] as unknown as T;
  }

  private parseJsonResult<T>(result: unknown): T {
    if (typeof result === "string") return JSON.parse(result) as T;
    if (result && typeof result === "object" && "content" in result) {
      const content = (result as Record<string, unknown>).content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0] as Record<string, unknown>;
        if (first.type === "text" && typeof first.text === "string") return JSON.parse(first.text) as T;
      }
    }
    return result as T;
  }

  // --------------------------------------------------------------------------
  // MemoryBackend implementation
  // --------------------------------------------------------------------------

  async store(params: {
    content: string;
    groupId: string;
    sourceDescription?: string;
    customPrompt?: string;
  }): Promise<StoreResult> {
    const episodeName = `memory_${randomUUID()}`;
    let effectiveBody = params.content;
    if (params.customPrompt) {
      effectiveBody = `[Extraction Instructions]\n${params.customPrompt}\n[End Instructions]\n\n${params.content}`;
    }

    const args: Record<string, unknown> = {
      name: episodeName,
      episode_body: effectiveBody,
      group_id: params.groupId,
    };
    if (params.sourceDescription) args.source_description = params.sourceDescription;

    await this.callTool("add_memory", args);

    // Graphiti queues the episode for async processing and returns no UUID.
    // Poll getEpisodes until the episode appears, then return its real UUID.
    const fragmentId = this.resolveEpisodeUuid(episodeName, params.groupId);
    fragmentId.catch(() => {}); // Prevent unhandled rejection if caller drops it

    return { fragmentId };
  }

  private async resolveEpisodeUuid(name: string, groupId: string): Promise<string> {
    for (let i = 0; i < this.uuidPollMaxAttempts; i++) {
      await new Promise((r) => setTimeout(r, this.uuidPollIntervalMs));
      try {
        const episodes = await this.getEpisodes(groupId, 50);
        const match = episodes.find((ep) => ep.name === name);
        if (match) return match.uuid;
      } catch {
        // Transient error — keep polling
      }
    }
    throw new Error(`Timed out resolving episode UUID for "${name}" in group "${groupId}"`);
  }

  async searchGroup(params: {
    query: string;
    groupId: string;
    limit: number;
    sessionId?: string;
  }): Promise<SearchResult[]> {
    const { query, groupId, limit } = params;
    const [nodes, facts] = await Promise.allSettled([
      this.searchNodes({ query, group_id: groupId, limit }),
      this.searchFacts({ query, group_id: groupId, limit }),
    ]);

    const results: SearchResult[] = [];

    if (nodes.status === "fulfilled") {
      for (const n of nodes.value) {
        results.push({
          type: "node",
          uuid: n.uuid,
          group_id: n.group_id,
          summary: n.summary ?? n.name,
          context: n.name,
          created_at: n.created_at ?? new Date().toISOString(),
        });
      }
    }

    if (facts.status === "fulfilled") {
      for (const f of facts.value) {
        const src = f.source_node_name ?? "?";
        const tgt = f.target_node_name ?? "?";
        const context = f.name ? `${src} -[${f.name}]→ ${tgt}` : `${src} → ${tgt}`;
        results.push({
          type: "fact",
          uuid: f.uuid,
          group_id: f.group_id,
          summary: f.fact,
          context,
          created_at: f.created_at,
        });
      }
    }

    return results;
  }

  // enrichSession is not needed — addEpisode already captures the conversation
  // and Graphiti builds temporal edges natively. No override needed.

  async getConversationHistory(sessionId: string, lastN = 10): Promise<ConversationTurn[]> {
    // Map Graphiti episodes to the common ConversationTurn shape
    const sessionGroup = `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    try {
      const episodes = await this.getEpisodes(sessionGroup, lastN);
      return episodes.map((ep) => ({
        query: ep.name,
        answer: ep.content,
        created_at: ep.created_at,
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return {
      backend: "graphiti",
      endpoint: this.config.endpoint,
      healthy: await this.healthCheck(),
    };
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.callTool("clear_graph", { group_ids: [groupId] });
  }

  async listGroups(): Promise<BackendDataset[]> {
    // Graphiti has no list-groups API; the CLI can query SpiceDB for this
    return [];
  }

  async deleteFragment(uuid: string): Promise<boolean> {
    await this.callTool("delete_entity_edge", { uuid });
    return true;
  }

  // --------------------------------------------------------------------------
  // Graphiti-specific helpers (used by CLI commands)
  // --------------------------------------------------------------------------

  async getEpisodes(groupId: string, lastN: number): Promise<GraphitiEpisode[]> {
    const result = await this.callTool("get_episodes", { group_ids: [groupId], max_episodes: lastN });
    return this.parseToolResult<GraphitiEpisode[]>(result, "episodes");
  }

  async getEntityEdge(uuid: string): Promise<GraphitiFact> {
    const result = await this.callTool("get_entity_edge", { uuid });
    return this.parseJsonResult<GraphitiFact>(result);
  }

  // --------------------------------------------------------------------------
  // Backend-specific CLI commands
  // --------------------------------------------------------------------------

  registerCliCommands(cmd: Command): void {
    cmd
      .command("episodes")
      .description("[graphiti] List recent episodes for a group")
      .option("--last <n>", "Number of episodes", "10")
      .option("--group <id>", "Group ID")
      .action(async (opts: { last: string; group?: string }) => {
        const groupId = opts.group ?? this.config.defaultGroupId;
        const episodes = await this.getEpisodes(groupId, parseInt(opts.last));
        console.log(JSON.stringify(episodes, null, 2));
      });

    cmd
      .command("fact")
      .description("[graphiti] Get a specific fact (entity edge) by UUID")
      .argument("<uuid>", "Fact UUID")
      .action(async (uuid: string) => {
        try {
          const fact = await this.getEntityEdge(uuid);
          console.log(JSON.stringify(fact, null, 2));
        } catch (err) {
          console.error(`Failed to get fact: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    cmd
      .command("clear-graph")
      .description("[graphiti] Clear graph data for a group (destructive!)")
      .option("--group <id...>", "Group ID(s)")
      .option("--confirm", "Required safety flag", false)
      .action(async (opts: { group?: string[]; confirm: boolean }) => {
        if (!opts.confirm) {
          console.log("Destructive operation. Pass --confirm to proceed.");
          return;
        }
        await this.callTool("clear_graph", opts.group ? { group_ids: opts.group } : {});
        console.log("Graph cleared.");
      });
  }

  // --------------------------------------------------------------------------
  // Raw client methods (used directly in Graphiti search)
  // --------------------------------------------------------------------------

  private async searchNodes(params: { query: string; group_id: string; limit: number }): Promise<GraphitiNode[]> {
    const result = await this.callTool("search_nodes", {
      query: params.query,
      group_ids: [params.group_id],
      max_nodes: params.limit,
    });
    return this.parseToolResult<GraphitiNode[]>(result, "nodes");
  }

  private async searchFacts(params: { query: string; group_id: string; limit: number }): Promise<GraphitiFact[]> {
    const result = await this.callTool("search_memory_facts", {
      query: params.query,
      group_ids: [params.group_id],
      max_facts: params.limit,
    });
    return this.parseToolResult<GraphitiFact[]>(result, "facts");
  }
}
