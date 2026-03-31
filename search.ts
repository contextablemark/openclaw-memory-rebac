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

// ============================================================================
// Liminal context formatting (hybrid mode — EverMemOS auto-recall)
// ============================================================================

/** Maximum characters per individual memory content before truncation. */
const MAX_LIMINAL_CONTENT_CHARS = 2000;

/** Memory type sections in display order, keyed by context prefix. */
const LIMINAL_SECTIONS: { prefix: string; tag: string }[] = [
  { prefix: "episode", tag: "episodic" },
  { prefix: "profile", tag: "profile" },
  { prefix: "foresight", tag: "foresight" },
  { prefix: "event", tag: "event" },
];

/**
 * Format a timestamp string into a compact label: "YYYY-MM-DD HH:MM".
 * Returns empty string if the timestamp is missing or unparseable.
 */
function timestampLabel(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Truncate text to MAX_LIMINAL_CONTENT_CHARS, appending "…" if truncated.
 */
function capContent(text: string): string {
  if (text.length <= MAX_LIMINAL_CONTENT_CHARS) return text;
  return text.slice(0, MAX_LIMINAL_CONTENT_CHARS) + "…";
}

/**
 * Extract the context prefix from a SearchResult (e.g. "episode" from "episode: Team update").
 */
function contextPrefixOf(r: SearchResult): string {
  const colon = r.context.indexOf(":");
  return colon > 0 ? r.context.slice(0, colon).trim() : r.context.trim();
}

/**
 * Extract the subject from a SearchResult context (after the prefix colon).
 */
function contextSubject(r: SearchResult): string {
  const colon = r.context.indexOf(":");
  return colon > 0 ? r.context.slice(colon + 1).trim() : "";
}

/**
 * Format liminal (EverMemOS) search results into structured <memory> XML.
 *
 * Filters by minimum score, caps content length, and groups results by
 * memory type into XML sections. Designed to minimise context window usage
 * while preserving signal.
 *
 * @param results - Search results from the liminal backend
 * @param minScore - Minimum relevance score to include (default 0.1)
 * @returns Formatted XML string, or empty string if no results pass filtering
 */
export function formatLiminalContext(
  results: SearchResult[],
  minScore = 0.3,
): string {
  if (results.length === 0) return "";

  // Normalize scores to 0–1 relative to the batch maximum.
  // Raw reranker scores vary wildly across models (e.g. Qwen3-Reranker-4B
  // produces 0.0001–0.01). Normalising makes the threshold reranker-agnostic:
  // top result = 1.0, others proportional, threshold = "% of best match".
  const maxScore = Math.max(...results.map((r) => r.score ?? 0), Number.MIN_VALUE);
  const normalized = results.map((r) => ({
    ...r,
    score: (r.score ?? 0) / maxScore,
  }));

  const filtered = normalized.filter((r) => r.score >= minScore);
  if (filtered.length === 0) return "";

  // Group results by context prefix
  const groups = new Map<string, SearchResult[]>();
  for (const r of filtered) {
    const prefix = contextPrefixOf(r);
    const group = groups.get(prefix) ?? [];
    group.push(r);
    groups.set(prefix, group);
  }

  const lines: string[] = ["<memory>"];

  for (const { prefix, tag } of LIMINAL_SECTIONS) {
    const group = groups.get(prefix);
    if (!group?.length) continue;

    lines.push(`  <${tag}>`);
    for (const r of group) {
      const ts = timestampLabel(r.created_at);
      const subject = contextSubject(r);
      const content = capContent(r.summary);
      const label = subject ? `${subject}: ${content}` : content;
      lines.push(ts ? `    - [${ts}] ${label}` : `    - ${label}`);
    }
    lines.push(`  </${tag}>`);
  }

  // Any types not in LIMINAL_SECTIONS (future-proofing)
  for (const [prefix, group] of groups) {
    if (LIMINAL_SECTIONS.some((s) => s.prefix === prefix)) continue;
    lines.push(`  <${prefix}>`);
    for (const r of group) {
      const content = capContent(r.summary);
      lines.push(`    - ${content}`);
    }
    lines.push(`  </${prefix}>`);
  }

  lines.push("</memory>");
  return lines.join("\n");
}

// ============================================================================
// Context stripping (prevent memory echo in auto-capture)
// ============================================================================

/**
 * Strip previously-injected memory context from text before capture.
 * Removes <memory>...</memory> and <recent-context>...</recent-context> blocks.
 */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/<memory>[\s\S]*?<\/memory>/g, "")
    .replace(/<recent-context>[\s\S]*?<\/recent-context>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
