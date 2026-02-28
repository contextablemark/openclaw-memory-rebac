import { describe, test, expect, vi } from "vitest";
import {
  searchAuthorizedMemories,
  formatResultsForContext,
  formatDualResults,
  deduplicateSessionResults,
  type SearchResult,
} from "./search.js";
import type { MemoryBackend } from "./backend.js";

function mockBackend(overrides?: Partial<MemoryBackend>): MemoryBackend {
  return {
    name: "mock",
    store: vi.fn().mockResolvedValue({ fragmentId: Promise.resolve("uuid-1") }),
    searchGroup: vi.fn().mockResolvedValue([]),
    getConversationHistory: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({ backend: "mock", healthy: true }),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as MemoryBackend;
}

describe("searchAuthorizedMemories", () => {
  test("returns empty array when no groupIds provided", async () => {
    const backend = mockBackend();
    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: [],
    });
    expect(results).toEqual([]);
  });

  test("searches each authorized group in parallel", async () => {
    const searchGroup = vi.fn().mockResolvedValue([
      {
        type: "chunk",
        uuid: "c1",
        group_id: "family",
        summary: "Mark is a developer",
        context: "group:family",
        created_at: "2026-01-15T00:00:00Z",
      },
    ]);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "Mark work",
      groupIds: ["family", "work"],
    });

    expect(searchGroup).toHaveBeenCalledTimes(2);
    expect(searchGroup).toHaveBeenCalledWith({
      query: "Mark work",
      groupId: "family",
      limit: 10,
      sessionId: undefined,
    });
    expect(searchGroup).toHaveBeenCalledWith({
      query: "Mark work",
      groupId: "work",
      limit: 10,
      sessionId: undefined,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("deduplicates results by UUID across groups", async () => {
    const chunk = {
      type: "chunk" as const,
      uuid: "c1",
      group_id: "g1",
      summary: "Mark is a developer",
      context: "group:g1",
      created_at: "2026-01-15T00:00:00Z",
    };
    const searchGroup = vi.fn().mockResolvedValue([chunk]);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "Mark",
      groupIds: ["g1", "g2", "g3"],
    });

    // Same UUID from 3 groups → deduplicated to 1
    expect(results).toHaveLength(1);
    expect(results[0].uuid).toBe("c1");
  });

  test("sorts by score descending when scores available", async () => {
    const searchGroup = vi.fn()
      .mockResolvedValueOnce([
        {
          type: "chunk",
          uuid: "low",
          group_id: "g1",
          summary: "Low score",
          context: "g1",
          created_at: "2026-01-15T00:00:00Z",
          score: 0.3,
        },
      ])
      .mockResolvedValueOnce([
        {
          type: "chunk",
          uuid: "high",
          group_id: "g2",
          summary: "High score",
          context: "g2",
          created_at: "2026-01-15T00:00:00Z",
          score: 0.9,
        },
      ]);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1", "g2"],
    });

    expect(results[0].uuid).toBe("high");
    expect(results[1].uuid).toBe("low");
  });

  test("sorts by recency when scores equal or missing", async () => {
    const searchGroup = vi.fn()
      .mockResolvedValueOnce([
        {
          type: "chunk",
          uuid: "old",
          group_id: "g1",
          summary: "Old chunk",
          context: "g1",
          created_at: "2025-01-01T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          type: "chunk",
          uuid: "new",
          group_id: "g2",
          summary: "New chunk",
          context: "g2",
          created_at: "2026-02-01T00:00:00Z",
        },
      ]);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1", "g2"],
    });

    expect(results[0].uuid).toBe("new");
    expect(results[1].uuid).toBe("old");
  });

  test("respects limit parameter", async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      type: "chunk" as const,
      uuid: `c${i}`,
      group_id: "g1",
      summary: `Chunk ${i}`,
      context: "g1",
      created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const searchGroup = vi.fn().mockResolvedValue(chunks);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1"],
      limit: 5,
    });

    expect(results).toHaveLength(5);
  });

  test("handles partial failures gracefully", async () => {
    const searchGroup = vi.fn()
      .mockResolvedValueOnce([
        {
          type: "chunk",
          uuid: "c1",
          group_id: "g1",
          summary: "Working result",
          context: "g1",
          created_at: "2026-01-15T00:00:00Z",
        },
      ])
      .mockRejectedValueOnce(new Error("Network error"));
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1", "g2"],
    });

    // Should still return results from the successful group
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("c1");
  });

  test("forwards sessionId to backend.searchGroup()", async () => {
    const searchGroup = vi.fn().mockResolvedValue([]);
    const backend = mockBackend({ searchGroup });

    await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1"],
      sessionId: "session-abc",
    });

    expect(searchGroup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-abc" }),
    );
  });

  test("works with mixed result types (node, fact, chunk, summary, completion)", async () => {
    const searchGroup = vi.fn().mockResolvedValue([
      { type: "node", uuid: "n1", group_id: "g1", summary: "Mark", context: "Mark", created_at: "2026-01-15T00:00:00Z" },
      { type: "fact", uuid: "f1", group_id: "g1", summary: "Mark → Promoted", context: "Mark -[promoted]→ Role", created_at: "2026-01-16T00:00:00Z" },
      { type: "chunk", uuid: "c1", group_id: "g1", summary: "Documentation chunk", context: "docs", created_at: "2026-01-17T00:00:00Z" },
      { type: "summary", uuid: "s1", group_id: "g1", summary: "Summary text", context: "summary", created_at: "2026-01-18T00:00:00Z" },
      { type: "completion", uuid: "comp1", group_id: "g1", summary: "Generated answer", context: "completion", created_at: "2026-01-19T00:00:00Z" },
    ]);
    const backend = mockBackend({ searchGroup });

    const results = await searchAuthorizedMemories(backend, {
      query: "test",
      groupIds: ["g1"],
    });

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.type)).toEqual(["completion", "summary", "chunk", "fact", "node"]);
  });
});

describe("formatResultsForContext", () => {
  test("returns empty string for no results", () => {
    expect(formatResultsForContext([])).toBe("");
  });

  test("formats nodes as [entity:uuid]", () => {
    const results: SearchResult[] = [
      { type: "node", uuid: "n1", group_id: "g1", summary: "Mark is a developer", context: "Mark", created_at: "2026-01-15" },
    ];
    const formatted = formatResultsForContext(results);
    expect(formatted).toContain("1. [entity:n1] Mark is a developer (Mark)");
  });

  test("formats facts as [fact:uuid]", () => {
    const results: SearchResult[] = [
      { type: "fact", uuid: "f1", group_id: "g1", summary: "Mark got promoted", context: "Mark → Promotion", created_at: "2026-01-16" },
    ];
    const formatted = formatResultsForContext(results);
    expect(formatted).toContain("1. [fact:f1] Mark got promoted (Mark → Promotion)");
  });

  test("formats chunks as [chunk:uuid]", () => {
    const results: SearchResult[] = [
      { type: "chunk", uuid: "c1", group_id: "g1", summary: "Documentation text", context: "docs", created_at: "2026-01-15" },
    ];
    const formatted = formatResultsForContext(results);
    expect(formatted).toContain("1. [chunk:c1] Documentation text (docs)");
  });

  test("formats summaries as [summary:uuid]", () => {
    const results: SearchResult[] = [
      { type: "summary", uuid: "s1", group_id: "g1", summary: "Summary text", context: "summary", created_at: "2026-01-15" },
    ];
    const formatted = formatResultsForContext(results);
    expect(formatted).toContain("1. [summary:s1] Summary text (summary)");
  });

  test("formats completions as [completion:uuid]", () => {
    const results: SearchResult[] = [
      { type: "completion", uuid: "comp1", group_id: "g1", summary: "Generated answer", context: "completion", created_at: "2026-01-15" },
    ];
    const formatted = formatResultsForContext(results);
    expect(formatted).toContain("1. [completion:comp1] Generated answer (completion)");
  });
});

describe("formatDualResults", () => {
  test("formats long-term results only", () => {
    const longTerm: SearchResult[] = [
      { type: "chunk", uuid: "c1", group_id: "main", summary: "Mark is a developer", context: "main", created_at: "2026-01-15" },
    ];
    const formatted = formatDualResults(longTerm, []);
    expect(formatted).toContain("1. [chunk:c1] Mark is a developer (main)");
    expect(formatted).not.toContain("Session memories:");
  });

  test("formats session results only", () => {
    const session: SearchResult[] = [
      { type: "fact", uuid: "f1", group_id: "session-s1", summary: "Deadline tomorrow", context: "Mark → Deadline", created_at: "2026-01-16" },
    ];
    const formatted = formatDualResults([], session);
    expect(formatted).toContain("1. [fact:f1] Deadline tomorrow");
    expect(formatted).not.toContain("Session memories:");
  });

  test("formats both long-term and session with section header", () => {
    const longTerm: SearchResult[] = [
      { type: "node", uuid: "n1", group_id: "main", summary: "Mark is a developer", context: "Mark", created_at: "2026-01-15" },
    ];
    const session: SearchResult[] = [
      { type: "fact", uuid: "f1", group_id: "session-s1", summary: "Deadline tomorrow", context: "Mark → Deadline", created_at: "2026-02-01" },
    ];
    const formatted = formatDualResults(longTerm, session);
    expect(formatted).toContain("1. [entity:n1] Mark is a developer");
    expect(formatted).toContain("Session memories:");
    expect(formatted).toContain("2. [fact:f1] Deadline tomorrow");
  });

  test("returns empty string when both are empty", () => {
    expect(formatDualResults([], [])).toBe("");
  });
});

describe("deduplicateSessionResults", () => {
  test("removes session results that exist in long-term", () => {
    const longTerm: SearchResult[] = [
      { type: "chunk", uuid: "c1", group_id: "main", summary: "Fact about Mark", context: "main", created_at: "2026-01-15" },
    ];
    const session: SearchResult[] = [
      { type: "chunk", uuid: "c1", group_id: "session-s1", summary: "Fact about Mark", context: "session", created_at: "2026-01-15" },
      { type: "chunk", uuid: "c2", group_id: "session-s1", summary: "New fact", context: "session", created_at: "2026-01-16" },
    ];
    const deduped = deduplicateSessionResults(longTerm, session);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].uuid).toBe("c2");
  });

  test("returns all session results when no overlap", () => {
    const longTerm: SearchResult[] = [
      { type: "chunk", uuid: "c1", group_id: "main", summary: "Mark", context: "main", created_at: "2026-01-15" },
    ];
    const session: SearchResult[] = [
      { type: "chunk", uuid: "c2", group_id: "session-s1", summary: "Jane", context: "session", created_at: "2026-01-15" },
    ];
    const deduped = deduplicateSessionResults(longTerm, session);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].uuid).toBe("c2");
  });

  test("handles empty inputs", () => {
    expect(deduplicateSessionResults([], [])).toEqual([]);
    expect(deduplicateSessionResults([], [
      { type: "chunk", uuid: "c1", group_id: "session-s1", summary: "X", context: "X", created_at: "2026-01-01" },
    ])).toHaveLength(1);
  });
});
