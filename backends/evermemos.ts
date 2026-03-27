/**
 * EverMemOSBackend — MemoryBackend implementation backed by the EverMemOS FastAPI REST server.
 *
 * EverMemOS communicates via standard HTTP REST endpoints on port 1995.
 * Messages are processed through the MemCell pipeline: boundary detection →
 * parallel LLM extraction of episodic memories, foresight, event logs, and profiles.
 *
 * store() returns immediately with a generated message_id as the fragment anchor.
 * With @timeout_to_background(), store may return 202 Accepted for background processing.
 *
 * discoverFragmentIds() polls a custom trace overlay endpoint to resolve the message_id
 * to actual MongoDB ObjectIds of derived memories. These ObjectIds are what search
 * results return, enabling fragment-level SpiceDB authorization (involves, share).
 *
 * resolveAnchors() provides lazy resolution at recall time: if discoverFragmentIds()
 * timed out during store, unresolved anchors can be resolved later when someone
 * actually tries to recall the involved fragments.
 */

import { randomUUID } from "node:crypto";
import { request as undiciRequest } from "undici";
import type { Command } from "commander";
import type {
  MemoryBackend,
  SearchResult,
  StoreResult,
  ConversationTurn,
  BackendDataset,
} from "../backend.js";

// ============================================================================
// Types (EverMemOS REST API)
// ============================================================================

type EverMemOSMemoryType = "episodic_memory" | "profile" | "foresight" | "event_log";

type StoreMemoryRequest = {
  message_id: string;
  create_time: string;
  sender: string;
  content: string;
  group_id?: string;
  group_name?: string;
  sender_name?: string;
  role?: string;
  refer_list?: string[];
};

type EverMemOSMemory = {
  id: string;
  memory_type: string;
  group_id?: string;
  user_id?: string;
  timestamp?: string;
  created_at?: string;
  subject?: string;
  summary?: string;
  episode?: string;
  foresight?: string;
  evidence?: string;
  participants?: string[];
  score?: number;
  metadata?: Record<string, unknown>;
};

type SearchMemoryResponse = {
  status: string;
  message: string;
  result: {
    memories: Array<Record<string, EverMemOSMemory[]>>;
    scores?: Array<Record<string, number[]>>;
  };
};

type FetchMemoryResponse = {
  memories: EverMemOSMemory[];
};

type ConversationMeta = {
  group_id: string;
  user_details?: Record<string, unknown>;
  [key: string]: unknown;
};

// ============================================================================
// EverMemOSBackend
// ============================================================================

export type EverMemOSConfig = {
  endpoint: string;
  defaultGroupId: string;
  requestTimeoutMs: number;
  retrieveMethod: string;
  memoryTypes: string[];
  defaultSenderId: string;
  discoveryPollIntervalMs: number;
  discoveryTimeoutMs: number;
};

/**
 * Map EverMemOS memory types to the SearchResult type union.
 *
 * episodic_memory → "chunk"  (narrative text chunks)
 * profile         → "summary" (distilled user characteristics)
 * foresight       → "summary" (future-oriented predictions)
 * event_log       → "fact"    (discrete factual events)
 */
function mapMemoryType(memoryType: string): SearchResult["type"] {
  switch (memoryType) {
    case "episodic_memory": return "chunk";
    case "event_log": return "fact";
    case "profile":
    case "foresight":
      return "summary";
    default: return "chunk";
  }
}

/**
 * Build a context prefix from the EverMemOS memory type.
 * This allows downstream consumers to distinguish memory kinds.
 */
function contextPrefix(memoryType: string): string {
  switch (memoryType) {
    case "episodic_memory": return "episode";
    case "profile": return "profile";
    case "foresight": return "foresight";
    case "event_log": return "event";
    default: return memoryType;
  }
}

/**
 * Extract the primary content from an EverMemOS memory based on its type.
 * Each memory type stores its content in a different field.
 */
function extractContent(m: EverMemOSMemory): string {
  switch (m.memory_type) {
    case "episodic_memory": return m.episode ?? m.summary ?? "";
    case "foresight": return m.foresight ?? "";
    case "event_log": return m.summary ?? "";
    case "profile": return m.summary ?? "";
    default: return m.summary ?? m.episode ?? "";
  }
}

/** Response from the trace overlay endpoint. */
type TraceResponse = {
  message_id: string;
  status: "complete" | "processing" | "not_found";
  memcell_ids: string[];
  derived_memories: Record<string, string[]>;
  all_ids: string[];
};

export class EverMemOSBackend implements MemoryBackend {
  readonly name = "evermemos";

  private readonly requestTimeoutMs: number;

  /**
   * Tracks pending stores: messageId → groupId.
   * Populated by store(), consumed by discoverFragmentIds().
   */
  private readonly pendingStores = new Map<string, { groupId: string }>();

  constructor(private readonly config: EverMemOSConfig) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  // --------------------------------------------------------------------------
  // REST transport
  // --------------------------------------------------------------------------

  private async restCall<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.config.endpoint}${path}`;
    if (queryParams) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    // Node.js fetch rejects body on GET requests (per spec). EverMemOS's
    // search endpoint is GET-only with a JSON request body, so we use
    // undici.request which permits body on any method.
    if (method === "GET" && body !== undefined) {
      const res = await undiciRequest(url, {
        method: "GET",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text().catch(() => "");
        throw new Error(`EverMemOS REST ${method} ${path} failed: ${res.statusCode} ${text}`);
      }
      const ct = res.headers["content-type"] ?? "";
      if (ct.includes("application/json")) {
        return (await res.body.json()) as T;
      }
      return {} as T;
    }

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
      throw new Error(`EverMemOS REST ${method} ${path} failed: ${response.status} ${text}`);
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
    const messageId = randomUUID();

    const request: StoreMemoryRequest = {
      message_id: messageId,
      create_time: new Date().toISOString(),
      sender: this.config.defaultSenderId,
      content: params.content,
      group_id: params.groupId,
      role: "user",
      refer_list: [],
    };

    await this.restCall<unknown>("POST", "/api/v1/memories", request);

    // EverMemOS processes messages asynchronously through its MemCell pipeline.
    // customPrompt is ignored — EverMemOS handles extraction internally.
    //
    // We return our generated message_id as the fragment anchor for SpiceDB.
    // discoverFragmentIds() will resolve this to actual MongoDB ObjectIds via
    // the trace overlay endpoint, enabling fragment-level involves/share.
    this.pendingStores.set(messageId, { groupId: params.groupId });
    return { fragmentId: Promise.resolve(messageId) };
  }

  async searchGroup(params: {
    query: string;
    groupId: string;
    limit: number;
    sessionId?: string;
  }): Promise<SearchResult[]> {
    const { query, groupId, limit } = params;

    const body = {
      query,
      group_id: groupId,
      top_k: limit,
      retrieve_method: this.config.retrieveMethod,
      memory_types: this.config.memoryTypes,
    };

    const response = await this.restCall<SearchMemoryResponse>(
      "GET", "/api/v1/memories/search", body,
    );

    // Response nests memories under group-id keys:
    //   result.memories: [{ "group-a": [mem1, mem2, ...] }]
    //   result.scores:   [{ "group-a": [0.95, 0.87, ...] }]
    const memoryGroups = response.result?.memories ?? [];
    const scoreGroups = response.result?.scores ?? [];

    const flat: { mem: EverMemOSMemory; score: number }[] = [];
    for (let gi = 0; gi < memoryGroups.length; gi++) {
      const groupObj = memoryGroups[gi];
      const scoreObj = scoreGroups[gi] ?? {};
      for (const [gid, mems] of Object.entries(groupObj)) {
        const scores = scoreObj[gid] ?? [];
        for (let mi = 0; mi < mems.length; mi++) {
          flat.push({ mem: mems[mi], score: scores[mi] ?? 0 });
        }
      }
    }

    return flat.map(({ mem: m, score }, index) => ({
      type: mapMemoryType(m.memory_type),
      uuid: m.id,
      group_id: m.group_id ?? groupId,
      summary: extractContent(m),
      context: `${contextPrefix(m.memory_type)}: ${m.subject ?? ""}`.trim(),
      created_at: m.timestamp ?? m.created_at ?? "",
      score: score || 1.0 - index / Math.max(flat.length, 1),
    }));
  }

  // searchGroups intentionally not implemented — search.ts fan-out handles multi-group.
  // EverMemOS has no native cross-group ranking.

  async enrichSession(params: {
    sessionId: string;
    groupId: string;
    userMsg: string;
    assistantMsg: string;
  }): Promise<void> {
    const meta: ConversationMeta = {
      group_id: params.groupId,
      user_details: {
        [this.config.defaultSenderId]: {
          role: "user",
          last_message: params.userMsg.slice(0, 200),
        },
      },
    };

    try {
      await this.restCall<unknown>(
        "POST", "/api/v1/memories/conversation-meta", meta,
      );
    } catch {
      // Best-effort — conversation metadata enrichment is non-critical
    }
  }

  async getConversationHistory(sessionId: string, lastN = 10): Promise<ConversationTurn[]> {
    const sessionGroup = `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

    try {
      const queryParams: Record<string, string> = {
        group_id: sessionGroup,
        memory_type: "episodic_memory",
        user_id: this.config.defaultSenderId,
        top_k: String(lastN),
      };

      const response = await this.restCall<FetchMemoryResponse>(
        "GET", "/api/v1/memories", undefined, queryParams,
      );
      const memories = response.memories ?? [];

      return memories.map((m) => ({
        query: "",
        answer: m.episode ?? m.summary ?? "",
        created_at: m.created_at,
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.config.endpoint}/health`,
        { signal: AbortSignal.timeout(5000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return {
      backend: "evermemos",
      endpoint: this.config.endpoint,
      retrieveMethod: this.config.retrieveMethod,
      memoryTypes: this.config.memoryTypes,
      healthy: await this.healthCheck(),
    };
  }

  async deleteGroup(groupId: string): Promise<void> {
    // LIMITATION: EverMemOS DELETE only soft-deletes MemCells. Derived memories
    // (episodic, foresight, event_log) remain searchable. See:
    // https://github.com/EverMind-AI/EverMemOS/issues/148
    await this.restCall<unknown>("DELETE", "/api/v1/memories", {
      event_id: "__all__",
      user_id: "__all__",
      group_id: groupId,
    });
  }

  async listGroups(): Promise<BackendDataset[]> {
    // EverMemOS has no list-groups API
    return [];
  }

  async deleteFragment(uuid: string, _type?: string): Promise<boolean> {
    // LIMITATION: EverMemOS DELETE only soft-deletes MemCells, not derived memories.
    // The uuid from search results is a derived memory _id (episodic/foresight/event_log),
    // not a MemCell _id, so the API will return "not found" for most fragment deletes.
    // See: https://github.com/EverMind-AI/EverMemOS/issues/148
    try {
      await this.restCall<unknown>("DELETE", "/api/v1/memories", {
        event_id: uuid,
        user_id: "__all__",
        group_id: "__all__",
      });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Fragment discovery via trace overlay
  // --------------------------------------------------------------------------

  /**
   * Poll the trace overlay endpoint to discover MongoDB ObjectIds of derived
   * memories (episodic, foresight, event_log) produced from a stored message.
   *
   * Called by index.ts after store() resolves the fragmentId Promise.
   * Returns ObjectIds that match what search results return, enabling
   * fragment-level SpiceDB authorization (involves, share/unshare).
   */
  async discoverFragmentIds(messageId: string): Promise<string[]> {
    const pending = this.pendingStores.get(messageId);
    if (!pending) return [];
    this.pendingStores.delete(messageId);

    const pollInterval = this.config.discoveryPollIntervalMs ?? 3000;
    const timeout = this.config.discoveryTimeoutMs ?? 120000;
    const maxAttempts = Math.ceil(timeout / pollInterval);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      try {
        const trace = await this.restCall<TraceResponse>(
          "GET",
          `/api/v1/memories/trace/${encodeURIComponent(messageId)}`,
        );

        if (trace.status === "not_found") return [];
        if (trace.status === "complete" && trace.all_ids.length > 0) {
          return trace.all_ids;
        }
        // status === "processing" → keep polling
      } catch {
        // Trace endpoint may not be available (older image) — keep trying
      }
    }

    return []; // Timeout — fallback writes the messageId anchor to SpiceDB
  }

  /**
   * Lazy resolution: resolve unmatched SpiceDB anchor UUIDs to actual
   * searchable fragment IDs. Called during recall when viewable fragment IDs
   * from SpiceDB don't match any search results.
   */
  async resolveAnchors(anchorIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const anchor of anchorIds) {
      try {
        const trace = await this.restCall<TraceResponse>(
          "GET",
          `/api/v1/memories/trace/${encodeURIComponent(anchor)}`,
        );
        if (trace.status === "complete" && trace.all_ids.length > 0) {
          result.set(anchor, trace.all_ids);
        }
      } catch {
        // anchor may not be a message_id (e.g. already an ObjectId) — skip
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Backend-specific CLI commands
  // --------------------------------------------------------------------------

  registerCliCommands(cmd: Command): void {
    cmd
      .command("foresight")
      .description("[evermemos] List foresight entries for a group")
      .option("--group <id>", "Group ID")
      .option("--last <n>", "Number of results", "10")
      .action(async (opts: { group?: string; last: string }) => {
        const groupId = opts.group ?? this.config.defaultGroupId;
        try {
          const body = {
            query: "",
            group_id: groupId,
            top_k: Number(opts.last),
            retrieve_method: "keyword",
            memory_types: ["foresight"],
          };
          const response = await this.restCall<SearchMemoryResponse>(
            "GET", "/api/v1/memories/search", body,
          );
          // Flatten group-keyed response
          const flat = (response.result?.memories ?? [])
            .flatMap((g) => Object.values(g).flat());
          console.log(JSON.stringify(flat, null, 2));
        } catch (err) {
          console.error(`Failed to fetch foresight: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    cmd
      .command("conversation-meta")
      .description("[evermemos] View conversation metadata for a group")
      .option("--group <id>", "Group ID")
      .action(async (opts: { group?: string }) => {
        const groupId = opts.group ?? this.config.defaultGroupId;
        try {
          const queryParams: Record<string, string> = { group_id: groupId };
          const response = await this.restCall<ConversationMeta>(
            "GET", "/api/v1/memories/conversation-meta", undefined, queryParams,
          );
          console.log(JSON.stringify(response, null, 2));
        } catch (err) {
          console.error(`Failed to fetch conversation metadata: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    cmd
      .command("clear-memories")
      .description("[evermemos] Clear all memories for a group")
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

import everMemOSDefaults from "./evermemos.defaults.json" with { type: "json" };

export const defaults: Record<string, unknown> = everMemOSDefaults;

export function create(config: Record<string, unknown>): MemoryBackend {
  return new EverMemOSBackend(config as EverMemOSConfig);
}
