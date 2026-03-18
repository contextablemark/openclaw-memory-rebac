/**
 * MemoryBackend interface
 *
 * All storage-engine specifics live here. The rest of the plugin
 * (SpiceDB auth, search orchestration, tool registration, CLI skeleton)
 * is backend-agnostic and never imports from backends/.
 *
 * Implementing a new backend means satisfying this interface and adding
 * an entry to the factory in config.ts. That's it.
 */

import type { Command } from "commander";

// ============================================================================
// Shared result types (returned by all backends in a uniform shape)
// ============================================================================

/**
 * A single memory item returned by searchGroup().
 * Backends are responsible for mapping their native result shape to this.
 */
export type SearchResult = {
  /** "node"/"fact" for graph backends; "chunk"/"summary"/"completion" for doc backends */
  type: "node" | "fact" | "chunk" | "summary" | "completion";
  /** Stable ID used by memory_forget. Must be unique within the backend. */
  uuid: string;
  group_id: string;
  summary: string;
  /** Human-readable context hint (entity names, dataset, etc.) */
  context: string;
  created_at: string;
  /** Relevance score [0,1] when available */
  score?: number;
};

/**
 * Returned by store(). The fragmentId resolves to the UUID that will be
 * registered in SpiceDB.
 *
 * - Graphiti: Resolves once the server has processed the episode (polled in the background).
 *
 * index.ts chains SpiceDB writeFragmentRelationships() to this Promise,
 * so it always fires at the right time.
 */
export type StoreResult = {
  fragmentId: Promise<string>;
};

/**
 * A single conversation turn, used for episodic recall.
 * Backends that don't support conversation history return [].
 */
export type ConversationTurn = {
  query: string;
  answer: string;
  context?: string;
  created_at?: string;
};

/**
 * Minimal dataset descriptor for the CLI `datasets` command.
 */
export type BackendDataset = {
  name: string;
  /** Group ID this dataset maps to (backend-specific derivation) */
  groupId: string;
  /** Optional backend-specific dataset ID */
  id?: string;
};

// ============================================================================
// MemoryBackend interface
// ============================================================================

export interface MemoryBackend {
  /** Human-readable backend name for logs and status output */
  readonly name: string;

  // --------------------------------------------------------------------------
  // Core write
  // Backends MUST return immediately — graph/index construction is async.
  // --------------------------------------------------------------------------

  /**
   * Ingest content into the group's storage partition.
   * The returned StoreResult.fragmentId resolves when the backend has
   * produced a stable UUID suitable for SpiceDB registration.
   */
  store(params: {
    content: string;
    groupId: string;
    sourceDescription?: string;
    customPrompt?: string;
  }): Promise<StoreResult>;

  // --------------------------------------------------------------------------
  // Core read
  // --------------------------------------------------------------------------

  /**
   * Search within a single group's storage partition.
   * Called in parallel per-group by searchAuthorizedMemories() in search.ts.
   * Backends map their native result shape to SearchResult[].
   */
  searchGroup(params: {
    query: string;
    groupId: string;
    limit: number;
    sessionId?: string;
  }): Promise<SearchResult[]>;

  // --------------------------------------------------------------------------
  // Session / episodic memory
  // --------------------------------------------------------------------------

  /**
   * Optional backend-specific session enrichment, called from agent_end
   * after store() for conversation auto-capture.
   *
   * Graphiti: no-op (addEpisode already handles episodic memory).
   */
  enrichSession?(params: {
    sessionId: string;
    groupId: string;
    userMsg: string;
    assistantMsg: string;
  }): Promise<void>;

  /**
   * Retrieve conversation history for a session.
   * Graphiti maps getEpisodes() to this shape.
   * Backends that don't support it return [].
   */
  getConversationHistory(sessionId: string, lastN?: number): Promise<ConversationTurn[]>;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  healthCheck(): Promise<boolean>;
  getStatus(): Promise<Record<string, unknown>>;

  // --------------------------------------------------------------------------
  // Management
  // --------------------------------------------------------------------------

  /**
   * Delete a group's entire storage partition.
   * Used by `rebac-mem clear-group --confirm`.
   */
  deleteGroup(groupId: string): Promise<void>;

  /**
   * List all storage partitions (datasets/groups) managed by this backend.
   */
  listGroups(): Promise<BackendDataset[]>;

  /**
   * Delete a single memory fragment by UUID.
   * Optional: not all backends support sub-dataset deletion.
   * Returns true if deleted, false if the backend doesn't support it.
   */
  deleteFragment?(uuid: string, type?: string): Promise<boolean>;

  /**
   * Fetch fragment details by their IDs.
   * Used for fragment-level recall (e.g., finding memories via `involves` permissions).
   * Optional: not all backends support fetching individual fragments by ID.
   */
  getFragmentsByIds?(ids: string[]): Promise<SearchResult[]>;

  /**
   * Discover fragment (fact/edge) UUIDs that were extracted from a stored episode.
   * Called after store() resolves the episode ID to write per-fragment SpiceDB
   * relationships with the correct fact-level UUIDs.
   * Optional: not all backends separate episodes from fragments.
   */
  discoverFragmentIds?(episodeId: string): Promise<string[]>;

  // --------------------------------------------------------------------------
  // CLI extension point
  // --------------------------------------------------------------------------

  /**
   * Register backend-specific CLI subcommands onto the shared `rebac-mem` command.
   * Called once during CLI setup. Backend may register any commands it needs.
   *
   * Example: Graphiti registers episodes, fact, clear-graph
   */
  registerCliCommands?(cmd: Command): void;
}
