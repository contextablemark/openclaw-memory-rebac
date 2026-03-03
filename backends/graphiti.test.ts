import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:crypto")>();
  return { ...mod, randomUUID: vi.fn(() => "test-uuid-000") };
});

import { GraphitiBackend } from "./graphiti.js";
import type { GraphitiConfig } from "./graphiti.js";

const defaultConfig: GraphitiConfig = {
  endpoint: "http://localhost:8000",
  defaultGroupId: "main",
  uuidPollIntervalMs: 100,
  uuidPollMaxAttempts: 5,
  requestTimeoutMs: 5000,
};

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Helper to create a mock JSON response */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe("GraphitiBackend", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("has correct name", () => {
    const backend = new GraphitiBackend(defaultConfig);
    expect(backend.name).toBe("graphiti");
  });

  describe("store", () => {
    test("returns StoreResult with fragmentId Promise", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      // Mock POST /messages (202 Accepted)
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: "Messages accepted", success: true }, 202),
      );

      // Mock GET /episodes polling (return episode on first poll)
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { uuid: "real-uuid-123", name: "memory_test-uuid-000", group_id: "main", created_at: "2026-03-01" },
        ]),
      );

      const result = await backend.store({
        content: "Test memory",
        groupId: "main",
      });

      expect(result.fragmentId).toBeInstanceOf(Promise);
      const uuid = await result.fragmentId;
      expect(uuid).toBe("real-uuid-123");

      // Verify POST /messages was called
      const storeCall = mockFetch.mock.calls[0];
      expect(storeCall[0]).toBe("http://localhost:8000/messages");
      const body = JSON.parse(storeCall[1].body as string);
      expect(body.group_id).toBe("main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe("Test memory");
      expect(body.messages[0].uuid).toBeUndefined();
      expect(body.messages[0].name).toBe("memory_test-uuid-000");
      expect(body.messages[0].timestamp).toBeDefined();
    });

    test("passes customPrompt in message content with instructions wrapper", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      // Mock POST /messages
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: "Accepted", success: true }, 202),
      );

      await backend.store({
        content: "Important fact",
        groupId: "main",
        customPrompt: "Extract only names",
      });

      const storeCall = mockFetch.mock.calls[0];
      const body = JSON.parse(storeCall[1].body as string);
      expect(body.messages[0].content).toContain("[Extraction Instructions]");
      expect(body.messages[0].content).toContain("Extract only names");
      expect(body.messages[0].content).toContain("[End Instructions]");
      expect(body.messages[0].content).toContain("Important fact");
    });
  });

  describe("searchGroup", () => {
    test("calls POST /search and returns facts as SearchResult[]", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          facts: [
            {
              uuid: "f1",
              name: "WORKS_AT",
              fact: "Mark works at Acme",
              valid_at: null,
              invalid_at: null,
              created_at: "2026-01-16",
              expired_at: null,
            },
          ],
        }),
      );

      const results = await backend.searchGroup({
        query: "Mark work",
        groupId: "g1",
        limit: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: "fact",
        uuid: "f1",
        group_id: "g1",
        summary: "Mark works at Acme",
        context: "WORKS_AT",
        created_at: "2026-01-16",
      });

      // Verify POST /search was called with correct body
      const searchCall = mockFetch.mock.calls[0];
      expect(searchCall[0]).toBe("http://localhost:8000/search");
      const body = JSON.parse(searchCall[1].body as string);
      expect(body.group_ids).toEqual(["g1"]);
      expect(body.query).toBe("Mark work");
      expect(body.max_facts).toBe(10);
    });

    test("returns empty array when no facts found", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ facts: [] }));

      const results = await backend.searchGroup({
        query: "nothing",
        groupId: "g1",
        limit: 10,
      });

      expect(results).toEqual([]);
    });
  });

  describe("healthCheck", () => {
    test("returns true when /healthcheck responds ok", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/healthcheck",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test("returns false when /healthcheck fails", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: false });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });

    test("returns false when /healthcheck throws", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe("getStatus", () => {
    test("returns status object with backend name and healthy flag", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const status = await backend.getStatus();
      expect(status.backend).toBe("graphiti");
      expect(status.endpoint).toBe("http://localhost:8000");
      expect(status.healthy).toBe(true);
    });

    test("reports unhealthy when health check fails", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Down"));

      const status = await backend.getStatus();
      expect(status.healthy).toBe(false);
    });
  });

  describe("deleteFragment", () => {
    test("calls DELETE /episode/{uuid}", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: "Deleted", success: true }),
      );

      const result = await backend.deleteFragment?.("episode-uuid-123");
      expect(result).toBe(true);

      const deleteCall = mockFetch.mock.calls[0];
      expect(deleteCall[0]).toBe("http://localhost:8000/episode/episode-uuid-123");
      expect(deleteCall[1].method).toBe("DELETE");
    });
  });

  describe("deleteGroup", () => {
    test("calls DELETE /group/{groupId}", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: "Cleared", success: true }),
      );

      await backend.deleteGroup("old-group");

      const deleteCall = mockFetch.mock.calls[0];
      expect(deleteCall[0]).toBe("http://localhost:8000/group/old-group");
      expect(deleteCall[1].method).toBe("DELETE");
    });
  });

  describe("listGroups", () => {
    test("returns empty array (not implemented)", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      const groups = await backend.listGroups();
      expect(groups).toEqual([]);
    });
  });

  describe("getConversationHistory", () => {
    test("maps getEpisodes to ConversationTurn[]", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { uuid: "e1", name: "Turn 1", content: "User: Hi\nAssistant: Hello", created_at: "2026-01-15" },
          { uuid: "e2", name: "Turn 2", content: "User: Bye\nAssistant: Goodbye", created_at: "2026-01-16" },
        ]),
      );

      const turns = await backend.getConversationHistory("session-123", 10);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        query: "Turn 1",
        answer: "User: Hi\nAssistant: Hello",
        created_at: "2026-01-15",
      });

      // Verify GET /episodes/session-session-123 was called
      const episodesCall = mockFetch.mock.calls[0];
      expect(episodesCall[0]).toBe("http://localhost:8000/episodes/session-session-123?last_n=10");
      expect(episodesCall[1].method).toBe("GET");
    });

    test("returns empty array on error", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Fail"));

      const turns = await backend.getConversationHistory("session-123");
      expect(turns).toEqual([]);
    });
  });
});
