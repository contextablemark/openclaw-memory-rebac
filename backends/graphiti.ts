/**
 * GraphitiBackend — MemoryBackend implementation backed by the Graphiti FastAPI REST server.
 *
 * Graphiti communicates via standard HTTP REST endpoints.
 * Episodes are processed asynchronously by Graphiti's LLM pipeline;
 * the real server-side UUID is discovered by polling GET /episodes/{group_id}.
 *
 * store() returns immediately; fragmentId resolves once Graphiti finishes
 * processing and the UUID becomes visible in the episodes list.
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
// Types (Graphiti REST API)
// ============================================================================

/** Matches the server's Message schema (from /openapi.json). */
type GraphitiMessage = {
  content: string;
  role_type: "user" | "assistant" | "system";
  role: string | null;
  name?: string;
  timestamp?: string;
  source_description?: string;
};

type AddMessagesRequest = {
  group_id: string;
  messages: GraphitiMessage[];
};

type GraphitiEpisode = {
  uuid: string;
  name: string;
  content: string;
  source_description: string;
  group_id: string;
  created_at: string;
};

type FactResult = {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
};

type SearchRequest = {
  group_ids: string[];
  query: string;
  max_facts?: number;
};

type SearchResults = {
  facts: FactResult[];
};

type GraphitiResult = {
  message: string;
  success: boolean;
};

// ============================================================================
// GraphitiBackend
// ============================================================================

export type GraphitiConfig = {
  endpoint: string;
  defaultGroupId: string;
  uuidPollIntervalMs: number;
  uuidPollMaxAttempts: number;
  requestTimeoutMs?: number;
  customInstructions: string;
};

export class GraphitiBackend implements MemoryBackend {
  readonly name = "graphiti";

  readonly uuidPollIntervalMs: number;
  readonly uuidPollMaxAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: GraphitiConfig) {
    this.uuidPollIntervalMs = config.uuidPollIntervalMs;
    this.uuidPollMaxAttempts = config.uuidPollMaxAttempts;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  // --------------------------------------------------------------------------
  // REST transport
  // --------------------------------------------------------------------------

  private async restCall<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.endpoint}${path}`;
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const response = await fetch(url, opts);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Graphiti REST ${method} ${path} failed: ${response.status} ${text}`);
    }
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await response.json()) as T;
    }
    return {} as T;
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

    const request: AddMessagesRequest = {
      group_id: params.groupId,
      messages: [
        {
          name: episodeName,
          content: effectiveBody,
          timestamp: new Date().toISOString(),
          role_type: "user",
          role: "user",
          source_description: params.sourceDescription,
        },
      ],
    };

    await this.restCall<GraphitiResult>("POST", "/messages", request);

    // POST /messages returns 202 (async processing).
    // Poll GET /episodes until the episode appears, then return its real UUID.
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

    const searchRequest: SearchRequest = {
      group_ids: [groupId],
      query,
      max_facts: limit,
    };

    const response = await this.restCall<SearchResults>("POST", "/search", searchRequest);
    const facts = response.facts ?? [];

    return facts.map((f) => ({
      type: "fact" as const,
      uuid: f.uuid,
      group_id: groupId,
      summary: f.fact,
      context: f.name,
      created_at: f.created_at,
    }));
  }

  async getConversationHistory(sessionId: string, lastN = 10): Promise<ConversationTurn[]> {
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
      const response = await fetch(`${this.config.endpoint}/healthcheck`, {
        signal: AbortSignal.timeout(5000),
      });
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
    await this.restCall<GraphitiResult>(
      "DELETE",
      `/group/${encodeURIComponent(groupId)}`,
    );
  }

  async listGroups(): Promise<BackendDataset[]> {
    // Graphiti has no list-groups API; the CLI can query SpiceDB for this
    return [];
  }

  async deleteFragment(uuid: string, type?: string): Promise<boolean> {
    const path = type === "fact"
      ? `/entity-edge/${encodeURIComponent(uuid)}`
      : `/episode/${encodeURIComponent(uuid)}`;
    await this.restCall<GraphitiResult>("DELETE", path);
    return true;
  }

  // --------------------------------------------------------------------------
  // Graphiti-specific helpers (used by CLI commands and UUID polling)
  // --------------------------------------------------------------------------

  async getEpisodes(groupId: string, lastN: number): Promise<GraphitiEpisode[]> {
    return this.restCall<GraphitiEpisode[]>(
      "GET",
      `/episodes/${encodeURIComponent(groupId)}?last_n=${lastN}`,
    );
  }

  async discoverFragmentIds(episodeId: string): Promise<string[]> {
    const edges = await this.restCall<Array<{ uuid: string }>>(
      "GET",
      `/episodes/${encodeURIComponent(episodeId)}/edges`,
    );
    return edges.map((e) => e.uuid);
  }

  async getEntityEdge(uuid: string): Promise<FactResult> {
    return this.restCall<FactResult>(
      "GET",
      `/entity-edge/${encodeURIComponent(uuid)}`,
    );
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
        const groups = opts.group ?? [];
        if (groups.length === 0) {
          console.log("No groups specified. Use --group <id> to specify groups.");
          return;
        }
        for (const g of groups) {
          await this.deleteGroup(g);
          console.log(`Cleared group: ${g}`);
        }
      });
  }
}

// ============================================================================
// Backend module exports (used by backends/registry.ts)
// ============================================================================

import graphitiDefaults from "./graphiti.defaults.json" with { type: "json" };

export const defaults: Record<string, unknown> = graphitiDefaults;

export function create(config: Record<string, unknown>): MemoryBackend {
  return new GraphitiBackend(config as GraphitiConfig);
}
