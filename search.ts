/**
 * Multi-Group Search with backend-native relevance ranking.
 *
 * Prefers MemoryBackend.searchGroups() — a single call with all group_ids
 * so the backend applies cross-group relevance ranking (e.g. Graphiti RRF).
 * Falls back to per-group fan-out via searchGroup() when unavailable.
 */

import type { MemoryBackend, SearchResult } from "./backend.js";

export type { SearchResult };

// ============================================================================
// Search options
// ============================================================================

export type SearchOptions = {
  query: string;
  groupIds: string[];
  limit?: number;
  sessionId?: string;
};

// ============================================================================
// Search
// ============================================================================

/**
 * Search across multiple authorized group_ids.
 *
 * Prefers backend.searchGroups() when available — sends all group_ids in a
 * single call so the backend can apply cross-group relevance ranking
 * (e.g. Graphiti's RRF: cosine similarity + BM25).
 *
 * Falls back to per-group fan-out via backend.searchGroup() when the backend
 * doesn't implement multi-group search.
 */
export async function searchAuthorizedMemories(
  backend: MemoryBackend,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { query, groupIds, limit = 10, sessionId } = options;

  if (groupIds.length === 0) {
    return [];
  }

  // Prefer single multi-group search — preserves backend relevance ranking
  if (backend.searchGroups) {
    const results = await backend.searchGroups({ query, groupIds, limit, sessionId });
    // Deduplicate by UUID (defensive — single call shouldn't produce dupes)
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.uuid)) return false;
      seen.add(r.uuid);
      return true;
    }).slice(0, limit);
  }

  // Fallback: fan out parallel searches across all authorized groups
  const promises = groupIds.map((groupId) =>
    backend.searchGroup({ query, groupId, limit, sessionId }),
  );

  const resultSets = await Promise.allSettled(promises);

  // Collect all successful results — silently skip failed group searches
  const allResults: SearchResult[] = [];
  for (const result of resultSets) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
  }

  // Deduplicate by UUID
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    if (seen.has(r.uuid)) return false;
    seen.add(r.uuid);
    return true;
  });

  // Sort: score descending (when available), then recency descending
  deduped.sort((a, b) => {
    if (a.score !== undefined && b.score !== undefined && a.score !== b.score) {
      return b.score - a.score;
    }
    const dateA = new Date(a.created_at).getTime();
    const dateB = new Date(b.created_at).getTime();
    return dateB - dateA;
  });

  return deduped.slice(0, limit);
}

// ============================================================================
// Format for agent context
// ============================================================================

/**
 * Format search results into a text block for injecting into agent context.
 */
export function formatResultsForContext(results: SearchResult[]): string {
  if (results.length === 0) return "";
  return results.map((r, i) => formatResultLine(r, i + 1)).join("\n");
}

/**
 * Format results with long-term and session sections separated.
 * Session group_ids start with "session-".
 */
export function formatDualResults(
  longTermResults: SearchResult[],
  sessionResults: SearchResult[],
): string {
  const parts: string[] = [];
  let idx = 1;

  for (const r of longTermResults) {
    parts.push(formatResultLine(r, idx++));
  }

  if (sessionResults.length > 0) {
    if (longTermResults.length > 0) parts.push("Session memories:");
    for (const r of sessionResults) {
      parts.push(formatResultLine(r, idx++));
    }
  }

  return parts.join("\n");
}

/**
 * Format a single search result line with type-prefixed UUID.
 * e.g. "[fact:da8650cb-...] Eric's birthday is Dec 17th (Eric -[HAS_BIRTHDAY]→ Dec 17th)"
 */
function formatResultLine(r: SearchResult, idx: number): string {
  const typeLabel =
    r.type === "node" ? "entity" :
    r.type === "fact" ? "fact" :
    r.type === "chunk" ? "chunk" :
    r.type === "summary" ? "summary" :
    "completion";
  return `${idx}. [${typeLabel}:${r.uuid}] ${r.summary} (${r.context})`;
}
